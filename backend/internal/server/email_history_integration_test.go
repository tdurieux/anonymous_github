package server

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func runEmailHistoryIntegration(t *testing.T, base *Server) {
	ctx := t.Context()
	db := base.Store.DB.Client().Database("email_history_test_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	config := base.Config
	config.Root = t.TempDir()
	config.EmailAPIKey = "synthetic"
	config.EmailFrom = "alerts@example.test"
	s, err := New(config, &Store{DB: db, Redis: base.Store.Redis})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Store.ensureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	owner := bson.NewObjectID()
	adminToken, userToken := uuid.NewString(), uuid.NewString()
	_, err = db.Collection("users").InsertMany(ctx, []any{M{"_id": owner, "username": "owner", "status": "active", "notificationEmail": "owner@example.test", "apiTokens": []M{{"tokenHash": security.HashToken(userToken)}}}, M{"_id": bson.NewObjectID(), "username": "admin", "status": "active", "isAdmin": true, "apiTokens": []M{{"tokenHash": security.HashToken(adminToken)}}}})
	if err != nil {
		t.Fatal(err)
	}
	var sends, mode atomic.Int64
	s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		sends.Add(1)
		if r.URL.Host != "api.resend.com" || r.Header.Get("Idempotency-Key") == "" {
			t.Error("unsafe mail request")
		}
		if mode.Load() == 1 {
			return nil, errors.New("synthetic ambiguous delivery")
		}
		return &http.Response{StatusCode: 202, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	id := bson.NewObjectID()
	expiration := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	_, err = db.Collection(collection("repo")).InsertOne(ctx, M{"_id": id, "repoId": "expired-fixture", "owner": owner, "status": "expired", "statusDate": time.Now(), "options": M{"expirationMode": "remove", "expirationDate": expiration}})
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func() { defer group.Done(); s.notifyRepositoryExpired(ctx, id) }()
	}
	group.Wait()
	if sends.Load() != 1 {
		t.Fatal("duplicate expiration delivery", sends.Load())
	}
	history, err := s.Store.list(ctx, emailDeliveryHistory, M{}, 0, nil)
	if err != nil || len(history) != 1 || history[0]["state"] != "accepted" {
		t.Fatal(history, err)
	}
	for _, forbidden := range []string{"body", "headers", "authorization", "subject", "text"} {
		if history[0][forbidden] != nil {
			t.Fatal("private mail content persisted")
		}
	}
	// A later expiration gets a new attempt. Ambiguous delivery keeps its claim.
	mode.Store(1)
	_, err = s.Store.update(ctx, collection("repo"), M{"_id": id}, M{"$set": M{"options.expirationDate": expiration.Add(time.Minute)}})
	if err != nil {
		t.Fatal(err)
	}
	s.notifyRepositoryExpired(ctx, id)
	s.notifyRepositoryExpired(ctx, id)
	if sends.Load() != 2 {
		t.Fatal("ambiguous mail repeated", sends.Load())
	}
	row, err := s.Store.one(ctx, emailDeliveryHistory, M{"state": "unknown"})
	if err != nil || row == nil {
		t.Fatal("unknown delivery not recorded", err)
	}
	// Keep page and summary totals independent of the selected page/cursor.
	fixtures := []any{}
	stamp := time.Now().Truncate(time.Millisecond)
	for i := 0; i < 60; i++ {
		fixtures = append(fixtures, M{"_id": uuid.NewString(), "kind": "owner-access", "recipient": "literal+tag@example.test", "ownerId": owner.Hex(), "createdAt": stamp, "state": "accepted", "privateField": "must not be returned"})
	}
	if _, err = db.Collection(emailDeliveryHistory).InsertMany(ctx, fixtures); err != nil {
		t.Fatal(err)
	}
	call := func(path, token string) (int, M) {
		r := httptest.NewRequest("GET", path, nil)
		r.RemoteAddr = "198.51.100.9:1234"
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		out := M{}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(w.Body.String())
		}
		if token == adminToken && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("history can be cached")
		}
		return w.Code, out
	}
	for _, token := range []string{"", userToken} {
		status, _ := call("/api/admin/emails", token)
		if status != 401 && status != 403 {
			t.Fatal("history authorization", status)
		}
	}
	status, page := call("/api/admin/emails?kind=owner-access", adminToken)
	if status != 200 || len(arr(page["entries"])) != 50 || str(page["nextCursor"]) == "" {
		t.Fatal(status, page)
	}
	if obj(arr(page["entries"])[0])["privateField"] != nil {
		t.Fatal("projection leaked field")
	}
	status, last := call("/api/admin/emails?kind=owner-access&before="+url.QueryEscape(str(page["nextCursor"])), adminToken)
	if status != 200 || len(arr(last["entries"])) != 10 || last["nextCursor"] != nil {
		t.Fatal(status, last)
	}
	status, summary := call("/api/admin/emails/summary?kind=owner-access&state=unknown&before=ignored", adminToken)
	if status != 200 || number(summary["total"]) != 60 || len(arr(summary["series"])) != 30 {
		t.Fatal(status, summary)
	}
	status, page = call("/api/admin/emails?search="+url.QueryEscape("literal+tag"), adminToken)
	if status != 200 || len(arr(page["entries"])) != 50 {
		t.Fatal("literal search", status, page)
	}
	for _, query := range []string{"period[]=7d", "kind=invalid", "search[x]=x", "before=invalid"} {
		status, _ := call("/api/admin/emails?"+query, adminToken)
		if status != 400 {
			t.Fatal(query, status)
		}
	}
}
