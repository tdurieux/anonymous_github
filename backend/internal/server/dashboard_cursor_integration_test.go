package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runDashboardCursorIntegration(t *testing.T, s *Server) {
	t.Run("dashboard cursor HTTP contracts", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		token := "synthetic-dashboard-cursors"
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "dashboard-cursor-fixture", "status": "active", "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}); err != nil {
			t.Fatal(err)
		}
		for index, name := range []string{"cursor-a", "cursor-b", "cursor-c"} {
			repoID, err := oid(fmt.Sprintf("eeddcc00000000000000000%d", index+1))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, M{"_id": repoID, "repoId": name, "anonymizeDate": time.Date(2024, 3, index+1, 0, 0, 0, 0, time.UTC), "owner": owner, "status": "ready", "options": M{"expirationMode": "never"}, "source": M{"provider": "fixture", "repositoryName": "nested/team/project"}}); err != nil {
				t.Fatal(err)
			}
		}
		requests := 0
		call := func(query url.Values) *httptest.ResponseRecorder {
			req := httptest.NewRequest("GET", "/api/user/dashboard?"+query.Encode(), nil)
			// Authentication throttling has separate tests. Keep each batch
			// below its per-IP attempt budget while exercising cursor cases.
			requests++
			req.RemoteAddr = fmt.Sprintf("198.51.100.%d:1234", 200+requests/40)
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		raw, err := os.ReadFile("testdata/dashboard-cursors.json")
		if err != nil {
			t.Fatal(err)
		}
		var cases []struct {
			Sort, Cursor string
			Rejected     bool
			HTTP         bool
		}
		if err := json.Unmarshal(raw, &cases); err != nil {
			t.Fatal(err)
		}
		for i, c := range cases {
			if !c.HTTP {
				continue
			}
			w := call(url.Values{"sort": {c.Sort}, "cursor": {c.Cursor}})
			want := 200
			if c.Rejected {
				want = 400
			}
			if w.Code != want {
				t.Fatalf("case %d: %d %s", i, w.Code, w.Body)
			}
		}
		for _, value := range []any{"March 1 2024", "2024-02-30", "2024-02-29T24:00:00Z", []string{"2024", "3", "1"}} {
			payload, err := json.Marshal(M{"sort": "anonymizeDate", "type": "repo", "id": "eeddcc000000000000000001", "value": value})
			if err != nil {
				t.Fatal(err)
			}
			w := call(url.Values{"sort": {"anonymizeDate"}, "limit": {"1"}, "cursor": {base64.RawURLEncoding.EncodeToString(payload)}})
			var result M
			if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 {
				t.Fatal(value, w.Code, w.Body)
			}
			items := arr(result["items"])
			if len(items) != 1 || str(obj(items[0])["repoId"]) != "cursor-b" || number(result["total"]) != 3 || number(result["filtered"]) != 3 {
				t.Fatal("date cursor boundary", value, result)
			}
		}

		limitRaw, err := os.ReadFile("testdata/dashboard-limits.json")
		if err != nil {
			t.Fatal(err)
		}
		var limits []struct {
			Values   []string
			Expected int
		}
		if err := json.Unmarshal(limitRaw, &limits); err != nil {
			t.Fatal(err)
		}
		for _, c := range limits {
			w := call(url.Values{"sort": {"_name"}, "limit": c.Values})
			if w.Code != 200 {
				t.Fatal(c, w.Code, w.Body)
			}
			var result M
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(arr(result["items"])) != min(3, c.Expected) || (result["cursor"] != nil) != (c.Expected < 3) {
				t.Fatal("limit page mismatch", c, result)
			}
		}
		outputRaw, err := os.ReadFile("testdata/dashboard-cursor-output.json")
		if err != nil {
			t.Fatal(err)
		}
		var outputs []struct {
			Value    any
			Expected string
			HTTP     bool
		}
		if err := json.Unmarshal(outputRaw, &outputs); err != nil {
			t.Fatal(err)
		}
		expectedCursors := map[string]string{}
		for _, output := range outputs {
			if output.HTTP {
				expectedCursors[str(output.Value)] = output.Expected
			}
		}
		cursor := ""
		for _, name := range []string{"cursor-a", "cursor-b", "cursor-c"} {
			query := url.Values{"sort": {"_name"}, "limit": {"1"}}
			if cursor != "" {
				query.Set("cursor", cursor)
			}
			w := call(query)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
			var result M
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			items := arr(result["items"])
			if len(items) != 1 || obj(items[0])["repoId"] != name || number(result["total"]) != 3 || number(result["filtered"]) != 3 {
				t.Fatal("page mismatch", result)
			}
			cursor = str(result["cursor"])
			if cursor != expectedCursors[name] {
				t.Fatal("cursor differs from TypeScript bytes", name, cursor, expectedCursors[name])
			}
			if (name == "cursor-c") != (cursor == "") {
				t.Fatal("unexpected next cursor", result)
			}
		}
	})
}
