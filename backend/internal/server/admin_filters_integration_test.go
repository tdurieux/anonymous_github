package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAdminFiltersIntegration(t *testing.T, s *Server, nonAdminToken string) {
	t.Run("admin status filters and missing owners", func(t *testing.T) {
		ctx := context.Background()
		token := "synthetic-admin-filters"
		owner := bson.NewObjectID()
		if _, err := s.Store.DB.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "admin-filter-owner", "status": "active", "isAdmin": true, "apiTokens": []M{{"tokenHash": security.HashToken(token)}}}); err != nil {
			t.Fatal(err)
		}
		prefix := "admin-filter-fixture-"
		for _, status := range []string{"ready", "error", "preparing", "queue", "download", "expired", "expiring", "removed", "removing", "archived"} {
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, M{"_id": bson.NewObjectID(), "repoId": prefix + status, "status": status, "size": M{"storage": 7}, "source": M{"provider": "fixture"}}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.DB.Collection("conferences").InsertOne(ctx, M{"_id": bson.NewObjectID(), "conferenceID": prefix + status, "name": prefix + status, "status": status}); err != nil {
				t.Fatal(err)
			}
		}
		call := func(kind, auth string, values url.Values) *httptest.ResponseRecorder {
			req := httptest.NewRequest("GET", "/api/admin/"+kind+"?"+values.Encode(), nil)
			req.RemoteAddr = "198.51.100.16:1234"
			req.Header.Set("Authorization", "Bearer "+auth)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		if w := call("repos", nonAdminToken, url.Values{}); w.Code != 401 {
			t.Fatal("non-admin allowed", w.Code, w.Body)
		}
		for _, kind := range []string{"repos", "conferences"} {
			for _, flag := range []string{"ready", "error", "preparing", "expired", "removed"} {
				values := url.Values{"search": {prefix}, flag: {"true"}}
				w := call(kind, token, values)
				var out M
				if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
					t.Fatal(err)
				}
				if w.Code != 200 {
					t.Fatal(kind, flag, w.Code, w.Body)
				}
				want := []string{flag}
				if kind == "repos" {
					switch flag {
					case "preparing":
						want = []string{"download", "preparing"}
					case "expired":
						want = []string{"expired", "expiring"}
					case "removed":
						want = []string{"removed", "removing"}
					}
				}
				got := []string{}
				for _, value := range arr(out["results"]) {
					got = append(got, str(obj(value)["status"]))
				}
				sort.Strings(got)
				sort.Strings(want)
				if !reflect.DeepEqual(got, want) || number(out["total"]) != int64(len(want)) {
					t.Fatal(kind, flag, got, want, out["total"])
				}
				_, sizePresent := out["totalSize"]
				if sizePresent != (kind == "repos") {
					t.Fatal("wrong totalSize shape", kind)
				}
				for _, row := range arr(out["statusCounts"]) {
					_, storagePresent := obj(row)["storage"]
					if storagePresent != (kind == "repos") {
						t.Fatal("wrong status count shape", kind)
					}
				}
			}
		}
		for _, kind := range []string{"repos", "conferences"} {
			field := "repoId"
			if kind == "conferences" {
				field = "conferenceID"
			}
			w := call(kind, token, url.Values{"search": {prefix}, "page": {"2.9"}, "limit": {"2rows"}, "sort": {field}, "direction": {"asc"}})
			var output M
			if err := json.Unmarshal(w.Body.Bytes(), &output); err != nil {
				t.Fatal(err)
			}
			rows := arr(output["results"])
			if w.Code != 200 || number(output["page"]) != 2 || len(rows) != 2 || str(obj(rows[0])[field]) != prefix+"error" || str(obj(rows[1])[field]) != prefix+"expired" {
				t.Fatal(kind, "pagination", w.Code, w.Body)
			}
			w = call(kind, token, url.Values{"search": {prefix}, "sort": {"$where"}})
			output = M{}
			if err := json.Unmarshal(w.Body.Bytes(), &output); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || number(obj(output["sort"])["_id"]) != -1 {
				t.Fatal(kind, "unsafe sort", w.Code, w.Body)
			}
		}
		for _, kind := range []string{"repos", "users", "conferences"} {
			for _, values := range []url.Values{
				{"page[]": {"2"}, "limit[]": {"2"}, "sort[]": {"status"}, "direction[]": {"asc"}, "format[]": {"csv"}},
				{"page": {"1000001"}, "limit": {"1"}},
			} {
				w := call(kind, token, values)
				var out M
				if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
					t.Fatal(kind, values, w.Code, w.Body)
				}
				wantPage := int64(2)
				if values.Get("page") != "" {
					wantPage = 1000001
				}
				if number(out["page"]) != wantPage || number(obj(out["sort"])["_id"]) != -1 {
					t.Fatal(kind, values, out)
				}
			}
			for _, values := range []url.Values{
				{"page": {"-1"}}, {"page": {"999999999999999999999999999999"}},
				{"page[toString]": {"x"}}, {"limit[toString]": {"x"}},
			} {
				w := call(kind, token, values)
				if w.Code != 500 || !strings.Contains(w.Body.String(), "internal_error") {
					t.Fatal(kind, values, w.Code, w.Body)
				}
			}
			negative := call(kind, token, url.Values{"limit": {"-1"}})
			if kind == "users" {
				if negative.Code != 500 {
					t.Fatal("negative aggregate limit", negative.Code, negative.Body)
				}
			} else {
				var out M
				if err := json.Unmarshal(negative.Body.Bytes(), &out); err != nil || negative.Code != 200 || len(arr(out["results"])) != 1 {
					t.Fatal("negative find limit", kind, negative.Code, negative.Body)
				}
			}
			// CSV does not execute pagination, even when its numeric values
			// would produce invalid MongoDB skip/limit stages.
			w := call(kind, token, url.Values{"page": {"-1"}, "limit": {"-1"}, "format": {"csv"}, "search": {"no-matching-export-fixture"}})
			if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/csv") {
				t.Fatal(kind, "CSV pagination", w.Code, w.Body)
			}
		}
		for _, kind := range []string{"repos", "users", "conferences"} {
			w := call(kind, token, url.Values{"format": {"csv"}, "search": {"no-matching-export-fixture"}})
			var expected strings.Builder
			if err := writeAdminCSV(&expected, kind, nil); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || w.Body.String() != expected.String() || w.Header().Get("Content-Type") != "text/csv; charset=utf-8" {
				t.Fatal(kind, "empty CSV", w.Code, w.Header(), w.Body)
			}
			disposition := w.Header().Get("Content-Disposition")
			if !strings.HasPrefix(disposition, `attachment; filename="`) || !strings.HasSuffix(disposition, `.csv"`) {
				t.Fatal("CSV disposition", disposition)
			}
		}
		for _, kind := range []string{"repos", "users", "conferences"} {
			for _, values := range []url.Values{{"search[]": {"fixture"}}, {"search": {"fixture", "other"}}} {
				w := call(kind, token, values)
				if w.Code != 500 {
					t.Fatal("search shape", kind, w.Code, w.Body)
				}
			}
			if kind != "users" {
				w := call(kind, token, url.Values{"search": {"admin-filter-fixture-"}, "ready[]": {"true"}})
				var out M
				if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 || len(arr(out["results"])) != 1 || str(obj(arr(out["results"])[0])["status"]) != "ready" {
					t.Fatal("array flag", kind, w.Code, w.Body)
				}
			}
		}
		csv := call("users", token, url.Values{"format": {"csv"}, "search": {"admin-filter-owner"}})
		if csv.Code != 200 || !strings.Contains(csv.Body.String(), "admin-filter-owner") || strings.Contains(csv.Body.String(), security.HashToken(token)) || strings.Contains(csv.Body.String(), token) {
			t.Fatal("user CSV", csv.Code, csv.Body)
		}
		w := call("repos", token, url.Values{"owner": {"does-not-exist"}, "search": {prefix}})
		var out M
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || number(out["total"]) != 0 || len(arr(out["results"])) != 0 {
			t.Fatal("unknown owner matched ownerless fixtures", w.Code, w.Body)
		}
		w = call("users", token, url.Values{"search": {"admin-filter-owner"}})
		// Decode into a fresh map because absent response fields must stay absent.
		out = M{}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || number(out["total"]) != 1 {
			t.Fatal(w.Code, w.Body)
		}
		if _, ok := out["totalSize"]; ok {
			t.Fatal("users include repository storage total")
		}
		for _, value := range arr(out["results"]) {
			row := obj(value)
			if row["apiTokens"] != nil || row["accessTokens"] != nil {
				t.Fatal("admin list exposed credentials")
			}
		}
	})
}
