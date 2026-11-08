package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runSharedSourceIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder) {
	t.Run("shared source cache", func(t *testing.T) {
		cache, err := blobcache.New(t.Context(), blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096, Gzip: true})
		if err != nil {
			t.Fatal(err)
		}
		defer cache.Close()
		s.sourceCache = cache
		defer func() { s.sourceCache = nil; p.onOpen = nil; p.revoked = false }()
		ctx := t.Context()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		r := selectFields(original, "owner", "source", "providerAccess", "options")
		r["_id"], r["repoId"], r["status"] = bson.NewObjectID(), "shared-source-fixture", "ready"
		r["treeGeneration"], r["anonymizeDate"] = "shared-generation", time.Now().Truncate(time.Millisecond)
		if _, err = s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		row := M{"path": "", "name": "Alice.txt", "sha": "blob:one", "size": int64(len(fixtureContent))}
		read := func() (string, error) {
			body, err := s.blob(ctx, r, row)
			if err != nil {
				return "", err
			}
			defer body.Close()
			data, err := io.ReadAll(body)
			return string(data), err
		}
		start := p.openCount.Load()
		for i := 0; i < 2; i++ {
			beforeAuth := p.authorizeCount.Load()
			body, err := read()
			if err != nil || body != fixtureContent {
				t.Fatal(body, err)
			}
			// Cold reads check producer and release. Warm reads authorize
			// at release, after lookup, without exposing bytes beforehand.
			want := int64(2)
			if i == 1 {
				want = 1
			}
			if got := p.authorizeCount.Load() - beforeAuth; got != want {
				t.Fatalf("read %d: authorization calls %d, want %d", i, got, want)
			}
		}
		if p.openCount.Load() != start+1 {
			t.Fatal("warm request downloaded again")
		}
		stats, err := cache.Stats(ctx)
		if err != nil || stats.Blobs != 1 || stats.ActiveReaders != 0 || stats.ReservedBytes != 0 {
			t.Fatal(stats, err)
		}
		p.revoked = true
		if _, err = read(); err == nil || err.Error() != "fixture_access_revoked" {
			t.Fatal("revoked cache hit", err)
		}
		p.revoked = false
		// Distinct opaque revisions cannot collide even when their paths match.
		row["sha"] = "blob:two"
		p.onOpen = func() (io.ReadCloser, error) {
			p.revoked = true
			return io.NopCloser(strings.NewReader(fixtureContent)), nil
		}
		if _, err = read(); err == nil || err.Error() != "fixture_access_revoked" {
			t.Fatal("revocation during fill", err)
		}
		p.revoked = false
		p.onOpen = nil
		if _, err = read(); err != nil {
			t.Fatal(err)
		}
		// A removal while bytes are fetched must reject the completed fill.
		row["sha"] = "blob:three"
		p.onOpen = func() (io.ReadCloser, error) {
			_, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removed"}})
			return io.NopCloser(strings.NewReader(fixtureContent)), err
		}
		if _, err = read(); err == nil || err.Error() != "repository_changed" {
			t.Fatal("stale lifecycle served", err)
		}
		p.onOpen = nil
		// Exercise the public file handler and anonymization with shared source reads.
		before := p.openCount.Load()
		for i := 0; i < 2; i++ {
			w := call("GET", "/api/repo/second-provider/file/XXXX-1.txt", "", nil)
			if w.Code != 200 || strings.Contains(w.Body.String(), "Alice") {
				t.Fatal(w.Code, w.Body)
			}
		}
		if p.openCount.Load() != before+1 {
			t.Fatal("HTTP requests did not share source", p.openCount.Load()-before)
		}
		p.revoked = true
		if w := call("GET", "/api/repo/second-provider/file/XXXX-1.txt", "", nil); w.Code != 403 {
			t.Fatal("HTTP hit bypassed authorization", w.Code, w.Body)
		}
		// Bodyless responses must still reject revoked grants, even with a
		// matching validator that would otherwise return 304.
		for _, method := range []string{"GET", "HEAD"} {
			req := httptest.NewRequest(method, "/api/repo/second-provider/file/XXXX-1.txt", nil)
			req.RemoteAddr = "192.0.2.1:1234"
			req.Header.Set("If-None-Match", "*")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != 403 {
				t.Fatalf("revoked conditional %s: %d", method, w.Code)
			}
		}
		if w := call("HEAD", "/api/repo/second-provider/file/XXXX-1.txt", "", nil); w.Code != 403 {
			t.Fatal("revoked HEAD", w.Code)
		}
		p.revoked = false
		// An optional verifier receives the computed proof for an opaque
		// provider revision and can reject publication without GitHub rules.
		accessForVerify, err := s.providerAccess(original)
		if err != nil {
			t.Fatal(err)
		}
		verified := &verifyingFixture{fixtureProvider: p, reject: true}
		verifyEntry := provider.Entry{Path: "verified.txt", Revision: "opaque:verified", Size: int64(len(fixtureContent))}
		if body, err := s.sharedSource(ctx, original, verified, accessForVerify, verifyEntry); err == nil {
			body.Close()
			t.Fatal("verifier rejection ignored")
		} else if err.Error() != "fixture_hash_rejected" {
			t.Fatal(err)
		}
		if hit, err := cache.Lookup(ctx, sharedSourceKey(original, verified, accessForVerify, verifyEntry)); err != nil || hit != nil {
			if hit != nil {
				hit.Close()
			}
			t.Fatal("failed proof was published", err)
		}
		verified.reject = false
		verifiedBody, err := s.sharedSource(ctx, original, verified, accessForVerify, verifyEntry)
		if err != nil {
			t.Fatal(err)
		}
		verifiedBytes, err := io.ReadAll(verifiedBody)
		verifiedBody.Close()
		if err != nil || string(verifiedBytes) != fixtureContent || verified.calls != 2 {
			t.Fatal(string(verifiedBytes), err, verified.calls)
		}
		// Disk admission failure falls back to a bounded upstream stream.
		tiny, err := blobcache.New(ctx, blobcache.Options{Root: t.TempDir(), Budget: 1, MaxObject: 4096})
		if err != nil {
			t.Fatal(err)
		}
		defer tiny.Close()
		s.sourceCache = tiny
		access, err := s.providerAccess(original)
		if err != nil {
			t.Fatal(err)
		}
		body, err := s.sharedSource(ctx, original, p, access, provider.Entry{Path: "Alice.txt", Revision: "opaque:fallback", Size: int64(len(fixtureContent))})
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(body)
		body.Close()
		if err != nil || string(data) != fixtureContent {
			t.Fatal(string(data), err)
		}
		stats, err = tiny.Stats(ctx)
		if err != nil || stats.Blobs != 0 || stats.ReservedBytes != 0 {
			t.Fatal(stats, err)
		}
	})
}

type verifyingFixture struct {
	afterVerify func()
	*fixtureProvider
	reject bool
	calls  int
}

func (p *verifyingFixture) VerifyContent(_ context.Context, _ provider.Access, _ provider.Entry, proof provider.ContentProof) (string, error) {
	p.calls++
	if p.afterVerify != nil {
		defer p.afterVerify()
	}
	sum := sha256.Sum256([]byte(fixtureContent))
	if proof.SHA256 != hex.EncodeToString(sum[:]) || proof.Size != int64(len(fixtureContent)) {
		return "", errors.New("incorrect_proof")
	}
	if p.reject {
		return "", errors.New("fixture_hash_rejected")
	}
	return "sha256-" + proof.SHA256, nil
}
