package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type fileSearchFixture struct {
	Files []M
	Cases []struct {
		Query    string
		Expected []M
		Error    bool
	}
}

func readFileSearchFixture(t *testing.T) fileSearchFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/file-search.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture fileSearchFixture
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}
func TestFileSearchContracts(t *testing.T) {
	fixture := readFileSearchFixture(t)
	for _, row := range fixture.Cases {
		query, usable, err := fileSearchQuery(row.Query)
		if (err != nil) != row.Error {
			t.Fatal(row, err)
		}
		if row.Error {
			continue
		}
		result := []M{}
		lower := cases.Lower(language.Und)
		if usable {
			for _, file := range fixture.Files {
				if strings.Contains(lower.String(str(file["path"])+"/"+str(file["name"])), query) {
					result = append(result, file)
				}
			}
		}
		if !reflect.DeepEqual(result, row.Expected) {
			t.Fatal(row.Query, result, row.Expected)
		}
	}
}
func runFileSearchIntegration(t *testing.T, s *Server) {
	t.Run("file search query and Unicode contracts", func(t *testing.T) {
		ctx := t.Context()
		fixture := readFileSearchFixture(t)
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil || original == nil {
			t.Fatal(err)
		}
		repo := selectFields(original, "owner", "source", "providerAccess")
		id := "search-" + bson.NewObjectID().Hex()
		repo["_id"], repo["repoId"], repo["status"], repo["treeGeneration"] = bson.NewObjectID(), id, "ready", "search-fixture"
		repo["options"] = M{"terms": []string{}, "expirationMode": "never"}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		for _, file := range fixture.Files {
			doc := selectFields(file, "name", "path", "size")
			doc["repoId"], doc["treeGeneration"] = id, "search-fixture"
			if _, err := s.Store.DB.Collection("files").InsertOne(ctx, doc); err != nil {
				t.Fatal(err)
			}
		}
		call := func(query string) *httptest.ResponseRecorder {
			r := httptest.NewRequest("GET", "/api/repo/"+id+"/files/search?"+query, nil)
			r.RemoteAddr = "198.51.100.63:1234"
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			return w
		}
		for _, row := range fixture.Cases {
			w := call(row.Query)
			status, cacheControl := 200, "no-cache"
			if row.Error {
				status, cacheControl = 500, "no-store"
			}
			if w.Code != status || w.Header().Get("Cache-Control") != cacheControl {
				t.Fatal(row.Query, w.Code, w.Header(), w.Body)
			}
			if row.Error {
				continue
			}
			var result []M
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(result, row.Expected) {
				t.Fatal(row.Query, result, row.Expected)
			}
		}
		if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"status": "archived"}}); err != nil {
			t.Fatal(err)
		}
		for _, query := range []string{"q=a", "q=README", "q[]=README"} {
			if w := call(query); w.Code != 410 {
				t.Fatal("query bypassed archived repository check", query, w.Code, w.Body)
			}
		}
	})
}
