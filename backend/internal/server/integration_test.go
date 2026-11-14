package server

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestBackendIntegration(t *testing.T) {
	uri, redisAddress := os.Getenv("GO_TEST_MONGODB_URI"), os.Getenv("GO_TEST_REDIS_ADDR")
	if uri == "" || redisAddress == "" {
		t.Skip("requires disposable MongoDB and Redis")
	}
	if !strings.HasPrefix(uri, "mongodb://127.0.0.1:") || !strings.HasPrefix(redisAddress, "127.0.0.1:") {
		t.Fatal("integration tests require local disposable services")
	}
	// This context spans all sequential subtests, including large-list fixtures.
	// Follow the runner deadline instead of spending later tests' budget in
	// earlier subtests. Application request and operation limits are unchanged.
	ctx := t.Context()
	if deadline, ok := t.Deadline(); ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline.Add(-5*time.Second))
		defer cancel()
	}
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	cipher, err := security.NewCipher(`{"test":"`+key+`"}`, "test")
	if err != nil {
		t.Fatal(err)
	}
	public := t.TempDir()
	os.WriteFile(filepath.Join(public, "index.html"), []byte("<!doctype html>test"), 0600)
	config := Config{MongoURI: uri, Database: "go_migration_test_" + bson.NewObjectID().Hex(), RedisAddress: redisAddress, SessionSecret: "synthetic-session-key", Root: t.TempDir(), PublicDir: public, Mask: "XXXX", Hostname: "anonymous.test", Cipher: cipher, RateLimit: 10000, Download: true, Workers: 1}
	store, err := Connect(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close(context.Background())
	defer store.DB.Drop(context.Background())
	fakeProvider := &fixtureProvider{name: "team/subgroup/project", commit: "revision:one"}
	server, err := New(config, store, fakeProvider)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	if binary := os.Getenv("GO_TEST_SERVER_BINARY"); binary != "" {
		server.pool = anonymize.NewPool(binary, 1)
	}
	owner, other := bson.NewObjectID(), bson.NewObjectID()
	token := "synthetic-api-token"
	otherToken := "other-api-token"
	for _, u := range []M{{"_id": owner, "username": "alice", "status": "active", "externalIDs": M{"github": "1"}, "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}, {"_id": other, "username": "bob", "status": "active", "externalIDs": M{"github": "2"}, "apiTokens": []M{{"tokenHash": security.HashToken(otherToken)}}}} {
		if _, err = store.DB.Collection("users").InsertOne(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	envelope, err := cipher.Encrypt("synthetic-github-token", owner.Hex(), "github", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.DB.Collection("credentials").InsertOne(ctx, M{"ownerId": owner, "provider": "github", "encryptedToken": envelope, "updatedAt": time.Now()}); err != nil {
		t.Fatal(err)
	}
	sha := strings.Repeat("a", 40)
	server.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "api.github.com" {
			t.Errorf("unexpected upstream %s", r.URL.Host)
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-github-token" {
			t.Error("wrong credential")
		}
		var value any
		body := ""
		switch {
		case r.URL.Path == "/repos/owner/repo", r.URL.Path == "/repositories/10":
			value = M{"id": 10, "full_name": "owner/repo", "default_branch": "main"}
		case strings.Contains(r.URL.Path, "/commits/"):
			value = M{"sha": sha, "commit": M{"committer": M{"date": "2026-01-01T00:00:00Z"}}}
		case strings.Contains(r.URL.Path, "/git/trees/"):
			value = M{"tree": []M{{"path": "Alice.txt", "sha": sha, "type": "blob", "size": 11}, {"path": "Alice.html", "sha": sha, "type": "blob", "size": 11}, {"path": "photo.png", "sha": sha, "type": "blob", "size": 11}}, "truncated": false}
		case strings.Contains(r.URL.Path, "/tarball/"):
			body = string(tarTestBytes(t, tarTestEntry{name: "snapshot/Alice.txt", body: "hello Alice"}, tarTestEntry{name: "snapshot/Alice.html", body: "hello Alice"}, tarTestEntry{name: "snapshot/photo.png", body: "hello Alice"}))
		case strings.Contains(r.URL.Path, "/git/blobs/"):
			body = "hello Alice"
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			value = M{}
		}
		if value != nil {
			b, _ := json.Marshal(value)
			body = string(b)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body))}, nil
	})}
	call := func(method, path, credential string, body any) *httptest.ResponseRecorder {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.RemoteAddr = "192.0.2.1:1234"
		if credential != "" {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		server.ServeHTTP(w, req)
		return w
	}
	t.Run("owner notification lifecycle", func(t *testing.T) { runOwnerAlertsIntegration(t, server) })
	t.Run("billing lifecycle", func(t *testing.T) { runBillingIntegration(t, server) })
	t.Run("second provider lifecycle", func(t *testing.T) { runProviderIntegration(t, server, fakeProvider, call, token, otherToken) })
	t.Run("public statistics cache", func(t *testing.T) { runPublicStatsIntegration(t, server) })
	t.Run("overview rolling activity counts", func(t *testing.T) { runOverviewIntegration(t, server) })
	t.Run("request performance history", func(t *testing.T) { runRequestMetricsIntegration(t, server) })
	t.Run("queue overview", func(t *testing.T) { runQueueOverviewIntegration(t, server) })
	t.Run("queue metric history", func(t *testing.T) { runQueueMetricIntegration(t, server) })
	t.Run("error monitoring history", func(t *testing.T) { runErrorLogIntegration(t, server) })
	t.Run("process performance history", func(t *testing.T) { runProcessMetricsIntegration(t, server) })
	t.Run("access control precedes private output", func(t *testing.T) {
		for _, p := range []string{"/api/user", "/api/user/dashboard", "/api/admin/tokens"} {
			w := call("GET", p, "", nil)
			if w.Code != 401 {
				t.Errorf("%s: %d %s", p, w.Code, w.Body)
			}
		}
		w := call("GET", "/api/admin/tokens", token, nil)
		if w.Code != 401 {
			t.Fatal("non-admin accessed tokens", w.Code)
		}
	})
	t.Run("create prepare and public output", func(t *testing.T) {
		body := M{"repoId": "fixture", "fullName": "owner/repo", "source": M{"branch": "main", "commit": sha}, "terms": []string{"Alice"}, "options": M{"expirationMode": "never", "image": false, "pdf": false, "link": true}}
		w := call("POST", "/api/repo", token, body)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		r, err := store.one(ctx, "anonymizedrepositories", M{"repoId": "fixture"})
		if err != nil {
			t.Fatal(err)
		}
		if err = server.prepareTree(ctx, r); err != nil {
			t.Fatal(err)
		}
		w = call("GET", "/api/repo/fixture", otherToken, nil)
		if w.Code != 403 {
			t.Fatal("non-owner received private options", w.Code, w.Body.String())
		}
		w = call("GET", "/api/repo/fixture/files", "", nil)
		if w.Code != 200 || strings.Contains(w.Body.String(), "Alice") {
			t.Fatal("file names leaked", w.Code, w.Body.String())
		}
		w = call("GET", "/api/repo/fixture/file/photo.png", "", nil)
		if w.Code != 403 {
			t.Fatal("image exclusion bypassed", w.Code)
		}
		if os.Getenv("GO_TEST_SERVER_BINARY") == "" {
			t.Log("file worker test skipped: GO_TEST_SERVER_BINARY missing")
			return
		}
		w = call("GET", "/api/repo/fixture/file/XXXX-1.txt", "", nil)
		if w.Code != 200 || w.Body.String() != "hello XXXX-1" {
			t.Fatal("wrong anonymized content", w.Code, w.Body.String())
		}
		w = call("GET", "/api/repo/fixture/file/XXXX-1.html", "", nil)
		if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Security-Policy"), "sandbox ") || strings.Contains(w.Header().Get("Content-Security-Policy"), "allow-same-origin") {
			t.Fatal("scriptable content not sandboxed", w.Code, w.Header())
		}
	})

	t.Run("streaming archive ZIP", func(t *testing.T) { runArchiveZIPIntegration(t, server) })
	t.Run("ZIP entries preserve transformed content and exclusions", func(t *testing.T) {
		if os.Getenv("GO_TEST_SERVER_BINARY") == "" {
			t.Skip("worker binary required")
		}
		w := call("GET", "/api/repo/fixture/zip", "", nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		archive, e := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
		if e != nil {
			t.Fatal(e)
		}
		if len(archive.File) != 2 {
			t.Fatalf("wrong ZIP entries: %d", len(archive.File))
		}
		for _, entry := range archive.File {
			if strings.Contains(entry.Name, "Alice") || strings.HasSuffix(entry.Name, ".png") {
				t.Fatal("excluded or original name in ZIP")
			}
			r, e := entry.Open()
			if e != nil {
				t.Fatal(e)
			}
			b, e := io.ReadAll(r)
			r.Close()
			if e != nil || string(b) != "hello XXXX-1" {
				t.Fatalf("wrong ZIP body %q %v", b, e)
			}
		}
	})
	t.Run("ZIP entries cross metadata cursor batches", func(t *testing.T) {
		if os.Getenv("GO_TEST_SERVER_BINARY") == "" {
			t.Skip("worker binary required")
		}
		repo, err := store.one(ctx, "anonymizedrepositories", M{"repoId": "fixture"})
		if err != nil {
			t.Fatal(err)
		}
		// More than two batches; every entry must survive getMore and projection.
		const count = 260
		docs := make([]any, 0, count)
		for i := 0; i < count; i++ {
			docs = append(docs, M{"repoId": "fixture", "treeGeneration": activeGeneration(repo), "path": "zip-batches", "name": str(i) + ".txt", "size": 11, "sha": sha})
		}
		if _, err := store.DB.Collection("files").InsertMany(ctx, docs); err != nil {
			t.Fatal(err)
		}
		defer store.DB.Collection("files").DeleteMany(ctx, M{"repoId": "fixture", "path": "zip-batches"})
		w := call("GET", "/api/repo/fixture/zip", "", nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
		if err != nil {
			t.Fatal(err)
		}
		if len(archive.File) != count+2 {
			t.Fatalf("incomplete ZIP: %d entries", len(archive.File))
		}
		seen := map[string]bool{}
		for _, entry := range archive.File {
			if seen[entry.Name] {
				t.Fatal("duplicate ZIP entry", entry.Name)
			}
			seen[entry.Name] = true
			reader, err := entry.Open()
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || string(body) != "hello XXXX-1" {
				t.Fatalf("invalid transformed entry %s: %q %v", entry.Name, body, err)
			}
		}
		for i := 0; i < count; i++ {
			if !seen["zip-batches/"+str(i)+".txt"] {
				t.Fatal("missing ZIP entry", i)
			}
		}
	})
	t.Run("legacy Zip sources can rebuild their tree", func(t *testing.T) {
		id := "zip-fixture"
		if e := server.content.Put(ctx, id, "Alice.txt", strings.NewReader("hello Alice"), 11, 100); e != nil {
			t.Fatal(e)
		}
		r := M{"_id": bson.NewObjectID(), "repoId": id, "owner": owner, "status": "preparing", "statusDate": time.Now(), "source": M{"type": "Zip"}, "options": M{"terms": []string{"Alice"}, "link": true, "expirationMode": "never"}}
		if _, e := store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		if e := server.prepareTree(ctx, r); e != nil {
			t.Fatal(e)
		}
		rows, e := store.list(ctx, "files", M{"repoId": id}, 100, nil)
		if e != nil || len(rows) != 1 || number(rows[0]["size"]) != 11 {
			t.Fatalf("wrong uploaded tree: %v %v", rows, e)
		}
	})

	t.Run("dashboard and scoped token enforcement", func(t *testing.T) {
		w := call("GET", "/api/user/dashboard", token, nil)
		if w.Code != 200 {
			t.Fatal("dashboard failed", w.Code, w.Body.String())
		}
		scoped := "scoped-synthetic"
		expired := "expired-synthetic"
		_, e := store.update(ctx, "users", M{"_id": owner}, M{"$push": M{"apiTokens": M{"$each": []M{{"tokenHash": security.HashToken(scoped), "scope": "repository-maintenance", "repoIds": []string{"fixture"}, "expiresAt": time.Now().Add(time.Hour)}, {"tokenHash": security.HashToken(expired), "expiresAt": time.Now().Add(-time.Hour)}}}}})
		if e != nil {
			t.Fatal(e)
		}
		for _, expiry := range []time.Time{time.Time{}, time.UnixMilli(0)} {
			for _, scope := range []string{"", "repository-maintenance"} {
				candidate := "expired-boundary-" + expiry.Format("2006") + scope
				_, err := store.update(ctx, "users", M{"_id": owner}, M{"$push": M{"apiTokens": M{"tokenHash": security.HashToken(candidate), "scope": scope, "repoIds": []string{"fixture"}, "expiresAt": expiry}}})
				if err != nil {
					t.Fatal(err)
				}
				w := call("GET", "/api/maintenance/repositories/fixture", candidate, nil)
				if w.Code != 401 {
					t.Fatalf("expired boundary token accepted: %d", w.Code)
				}
			}
		}
		for _, tc := range []struct {
			method, path, token string
			body                any
			status              int
		}{
			{"GET", "/api/maintenance/repositories/fixture", scoped, nil, 200},
			{"GET", "/api/user", scoped, nil, 403},
			{"GET", "/api/maintenance/repositories/other", scoped, nil, 403},
			{"GET", "/api/user", expired, nil, 401},
			{"POST", "/github/login-token", "", M{"token": scoped}, 401},
			{"PATCH", "/api/maintenance/repositories/fixture", scoped, M{"terms": []string{"Alice", "Bob"}}, 200},
			{"PATCH", "/api/maintenance/repositories/fixture", scoped, M{"owner": other.Hex()}, 400},
		} {
			w := call(tc.method, tc.path, tc.token, tc.body)
			if w.Code != tc.status {
				t.Errorf("%s %s: got %d want %d: %s", tc.method, tc.path, w.Code, tc.status, w.Body.String())
			}
		}
	})

	t.Run("GitHub App access remains bound and revocation wins token issuance", func(t *testing.T) {
		oldHTTP, oldConfig := server.HTTP, server.Config
		defer func() { server.HTTP = oldHTTP; server.Config = oldConfig }()
		key, e := rsa.GenerateKey(rand.Reader, 2048)
		if e != nil {
			t.Fatal(e)
		}
		server.Config.AppEnabled = true
		server.Config.AppID = "99"
		server.Config.AppClientID = "test-client"
		server.Config.AppPrivateKey = string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
		encrypted, e := cipher.Encrypt("app-user", owner.Hex(), "github-app-user", "")
		if e != nil {
			t.Fatal(e)
		}
		_, e = store.DB.Collection("credentials").InsertOne(ctx, M{"ownerId": owner, "provider": "github-app-user", "encryptedToken": encrypted, "expiresAt": time.Now().Add(time.Hour), "revision": "grant-v1"})
		if e != nil {
			t.Fatal(e)
		}
		_, e = store.DB.Collection("githubinstallations").InsertOne(ctx, M{"appId": "99", "installationId": int64(42), "revision": "installation-v1", "blocked": false})
		if e != nil {
			t.Fatal(e)
		}
		writePermission, revokeDuringIssue := false, false
		calls := 0
		server.HTTP = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
			calls++
			if req.Header.Get("Authorization") == "Bearer synthetic-github-token" {
				t.Fatal("App access fell back to OAuth")
			}
			var data M
			switch req.URL.Path {
			case "/user":
				data = M{"id": 1}
			case "/repositories/10":
				data = M{"id": 10, "full_name": "owner/repo"}
			case "/app/installations/42":
				permission := "read"
				if writePermission {
					permission = "write"
				}
				data = M{"id": 42, "app_id": 99, "permissions": M{"contents": permission, "metadata": "read"}}
			case "/app/installations/42/access_tokens":
				var payload M
				if json.NewDecoder(req.Body).Decode(&payload) != nil {
					t.Fatal("invalid token request")
				}
				if len(arr(payload["repository_ids"])) != 1 || number(arr(payload["repository_ids"])[0]) != 10 || obj(payload["permissions"])["contents"] != "read" {
					t.Fatal("token was not scoped", payload)
				}
				if revokeDuringIssue {
					_, e := store.update(ctx, "githubinstallations", M{"installationId": 42}, M{"$set": M{"blocked": true, "revision": "installation-v2"}})
					if e != nil {
						t.Fatal(e)
					}
				}
				data = M{"token": "installation-token", "expires_at": time.Now().Add(30 * time.Second).Format(time.RFC3339)}
			default:
				t.Fatalf("unexpected App endpoint %s", req.URL.Path)
			}
			b, _ := json.Marshal(data)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(b))}, nil
		})}
		binding := M{"kind": "github-app", "repositoryId": int64(10), "installationId": int64(42)}
		got, e := server.boundToken(ctx, owner, binding, "owner/repo")
		if e != nil || got != "installation-token" {
			t.Fatal("valid binding failed", e)
		}
		if _, e = store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"}, M{"$set": M{"reconciliationPending": true}}); e != nil {
			t.Fatal(e)
		}
		beforePending := calls
		if _, e = server.boundToken(ctx, owner, binding, "owner/repo"); e == nil || calls != beforePending {
			t.Fatal("pending grant was used")
		}
		row, e := store.one(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"})
		if e != nil {
			t.Fatal(e)
		}
		if e = server.reconcileGrant(ctx, row); e != nil {
			t.Fatal(e)
		}
		if _, e = server.boundToken(ctx, owner, binding, "owner/repo"); e != nil {
			t.Fatal("valid reconciled grant blocked", e)
		}
		writePermission = true
		if _, e = server.boundToken(ctx, owner, binding, "owner/repo"); e == nil {
			t.Fatal("write-capable installation accepted")
		}
		writePermission = false
		revokeDuringIssue = true
		if _, e = server.boundToken(ctx, owner, binding, "owner/repo"); e == nil {
			t.Fatal("revocation lost to token issuance")
		}
		_, e = store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github-app-user"}, M{"$set": M{"revoked": true}})
		if e != nil {
			t.Fatal(e)
		}
		before := calls
		if _, e = server.boundToken(ctx, owner, binding, "owner/repo"); e == nil || calls != before {
			t.Fatal("revoked grant was used")
		}
	})
	t.Run("removed account and forged session fail closed", func(t *testing.T) {
		w := call("POST", "/github/login-token", "", M{"token": token})
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatal("missing session")
		}
		if _, err = store.update(ctx, "users", M{"_id": owner}, M{"$set": M{"status": "banned"}}); err != nil {
			t.Fatal(err)
		}
		w = call("GET", "/api/user", token, nil)
		if w.Code != 401 {
			t.Fatal("banned bearer accepted", w.Code)
		}
		req := httptest.NewRequest("GET", "/api/user", nil)
		req.RemoteAddr = "192.0.2.1:1234"
		req.AddCookie(cookies[0])
		w = httptest.NewRecorder()
		server.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatal("banned session accepted", w.Code)
		}
		store.Redis.Del(ctx, "go:rate:192.0.2.1")
	})
	t.Run("unsigned webhooks rejected", func(t *testing.T) {
		w := call("POST", "/github/app/webhook", "", M{"action": "deleted"})
		if w.Code != 401 {
			t.Fatal(w.Code)
		}
	})
}
