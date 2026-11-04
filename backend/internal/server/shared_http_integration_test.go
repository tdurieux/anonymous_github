package server

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
)

func runSharedHTTPIntegration(t *testing.T, s *Server, p *fixtureProvider) {
	t.Run("shared HTTP representations", func(t *testing.T) {
		ctx := t.Context()
		source, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096, Gzip: true})
		if err != nil {
			t.Fatal(err)
		}
		results, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096, Gzip: true})
		if err != nil {
			source.Close()
			t.Fatal(err)
		}
		oldSource, oldResults, oldOpen := s.sourceCache, s.resultCache, p.onOpen
		oldEnabled := s.Config.SharedCacheEnabled
		s.Config.SharedCacheEnabled = true
		payload := strings.Repeat("Alice hello\n", 180)
		p.onOpen = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(payload)), nil }
		s.sourceCache, s.resultCache = source, results
		defer func() {
			p.onOpen = oldOpen
			s.Config.SharedCacheEnabled = oldEnabled
			p.revoked = false
			s.sourceCache, s.resultCache = oldSource, oldResults
			source.Close()
			results.Close()
		}()
		server := httptest.NewServer(s)
		defer server.Close()
		transport := &http.Transport{DisableCompression: true}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport}
		call := func(method, accept string) (*http.Response, []byte) {
			req, _ := http.NewRequest(method, server.URL+"/api/repo/second-provider/file/XXXX-1.txt", nil)
			req.Header.Set("Accept-Encoding", accept)
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			return response, data
		}
		starts := s.pool.Stats()["workerStarts"].(uint64)
		response, wire := call("GET", "gzip")
		if response.StatusCode != 200 || response.Header.Get("Content-Encoding") != "gzip" || response.Header.Get("Accept-Ranges") != "none" || response.Header.Get("Vary") != "Accept-Encoding" {
			t.Fatal(response.StatusCode, response.Header, string(wire))
		}
		zipped, err := gzip.NewReader(bytes.NewReader(wire))
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := io.ReadAll(zipped)
		zipped.Close()
		if err != nil || strings.Contains(string(decoded), "Alice") || !strings.Contains(string(decoded), "XXXX-1") {
			t.Fatal(string(decoded), err)
		}
		r, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		opt, err := s.anonymizerOptions(r, "repo")
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(payload))
		key, err := s.sharedResultKey(r, M{"path": "", "name": "Alice.txt"}, "sha256-"+hex.EncodeToString(sum[:]), opt)
		if err != nil {
			t.Fatal(err)
		}
		decision, err := results.Decision(ctx, key)
		if err != nil || decision == nil || !decision.Changed {
			t.Fatal("missing changed decision", decision, err)
		}
		encoded, err := results.Open(ctx, decision.Digest, true)
		if err != nil || encoded == nil {
			t.Fatal(encoded, err)
		}
		stored, err := io.ReadAll(encoded)
		encoded.Close()
		if err != nil || !bytes.Equal(stored, wire) {
			t.Fatal("HTTP recompressed the cached result", err)
		}
		if response.Header.Get("Content-Length") != strconv.Itoa(len(stored)) {
			t.Fatal(response.Header, len(stored))
		}
		response, identity := call("GET", "identity")
		if response.StatusCode != 200 || response.Header.Get("Content-Encoding") != "" || !bytes.Equal(identity, decoded) || response.Header.Get("Content-Length") != strconv.Itoa(len(decoded)) {
			t.Fatal(response.StatusCode, response.Header)
		}
		response, head := call("HEAD", "gzip")
		if response.StatusCode != 200 || len(head) != 0 || response.Header.Get("Content-Encoding") != "" || response.Header.Get("Content-Length") != "" {
			t.Fatal(response.StatusCode, response.Header, string(head))
		}
		for _, method := range []string{"GET", "HEAD"} {
			response, body := call(method, "*;q=0")
			wantStatus := 406
			if method == "HEAD" {
				wantStatus = 200
			}
			if response.StatusCode != wantStatus || len(body) != 0 || response.Header.Get("Vary") != "Accept-Encoding" {
				t.Fatal(response.StatusCode, response.Header, string(body))
			}
		}
		if got := s.pool.Stats()["workerStarts"].(uint64); got != starts+1 {
			t.Fatal("warm/HEAD/rejected request launched a worker", got, starts)
		}
		// Website assets use the same encoded result while keeping sandboxing.
		oldOptions := obj(r["options"])
		pageOptions := M{}
		for key, value := range oldOptions {
			pageOptions[key] = value
		}
		pageOptions["page"], pageOptions["pageSource"] = true, M{"branch": obj(r["source"])["branch"], "path": "/"}
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"options": pageOptions}}); err != nil {
			t.Fatal(err)
		}
		defer s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"options": oldOptions}})
		pageReq, _ := http.NewRequest("GET", server.URL+"/w/second-provider/XXXX-1.txt", nil)
		pageReq.Header.Set("Accept-Encoding", "gzip")
		pageResponse, err := client.Do(pageReq)
		if err != nil {
			t.Fatal(err)
		}
		pageWire, err := io.ReadAll(pageResponse.Body)
		pageResponse.Body.Close()
		if err != nil || pageResponse.StatusCode != 200 || pageResponse.Header.Get("Content-Encoding") != "gzip" || !strings.Contains(pageResponse.Header.Get("Content-Security-Policy"), "sandbox") {
			t.Fatal("website encoding", pageResponse.StatusCode, pageResponse.Header, err)
		}
		pageGzip, err := gzip.NewReader(bytes.NewReader(pageWire))
		if err != nil {
			t.Fatal(err)
		}
		pageDecoded, err := io.ReadAll(pageGzip)
		pageGzip.Close()
		if err != nil || !bytes.Equal(pageDecoded, decoded) {
			t.Fatal("website output changed", err)
		}
		server.Close()
		// Authorization must win even when encoding negotiation would reject the
		// request; run after draining network handlers before changing the fixture.
		p.revoked = true
		req := httptest.NewRequest("GET", "/api/repo/second-provider/file/XXXX-1.txt", nil)
		req.Header.Set("Accept-Encoding", "*;q=0")
		denied := httptest.NewRecorder()
		s.ServeHTTP(denied, req)
		if denied.Code != 403 || strings.Contains(denied.Body.String(), "Alice hello") {
			t.Fatal("negotiation bypassed authorization", denied.Code, denied.Body)
		}
		for _, method := range []string{"GET", "HEAD"} {
			pageReq := httptest.NewRequest(method, "/w/second-provider/XXXX-1.txt", nil)
			denied := httptest.NewRecorder()
			s.ServeHTTP(denied, pageReq)
			if denied.Code != 403 {
				t.Fatal("website revocation", method, denied.Code)
			}
		}
		for _, cache := range []*blobcache.Cache{source, results} {
			stats, err := cache.Stats(ctx)
			if err != nil || stats.ActiveReaders != 0 || stats.ReservedBytes != 0 {
				t.Fatal("HTTP cache leases leaked", stats, err)
			}
		}
	})
}
