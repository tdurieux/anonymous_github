package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
)

func TestSharedHTTPContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/shared-http.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Store, Accept, Method, Vary string
		Size                        int
		Expected                    struct {
			Status, BodyBytes                            int
			Encoding, Length, Vary, Ranges, SHA256, Wire string
		}
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/test-shared-http-cache.cjs", root)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	stores := map[string]*blobcache.Cache{}
	for _, mode := range []string{"identity", "gzip"} {
		cache, err := blobcache.New(t.Context(), blobcache.Options{Root: filepath.Join(root, mode), Budget: 65536, MaxObject: 4096})
		if err != nil {
			t.Fatal(err)
		}
		stores[mode] = cache
		t.Cleanup(func() { cache.Close() })
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index, _ := strconv.Atoi(r.Header.Get("X-Fixture"))
		fixture := fixtures[index]
		compressed := &compressionWriter{ResponseWriter: w, request: r}
		w = compressed
		defer compressed.finish()
		w.Header().Set("Content-Type", "application/octet-stream")
		if fixture.Vary != "" {
			w.Header().Set("Vary", fixture.Vary)
		}
		sharedVary(w.Header())
		response := &sharedResponse{accept: r.Header.Get("Accept-Encoding"), eligible: true, head: r.Method == "HEAD"}
		response.encoding = sharedEncoding(response.accept, "gzip", "identity")
		if response.encoding == "" {
			if r.Method != "HEAD" {
				w.Header().Set("Content-Length", "0")
			}
			w.WriteHeader(406)
			return
		}
		body, err := stores[fixture.Store].Lookup(r.Context(), "payload-"+strconv.Itoa(fixture.Size))
		if err != nil || body == nil {
			t.Error(body, err)
			http.Error(w, "cache unavailable", 500)
			return
		}
		defer body.Close()
		if _, err := sendSharedBlob(r.Context(), w, body, response); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	transport := &http.Transport{DisableCompression: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	for i, fixture := range fixtures {
		t.Run(strconv.Itoa(i)+"-"+fixture.Store+"-"+fixture.Accept+"-"+fixture.Method, func(t *testing.T) {
			req, _ := http.NewRequest(fixture.Method, server.URL+"/api/repo/fixture/file/body", nil)
			req.Header.Set("X-Fixture", strconv.Itoa(i))
			if fixture.Accept != "" {
				req.Header.Set("Accept-Encoding", fixture.Accept)
			}
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			wire, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			e := fixture.Expected
			if response.StatusCode != e.Status || response.Header.Get("Content-Encoding") != e.Encoding || response.Header.Get("Content-Length") != e.Length || response.Header.Get("Vary") != e.Vary || response.Header.Get("Accept-Ranges") != e.Ranges {
				t.Fatalf("got %d %v; want %+v", response.StatusCode, response.Header, e)
			}
			if e.Wire != "" && base64.StdEncoding.EncodeToString(wire) != e.Wire {
				t.Fatal("stored gzip was recompressed")
			}
			decoded := wire
			if len(wire) > 0 && e.Encoding == "gzip" {
				reader, err := gzip.NewReader(bytes.NewReader(wire))
				if err != nil {
					t.Fatal(err)
				}
				decoded, err = io.ReadAll(reader)
				reader.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			sum := sha256.Sum256(decoded)
			if len(decoded) != e.BodyBytes || hex.EncodeToString(sum[:]) != e.SHA256 {
				t.Fatal("wrong response bytes", len(decoded), e)
			}
		})
	}
	server.Close()
	for name, store := range stores {
		stats, err := store.Stats(t.Context())
		if err != nil || stats.ActiveReaders != 0 {
			t.Fatal("HTTP readers leaked", name, stats, err)
		}
	}
}
