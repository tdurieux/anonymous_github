package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestFolderQuery(t *testing.T) {
	for _, raw := range []string{"", "path="} {
		if got, err := folderQuery(raw); err != nil || got != "" {
			t.Fatal(raw, got, err)
		}
	}
	for _, raw := range []string{"path[]=docs", "path[x]=docs", "path=docs&path=other", "path[]="} {
		if _, err := folderQuery(raw); err == nil {
			t.Fatal(raw, "accepted non-scalar")
		}
	}
	if got, err := folderQuery("path=docs%2Fchild"); err != nil || got != "docs/child" {
		t.Fatal(got, err)
	}
}

func runFolderPathIntegration(t *testing.T, s *Server) {
	t.Run("folder path resolution", func(t *testing.T) {
		ctx := t.Context()
		id := "folder-" + bson.NewObjectID().Hex()
		repo := M{"repoId": id, "status": "ready", "treeGeneration": "fixture", "options": M{"terms": []string{"alice => shared", "bob => shared"}, "expirationMode": "never"}}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		for _, row := range []M{
			{"path": "", "name": "alice"}, {"path": "", "name": "bob"},
			{"path": "alice", "name": "first.txt", "size": 1}, {"path": "bob", "name": "second.txt", "size": 2},
		} {
			row["repoId"], row["treeGeneration"] = id, "fixture"
			if _, err := s.Store.DB.Collection("files").InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		call := func(query string, status int) []M {
			t.Helper()
			r := httptest.NewRequest("GET", "/api/repo/"+id+"/files?"+query, nil)
			r.RemoteAddr = "198.51.100.65:1234"
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != status {
				t.Fatal(query, w.Code, w.Body)
			}
			if status != 200 {
				return nil
			}
			var rows []M
			if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
				t.Fatal(err)
			}
			return rows
		}
		for _, requested := range []string{"alice", "alice/", "alice//", "./alice/", "shared"} {
			rows := call("path="+url.QueryEscape(requested), 200)
			if len(rows) != 1 || rows[0]["name"] != "first.txt" || rows[0]["path"] != "shared" || rows[0]["sha"] != "da39a3ee" {
				t.Fatal(requested, rows)
			}
		}
		rows := call("path=bob", 200)
		if len(rows) != 1 || rows[0]["name"] != "second.txt" {
			t.Fatal(rows)
		}
		call("path=missing", 404)
		for _, query := range []string{"path[]=alice", "path[x]=alice", "path=alice&path=bob", "path[]="} {
			call(query, 500)
		}
		// An exact original folder wins over a replacement collision.
		for _, row := range []M{{"path": "", "name": "shared"}, {"path": "shared", "name": "exact.txt", "size": 3}} {
			row["repoId"], row["treeGeneration"] = id, "fixture"
			if _, err := s.Store.DB.Collection("files").InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		rows = call("path=shared", 200)
		if len(rows) != 1 || rows[0]["name"] != "exact.txt" {
			t.Fatal(rows)
		}
		// Compare the full output to the actual TypeScript tree projection.
		var fixture struct {
			Files    []M
			Expected []M
		}
		raw, err := os.ReadFile("testdata/folder-listing.json")
		if err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(raw, &fixture); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id}); err != nil {
			t.Fatal(err)
		}
		for _, row := range fixture.Files {
			row["repoId"], row["treeGeneration"] = id, "fixture"
			if _, err = s.Store.DB.Collection("files").InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		actual := call("", 200)
		byName := map[string]M{}
		for _, row := range actual {
			byName[str(row["name"])] = row
		}
		if len(actual) != len(fixture.Expected) {
			t.Fatal(actual)
		}
		for _, expected := range fixture.Expected {
			if !reflect.DeepEqual(byName[str(expected["name"])], expected) {
				t.Fatal(actual, fixture.Expected)
			}
		}
		// Restore a directory to check default-mask and raw-path resolution.
		for _, row := range []M{{"path": "", "name": "alice"}, {"path": "alice", "name": "first.txt", "size": 1}} {
			row["repoId"], row["treeGeneration"] = id, "fixture"
			if _, err = s.Store.DB.Collection("files").InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		// Without custom terms, an ordinary unknown folder is an empty listing.
		if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"options.terms": []string{"alice"}}}); err != nil {
			t.Fatal(err)
		}
		if rows := call("path=missing", 200); len(rows) != 0 {
			t.Fatal(rows)
		}
		if rows := call("path=alice%2F", 200); len(rows) != 0 {
			t.Fatal("unresolved scalar path was normalized", rows)
		}
		rows = call("path=alice", 200)
		if len(rows) != 1 || rows[0]["name"] != "first.txt" {
			t.Fatal(rows)
		}
		rows = call("path="+url.QueryEscape(s.Config.Mask+"-1"), 200)
		if len(rows) != 1 || rows[0]["name"] != "first.txt" {
			t.Fatal(rows)
		}
	})
}

func TestFolderPathParts(t *testing.T) {
	raw, err := os.ReadFile("testdata/folder-paths.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Requested, Directory, Name string }
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		directory, name := folderPathParts(c.Requested)
		if directory != c.Directory || name != c.Name {
			t.Fatal(c, directory, name)
		}
	}
}
