package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAdminTokensIntegration(t *testing.T, s *Server) {
	t.Run("admin token lifecycle", func(t *testing.T) {
		ctx := context.Background()
		id := bson.NewObjectID()
		bootstrap := "synthetic-admin-token-bootstrap"
		user := M{"_id": id, "username": "admin-token-fixture", "status": "active", "isAdmin": true, "apiTokens": []M{{"_id": bson.NewObjectID(), "name": "bootstrap", "tokenHash": security.HashToken(bootstrap)}}}
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		call := func(method, path, token string, body any) *httptest.ResponseRecorder {
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest(method, path, bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.23:1234"
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		w := call("POST", "/api/admin/tokens", bootstrap, M{"name": []any{" Alice ", "Bob"}})
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		var created M
		if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
			t.Fatal(err)
		}
		token := str(created["token"])
		if len(token) != 64 || created["name"] != "Alice ,Bob" || len(created) != 4 {
			t.Fatal("invalid creation shape", created)
		}
		saved, err := s.Store.one(ctx, "users", M{"_id": id})
		if err != nil {
			t.Fatal(err)
		}
		entries := arr(saved["apiTokens"])
		if len(entries) != 2 {
			t.Fatal("missing token")
		}
		stored := obj(entries[1])
		if stored["tokenHash"] != security.HashToken(token) || stored["token"] != nil || str(stored["_id"]) != str(created["id"]) {
			t.Fatal("plaintext storage or incorrect token identity")
		}
		w = call("GET", "/api/admin/tokens", token, nil)
		if w.Code != 200 || strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "tokenHash") {
			t.Fatal("token list leaked secret", w.Code, w.Body)
		}
		var listed []M
		if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
			t.Fatal(err)
		}
		if len(listed) != 2 || listed[1]["lastUsedAt"] == nil {
			t.Fatal("list did not reload last-used metadata", listed)
		}
		for i := 0; i < 2; i++ {
			w = call("DELETE", "/api/admin/tokens/"+str(created["id"]), bootstrap, nil)
			var result M
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || number(result["removed"]) != int64(1-i) {
				t.Fatal("delete result", w.Code, w.Body)
			}
		}
		if w := call("GET", "/api/admin/tokens", token, nil); w.Code != 401 {
			t.Fatal("revoked token still accepted", w.Code)
		}
		if w := call("DELETE", "/api/admin/tokens/invalid", bootstrap, nil); w.Code != 500 || !strings.Contains(w.Body.String(), "internal_error") {
			t.Fatal("invalid ID parity", w.Code, w.Body)
		}
		if _, err := s.Store.update(ctx, "users", M{"_id": id}, M{"$set": M{"isAdmin": false}}); err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{"GET", "POST", "DELETE"} {
			path := "/api/admin/tokens"
			if method == "DELETE" {
				path += "/" + str(created["id"])
			}
			if w := call(method, path, bootstrap, nil); w.Code != 401 {
				t.Fatal("non-admin accepted", method, w.Code)
			}
		}
		// Simulate deletion after authentication but before handler execution.
		if _, err := s.Store.DB.Collection("users").DeleteOne(ctx, M{"_id": id}); err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{"GET", "POST"} {
			q := &request{Server: s, User: user, R: httptest.NewRequest(method, "/", nil), Body: M{}}
			result, err := s.tokens(q)
			if err == nil || err.Error() != "user_not_found" || result != nil {
				t.Fatal("vanished user accepted", method, err)
			}
		}
	})
}
