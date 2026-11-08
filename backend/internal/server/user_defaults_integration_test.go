package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runUserDefaultsIntegration(t *testing.T, s *Server) {
	t.Run("user defaults match schema casts through HTTP", func(t *testing.T) {
		ctx := context.Background()
		id := bson.NewObjectID()
		token := "synthetic-user-defaults"
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": id, "username": "user-defaults-fixture", "status": "active", "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}); err != nil {
			t.Fatal(err)
		}
		call := func(method, path string, body any) *httptest.ResponseRecorder {
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest(method, path, bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.20:1234"
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		read := func() any {
			t.Helper()
			w := call("GET", "/api/user/default", nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
			var value any
			if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
				t.Fatal(err, w.Body)
			}
			return value
		}
		fixture := userDefaultsFixture(t)
		for _, c := range fixture.Initial {
			update := M{"$unset": M{"default": ""}}
			if value, present := c.User["default"]; present {
				update = M{"$set": M{"default": value}}
			}
			if _, err := s.Store.update(ctx, "users", M{"_id": id}, update); err != nil {
				t.Fatal(err)
			}
			if got := read(); !reflect.DeepEqual(got, c.Expected) {
				t.Fatal("initial", got, c.Expected)
			}
		}
		for _, c := range fixture.Cases {
			original := M{"terms": []any{"Old"}, "options": M{"image": true}}
			if _, err := s.Store.update(ctx, "users", M{"_id": id}, M{"$set": M{"default": original}}); err != nil {
				t.Fatal(err)
			}
			w := call("POST", "/api/user/default", c.Body)
			stored, err := s.Store.one(ctx, "users", M{"_id": id})
			if err != nil {
				t.Fatal(err)
			}
			if c.Rejected {
				if w.Code != 400 || !reflect.DeepEqual(defaultsJSON(t, stored["default"]), defaultsJSON(t, original)) {
					t.Fatal(c.Name, "invalid update changed defaults", w.Code, w.Body)
				}
				continue
			}
			if w.Code != 200 || w.Body.String() != "ok" {
				t.Fatal(c.Name, w.Code, w.Body)
			}
			if !reflect.DeepEqual(defaultsJSON(t, stored["default"]), defaultsJSON(t, c.Stored)) {
				t.Fatal(c.Name, "stored", stored["default"], c.Stored)
			}
			if got := read(); !reflect.DeepEqual(got, c.Expected) {
				t.Fatal(c.Name, "read", got, c.Expected)
			}
		}
		w := call("GET", "/api/user", nil)
		var profile M
		if err := json.Unmarshal(w.Body.Bytes(), &profile); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || !reflect.DeepEqual(profile, M{"username": "user-defaults-fixture", "isAdmin": false}) {
			t.Fatal("absent photo", w.Code, w.Body)
		}
		if _, err := s.Store.update(ctx, "users", M{"_id": id}, M{"$set": M{"photo": nil}}); err != nil {
			t.Fatal(err)
		}
		w = call("GET", "/api/user", nil)
		profile = M{}
		if err := json.Unmarshal(w.Body.Bytes(), &profile); err != nil {
			t.Fatal(err)
		}
		if _, present := profile["photo"]; !present || profile["photo"] != nil {
			t.Fatal("explicit null photo", profile)
		}
	})
}
