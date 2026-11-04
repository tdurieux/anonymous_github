package server

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

func TestCompressionHTTPContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/compression.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Path, Method, Type, Accept, Control, Vary, Preset string
		Size, Status                                            int
		Stream                                                  bool
		Expected                                                struct {
			Status                         int
			Encoding, Vary, Length, SHA256 string
			BodyBytes                      int
		}
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index, _ := strconv.Atoi(r.Header.Get("X-Fixture"))
		c := cases[index]
		compressed := &compressionWriter{ResponseWriter: w, request: r}
		w = compressed
		if c.Type != "" {
			w.Header().Set("Content-Type", c.Type)
		}
		if c.Control != "" {
			w.Header().Set("Cache-Control", c.Control)
		}
		if c.Vary != "" {
			w.Header().Set("Vary", c.Vary)
		}
		if c.Preset != "" {
			w.Header().Set("Content-Encoding", c.Preset)
		}
		if !c.Stream {
			w.Header().Set("Content-Length", strconv.Itoa(c.Size))
		}
		status := c.Status
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		w.Write(bytes.Repeat([]byte("x"), c.Size))
		if err := compressed.finish(); err != nil {
			t.Errorf("finish %s: %v", c.Name, err)
		}
	}))
	defer server.Close()
	transport := &http.Transport{DisableCompression: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	for i, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			request, err := http.NewRequest(c.Method, server.URL+c.Path, nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("X-Fixture", strconv.Itoa(i))
			if c.Accept != "" {
				request.Header.Set("Accept-Encoding", c.Accept)
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			wire, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != c.Expected.Status || response.Header.Get("Content-Encoding") != c.Expected.Encoding || response.Header.Get("Vary") != c.Expected.Vary || response.Header.Get("Content-Length") != c.Expected.Length {
				t.Errorf("headers got status=%d encoding=%q vary=%q length=%q; want %+v", response.StatusCode, response.Header.Get("Content-Encoding"), response.Header.Get("Vary"), response.Header.Get("Content-Length"), c.Expected)
			}
			var reader io.Reader = bytes.NewReader(wire)
			if len(wire) > 0 && (c.Preset == "" || c.Preset == "identity") {
				switch response.Header.Get("Content-Encoding") {
				case "gzip":
					decoded, err := gzip.NewReader(reader)
					if err != nil {
						t.Fatal(err)
					}
					defer decoded.Close()
					reader = decoded
				case "deflate":
					decoded, err := zlib.NewReader(reader)
					if err != nil {
						t.Fatal(err)
					}
					defer decoded.Close()
					reader = decoded
				case "br":
					reader = brotli.NewReader(reader)
				}
			}
			body, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(body)
			if len(body) != c.Expected.BodyBytes || hex.EncodeToString(digest[:]) != c.Expected.SHA256 {
				t.Fatalf("body differs: length %d, error %v", len(body), err)
			}
		})
	}
}
func TestCompressionFlush(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/stream", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	w := &compressionWriter{ResponseWriter: recorder, request: request}
	w.Header().Set("Content-Type", "text/event-stream")
	if _, err := w.Write([]byte("data: first\n\n")); err != nil {
		t.Fatal(err)
	}
	w.Flush()
	if !recorder.Flushed || recorder.Body.Len() == 0 {
		t.Fatal("compressed stream was not flushed")
	}
	if _, err := w.Write([]byte("data: second\n\n")); err != nil {
		t.Fatal(err)
	}
	if err := w.finish(); err != nil {
		t.Fatal(err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(recorder.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil || string(body) != "data: first\n\ndata: second\n\n" {
		t.Fatal(string(body), err)
	}
}
func TestCompressionJSONLength(t *testing.T) {
	for _, size := range []int{10, 2048} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/api/example", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		w := &compressionWriter{ResponseWriter: recorder, request: request}
		writeJSON(w, M{"body": strings.Repeat("x", size)})
		if err := w.finish(); err != nil {
			t.Fatal(err)
		}
		if (recorder.Header().Get("Content-Encoding") == "gzip") != (size >= 1024) {
			t.Fatal("JSON threshold mismatch", size, recorder.Header())
		}
	}
}

func TestServerCompressionPlacement(t *testing.T) {
	root := t.TempDir()
	body := strings.Repeat("body { color: black; }\n", 200)
	if err := os.WriteFile(root+"/fixture.css", []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	public, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer public.Close()
	s := &Server{public: public}
	for _, method := range []string{"GET", "HEAD"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(method, "/fixture.css", nil)
		request.Header.Set("Accept-Encoding", "br, gzip")
		s.ServeHTTP(recorder, request)
		if recorder.Code != 200 || recorder.Header().Get("Vary") != "Accept-Encoding" {
			t.Fatal(recorder.Code, recorder.Header())
		}
		if method == "GET" {
			if recorder.Header().Get("Content-Encoding") != "br" {
				t.Fatal("static response not compressed", recorder.Header())
			}
			decoded, err := io.ReadAll(brotli.NewReader(bytes.NewReader(recorder.Body.Bytes())))
			if err != nil || string(decoded) != body {
				t.Fatal("static output", err)
			}
		} else if recorder.Header().Get("Content-Encoding") != "" || recorder.Body.Len() != 0 {
			t.Fatal("HEAD compressed or emitted body")
		}
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/github/app/webhook", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	s.ServeHTTP(recorder, request)
	if recorder.Code != 401 || recorder.Header().Get("Vary") != "" || recorder.Header().Get("Content-Encoding") != "" {
		t.Fatal("webhook compression placement", recorder.Code, recorder.Header())
	}
}

type compressionBrokenWriter struct{ header http.Header }

func (w *compressionBrokenWriter) Header() http.Header       { return w.header }
func (w *compressionBrokenWriter) WriteHeader(int)           {}
func (w *compressionBrokenWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func TestCompressionFailure(t *testing.T) {
	for _, encoding := range []string{"gzip", "deflate", "br"} {
		request := httptest.NewRequest("GET", "/stream", nil)
		request.Header.Set("Accept-Encoding", encoding)
		broken := &compressionBrokenWriter{header: http.Header{"Content-Type": []string{"text/plain"}}}
		w := &compressionWriter{ResponseWriter: broken, request: request}
		w.Write([]byte(strings.Repeat("x", 2048)))
		if err := w.finish(); !errors.Is(err, io.ErrClosedPipe) {
			t.Fatal("compression hid write failure", encoding, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest("GET", "/stream", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()
	w := &compressionWriter{ResponseWriter: recorder, request: request}
	if _, err := w.Write([]byte("body")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := w.finish(); !errors.Is(err, context.Canceled) || recorder.Body.Len() != 0 {
		t.Fatal("canceled response continued", err)
	}
}

func TestCompressionHTTP2(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		encoded := &compressionWriter{ResponseWriter: w, request: r}
		writeJSON(encoded, M{"body": strings.Repeat("x", 4096)})
		if err := encoded.finish(); err != nil {
			t.Error(err)
		}
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	request, _ := http.NewRequest("GET", server.URL, nil)
	request.Header.Set("Accept-Encoding", "gzip")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.ProtoMajor != 2 || response.Header.Get("Content-Encoding") != "gzip" || response.Header.Get("Transfer-Encoding") != "" {
		t.Fatal(response.Proto, response.Header)
	}
	decoded, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	defer decoded.Close()
	body, err := io.ReadAll(decoded)
	if err != nil || !bytes.Contains(body, []byte(strings.Repeat("x", 4096))) {
		t.Fatal("HTTP/2 output", err)
	}
}

func TestCompressionKnownSmallBodies(t *testing.T) {
	for _, method := range []string{"GET", "HEAD"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(method, "/from", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		w := &compressionWriter{ResponseWriter: recorder, request: request}
		redirectKnownLength(w, request, "/target?x=1&y=2", 302)
		if err := w.finish(); err != nil {
			t.Fatal(err)
		}
		if recorder.Code != 302 || recorder.Header().Get("Content-Encoding") != "" || recorder.Header().Get("Content-Length") == "" || recorder.Header().Get("Location") != "/target?x=1&y=2" {
			t.Fatal(recorder.Code, recorder.Header())
		}
		if method == "HEAD" && recorder.Body.Len() != 0 {
			t.Fatal("HEAD redirect body")
		}
	}
	root := t.TempDir()
	if err := os.WriteFile(root+"/index.html", []byte("<html>small page</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	public, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer public.Close()
	s := &Server{public: public}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	s.ServeHTTP(recorder, request)
	if recorder.Code != 200 || recorder.Header().Get("Content-Encoding") != "" || recorder.Body.String() != "<html>small page</html>" {
		t.Fatal("small SPA response", recorder.Code, recorder.Header())
	}
}
