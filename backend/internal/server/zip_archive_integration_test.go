package server

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func archiveTestGitSHA(body string) string {
	digest := sha1.New()
	fmt.Fprintf(digest, "blob %d\x00%s", len(body), body)
	return hex.EncodeToString(digest.Sum(nil))
}

func runArchiveZIPIntegration(t *testing.T, s *Server) {
	if os.Getenv("GO_TEST_SERVER_BINARY") == "" {
		t.Skip("worker binary required")
	}
	ctx := t.Context()
	original, err := s.Store.one(ctx, "anonymizedrepositories", M{"repoId": "fixture"})
	if err != nil || original == nil {
		t.Fatal("fixture required", err)
	}
	originalHTTP := s.HTTP
	defer func() { s.HTTP = originalHTTP }()
	for _, mode := range []string{"stream", "cancel", "checksum", "revocation", "duplicate", "collision", "export exceptions"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("TMPDIR", dir)
			repo := M{}
			for k, v := range original {
				repo[k] = v
			}
			repo["_id"] = bson.NewObjectID()
			repo["repoId"] = "archive-" + bson.NewObjectID().Hex()
			if _, err := s.Store.DB.Collection("anonymizedrepositories").InsertOne(ctx, repo); err != nil {
				t.Fatal(err)
			}
			defer s.Store.DB.Collection("anonymizedrepositories").DeleteOne(ctx, M{"_id": repo["_id"]})
			defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": repo["repoId"]})
			bodies := []string{"first Alice", "second Alice"}
			names := []string{"0.txt", "1.txt"}
			if mode == "collision" {
				names = []string{"Alice.txt", "XXXX-1.txt"}
			}
			for i, body := range bodies {
				if _, err := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": repo["repoId"], "treeGeneration": activeGeneration(repo), "path": "", "name": names[i], "size": len(body), "sha": archiveTestGitSHA(body)}); err != nil {
					t.Fatal(err)
				}
			}
			release := make(chan struct{})
			var releaseOnce sync.Once
			unlock := func() { releaseOnce.Do(func() { close(release) }) }
			defer unlock()
			var archiveCalls, blobCalls atomic.Int64
			upstreamFinished := make(chan struct{})
			s.HTTP = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
				if strings.Contains(req.URL.Path, "/tarball/") {
					archiveCalls.Add(1)
					if mode == "checksum" || mode == "duplicate" || mode == "collision" || mode == "export exceptions" {
						data := tarTestBytes(t, tarTestEntry{name: "root/" + names[0], body: bodies[0]}, tarTestEntry{name: "root/" + names[1], body: bodies[1]})
						if mode == "checksum" {
							data[len(data)-8] ^= 1
						} else if mode == "duplicate" {
							data = tarTestBytes(t, tarTestEntry{name: "root/0.txt", body: bodies[0]}, tarTestEntry{name: "root/0.txt", body: bodies[0]})
						} else if mode == "export exceptions" {
							data = tarTestBytes(t, tarTestEntry{name: "root/0.txt", body: "export-substituted"})
						}
						close(upstreamFinished)
						return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(data))}, nil
					}
					reader, writer := io.Pipe()
					go func() {
						defer close(upstreamFinished)
						defer writer.Close()
						gz := gzip.NewWriter(writer)
						tw := tar.NewWriter(gz)
						for i, body := range bodies {
							if i == 1 {
								select {
								case <-release:
								case <-req.Context().Done():
									return
								}
							}
							if err := tw.WriteHeader(&tar.Header{Name: fmt.Sprintf("root/%d.txt", i), Mode: 0600, Size: int64(len(body))}); err != nil {
								return
							}
							if _, err := io.WriteString(tw, body); err != nil {
								return
							}
							if err := gz.Flush(); err != nil {
								return
							}
						}
						tw.Close()
						gz.Close()
					}()
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: reader}, nil
				}
				if strings.Contains(req.URL.Path, "/git/blobs/") {
					blobCalls.Add(1)
					for _, body := range bodies {
						if strings.HasSuffix(req.URL.Path, archiveTestGitSHA(body)) {
							return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body))}, nil
						}
					}
				}
				return originalHTTP.Transport.RoundTrip(req)
			})}
			done := make(chan struct{})
			httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { defer close(done); s.ServeHTTP(w, r) }))
			defer httpServer.Close()
			requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(requestCtx, "GET", httpServer.URL+"/api/repo/"+str(repo["repoId"])+"/zip", nil)
			response, err := http.DefaultClient.Do(req)
			if (mode == "checksum" || mode == "duplicate" || mode == "collision") && err != nil { // Corruption may be detected before first entry is released.
				<-done
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				if response.StatusCode != 200 {
					body, _ := io.ReadAll(response.Body)
					t.Fatal(response.StatusCode, string(body))
				}
				prefix := make([]byte, 30+len("0.txt")+1)
				_, err = io.ReadFull(response.Body, prefix)
				if err != nil && mode != "checksum" && mode != "duplicate" && mode != "collision" {
					t.Fatal("no early payload", err)
				}
				if mode == "stream" || mode == "cancel" || mode == "revocation" {
					select {
					case <-upstreamFinished:
						t.Fatal("upstream completed before client received first entry")
					default:
					}
				}
				if mode == "cancel" {
					cancel()
					response.Body.Close()
				} else {
					if mode == "revocation" {
						if _, err := s.Store.DB.Collection("anonymizedrepositories").UpdateOne(ctx, M{"_id": repo["_id"]}, M{"$set": M{"contentCacheRevision": "revoked"}}); err != nil {
							t.Fatal(err)
						}
					}
					unlock()
					rest, readErr := io.ReadAll(response.Body)
					data := append(prefix, rest...)
					if mode == "checksum" || mode == "duplicate" || mode == "collision" || mode == "revocation" {
						if readErr == nil {
							t.Fatal("invalidated archive completed")
						}
						if _, err := zip.NewReader(bytes.NewReader(data), int64(len(data))); err == nil {
							t.Fatal("invalidated archive finalized")
						}
					} else {
						if readErr != nil {
							t.Fatal(readErr)
						}
						archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
						if err != nil {
							t.Fatal(err)
						}
						if len(archive.File) != 2 {
							t.Fatal("incomplete ZIP", len(archive.File))
						}
						for i, entry := range archive.File {
							reader, err := entry.Open()
							if err != nil {
								t.Fatal(err)
							}
							body, err := io.ReadAll(reader)
							reader.Close()
							if err != nil || entry.Name != fmt.Sprintf("%d.txt", i) || string(body) != strings.ReplaceAll(bodies[i], "Alice", "XXXX-1") {
								t.Fatal("wrong ZIP output", entry.Name, string(body), err)
							}
						}
					}
				}
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("pipeline did not stop")
				}
			}
			select {
			case <-upstreamFinished:
			case <-time.After(time.Second):
				t.Fatal("upstream survived cancellation")
			}
			if archiveCalls.Load() != 1 {
				t.Fatal("archive request count", archiveCalls.Load())
			}
			if mode == "export exceptions" {
				if blobCalls.Load() != 2 {
					t.Fatal("exceptional blobs were not recovered", blobCalls.Load())
				}
			} else if blobCalls.Load() != 0 {
				t.Fatal("stream fetched individual blobs", blobCalls.Load())
			}
			leftovers, _ := filepath.Glob(filepath.Join(dir, "anonymous-go-*"))
			if len(leftovers) != 0 {
				t.Fatal("temporary files leaked", leftovers)
			}
		})
	}
}
