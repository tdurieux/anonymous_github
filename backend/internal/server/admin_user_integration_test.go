package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAdminUserDetailIntegration(t *testing.T, s *Server, nonAdminToken string) {
	t.Run("admin user detail populates provider metadata without credentials", func(t *testing.T) {
		ctx := context.Background()
		token := "synthetic-admin-user-detail"
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": bson.NewObjectID(), "username": "admin-user-detail-reader", "status": "active", "isAdmin": true, "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}); err != nil {
			t.Fatal(err)
		}
		anonymous, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		cachedID, err := oid(str(obj(anonymous["source"])["repositoryId"]))
		if err != nil {
			t.Fatal(err)
		}
		cached, err := s.Store.one(ctx, "repositories", M{"_id": cachedID})
		if err != nil || cached == nil {
			t.Fatal(cached, err)
		}
		if cached["source"] != "fixture" {
			t.Fatal("provider metadata lost its source", cached)
		}
		second := M{"_id": bson.NewObjectID(), "externalId": "detail_second", "source": "second-forge", "name": "nested/group/repo", "accessToken": "synthetic-private-repo-token"}
		if _, err := s.Store.DB.Collection("repositories").InsertOne(ctx, second); err != nil {
			t.Fatal(err)
		}
		at := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
		user := M{"_id": bson.NewObjectID(), "username": "admin-user-detail-target", "status": "banned", "externalIDs": M{"github": "detail-identity"}, "accessTokenDates": M{"github": at}, "dateOfEntry": at, "default": M{"terms": []string{"Alice"}, "options": M{"image": false}}, "projectNames": M{"repo:example": "Project"}, "repositories": []any{cachedID.Hex(), bson.NewObjectID().Hex(), str(second["_id"]), cachedID.Hex()}, "accessTokens": M{"github": "synthetic-private-user-token"}, "apiTokens": []M{{"tokenHash": "synthetic-private-hash"}}, "encryptedToken": "synthetic-private-envelope"}
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		before, err := s.Store.one(ctx, "users", M{"_id": user["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		call := func(auth, name string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("GET", "/api/admin/users/"+name, nil)
			req.RemoteAddr = "198.51.100.19:1234"
			req.Header.Set("Authorization", "Bearer "+auth)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		if w := call(nonAdminToken, str(user["username"])); w.Code != 401 {
			t.Fatal(w.Code, w.Body)
		}
		if w := call(token, "admin-user-detail-missing"); w.Code != 404 {
			t.Fatal(w.Code, w.Body)
		}
		w := call(token, str(user["username"]))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), "synthetic-private") {
			t.Fatal("credential data exposed")
		}
		var out M
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out["_id"] != str(user["_id"]) || obj(out["externalIDs"])["github"] != "detail-identity" || obj(out["projectNames"])["repo:example"] != "Project" || obj(out["accessTokenDates"])["github"] != "2030-01-02T03:04:05.000Z" {
			t.Fatal("user metadata missing", out)
		}
		if out["isAdmin"] != false || len(arr(out["emails"])) != 0 || len(arr(obj(out["default"])["terms"])) != 1 || obj(obj(out["default"])["options"])["image"] != false {
			t.Fatal("user defaults missing", out)
		}
		repositories := arr(out["repositories"])
		if len(repositories) != 3 || obj(repositories[0])["_id"] != cachedID.Hex() || obj(repositories[1])["_id"] != str(second["_id"]) || obj(repositories[2])["_id"] != cachedID.Hex() {
			t.Fatal("population order/missing/duplicates", repositories)
		}
		if obj(repositories[0])["source"] != "fixture" || obj(repositories[1])["source"] != "second-forge" || obj(repositories[1])["status"] != "ready" || obj(repositories[1])["hasPage"] != false {
			t.Fatal("provider metadata/defaults", repositories)
		}
		after, err := s.Store.one(ctx, "users", M{"_id": user["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(before, after) {
			t.Fatal("detail read mutated stored user")
		}
	})
}
