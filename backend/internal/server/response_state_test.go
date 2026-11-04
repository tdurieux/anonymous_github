package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecoveryBeforeCommit(t *testing.T) {
	for _, earlyHints := range []bool{false, true} {
		s := &Server{}
		s.add("GET", "/fixture", "", func(q *request) (any, error) {
			if earlyHints {
				q.W.WriteHeader(http.StatusEarlyHints)
			}
			for _, name := range []string{"Content-Encoding", "Content-Disposition", "Content-Range", "ETag", "Last-Modified", "Trailer"} {
				q.W.Header().Set(name, "stale")
			}
			q.W.Header().Set("Content-Length", "9999")
			panic("private detail")
		})
		srv := httptest.NewServer(s)
		resp, err := srv.Client().Get(srv.URL + "/fixture")
		if err != nil {
			srv.Close()
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		srv.Close()
		if err != nil || resp.StatusCode != 500 || string(body) != `{"error":"server_error"}` {
			t.Fatalf("hints=%v: status=%d body=%q err=%v", earlyHints, resp.StatusCode, body, err)
		}
		for _, name := range []string{"Content-Encoding", "Content-Disposition", "Content-Range", "Last-Modified", "Trailer"} {
			if resp.Header.Get(name) != "" {
				t.Errorf("stale %s", name)
			}
		}
		if resp.Header.Get("ETag") == "stale" {
			t.Error("stale ETag")
		}
		if s.failures.Load() != 1 {
			t.Error("panic not counted")
		}
	}
}

func TestRecoveryAfterCommitAbortsHTTP(t *testing.T) {
	for _, encoding := range []string{"identity", "gzip"} {
		for _, mode := range []string{"panic", "error", "returned-error", "abort", "flush"} {
			t.Run(encoding+"/"+mode, func(t *testing.T) {
				s := &Server{}
				prefix := strings.Repeat("partial response ", 100)
				s.add("GET", "/fixture", "", func(q *request) (any, error) {
					q.W.Header().Set("Content-Type", "text/plain")
					if mode != "flush" {
						if _, err := io.WriteString(q.W, prefix); err != nil {
							panic(err)
						}
					}
					if err := http.NewResponseController(q.W).Flush(); err != nil {
						panic(err)
					}
					switch mode {
					case "error":
						writeError(q.W, fail("late_error", 500))
					case "returned-error":
						return nil, fail("late_error", 400)
					case "abort":
						panic(http.ErrAbortHandler)
					default:
						panic("private detail")
					}
					return written{}, nil
				})
				srv := httptest.NewServer(s)
				defer srv.Close()
				transport := &http.Transport{DisableCompression: true}
				defer transport.CloseIdleConnections()
				client := &http.Client{Transport: transport}
				req, _ := http.NewRequest("GET", srv.URL+"/fixture", nil)
				req.Header.Set("Accept-Encoding", encoding)
				resp, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				var reader io.Reader = resp.Body
				if encoding == "gzip" {
					gz, err := gzip.NewReader(reader)
					if err != nil {
						t.Fatal(err)
					}
					defer gz.Close()
					reader = gz
				}
				body, err := io.ReadAll(reader)
				if err == nil {
					t.Fatal("truncated response reported success")
				}
				expected := prefix
				if mode == "flush" {
					expected = ""
				}
				if string(body) != expected {
					t.Fatalf("unexpected body: %q", body)
				}
				expectedFailures := uint64(1)
				if mode == "abort" || mode == "error" {
					expectedFailures = 0
				}
				if s.failures.Load() != expectedFailures {
					t.Errorf("failures=%d", s.failures.Load())
				}
			})
		}
	}
}

func TestResponseStateInformationalAndFlush(t *testing.T) {
	recorder := httptest.NewRecorder()
	w := &responseState{ResponseWriter: recorder}
	w.WriteHeader(103)
	if responseCommitted(w) {
		t.Fatal("early hints committed response")
	}
	if err := w.FlushError(); err != nil {
		t.Fatal(err)
	}
	if !responseCommitted(w) {
		t.Fatal("flush did not commit")
	}
	defer func() {
		if recover() != http.ErrAbortHandler {
			t.Error("late error did not abort")
		}
	}()
	writeError(w, fail("late_error", 500))
}
