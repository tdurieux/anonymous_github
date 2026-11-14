package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runConferenceLifecycleIntegration(t *testing.T, s *Server, token string, owner any) {
	t.Run("conference expiry uses open membership and preserves inactive repositories", func(t *testing.T) {
		ctx := context.Background()
		before := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		conf := M{"_id": bson.NewObjectID(), "conferenceID": "conference-expiry", "name": "Expired conference", "owners": []any{owner}, "status": "ready", "startDate": before.Add(-time.Hour), "endDate": before, "plan": M{"pricePerRepository": 0}}
		history := []any{}
		repositories := []M{}
		states := []string{"ready", "preparing", "queue", "download", "error", "archived", "removed", "removing", "expired", "expiring"}
		for _, state := range states {
			row := M{"_id": bson.NewObjectID(), "repoId": "conference-expiry-" + state, "owner": owner, "status": state, "statusDate": before, "conference": conf["conferenceID"], "options": M{"expirationMode": "never"}}
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
			history = append(history, M{"id": row["_id"], "addDate": before.Add(-time.Hour)})
			repositories = append(repositories, row)
		}
		for _, name := range []string{"closed", "closed-zero", "closed-epoch", "not-member"} {
			row := M{"_id": bson.NewObjectID(), "repoId": "conference-expiry-" + name, "owner": owner, "status": "ready", "statusDate": before, "conference": conf["conferenceID"]}
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
			if name != "not-member" {
				removed := before
				if name == "closed-zero" {
					removed = time.Time{}
				}
				if name == "closed-epoch" {
					removed = time.UnixMilli(0)
				}
				history = append(history, M{"id": row["_id"], "addDate": time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC), "removeDate": removed})
			}
			repositories = append(repositories, row)
		}
		conf["repositories"] = history
		if _, err := s.Store.DB.Collection("conferences").InsertOne(ctx, conf); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("GET", "/api/conferences", nil)
		req.RemoteAddr = "198.51.100.11:1234"
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		var output []M
		if err := json.Unmarshal(w.Body.Bytes(), &output); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, c := range output {
			if c["conferenceID"] == conf["conferenceID"] {
				found = true
				if c["status"] != "expired" {
					t.Fatal(c)
				}
			}
		}
		if !found {
			t.Fatal("conference absent from response")
		}
		for i, original := range repositories {
			current, err := s.Store.one(ctx, collection("repo"), M{"_id": original["_id"]})
			if err != nil {
				t.Fatal(err)
			}
			want := str(original["status"])
			if i < 5 {
				want = "expiring"
			}
			if current["status"] != want {
				t.Fatal(original["repoId"], current["status"], want)
			}
			if i < 5 {
				if !date(current["statusDate"]).After(before) {
					t.Fatal("missing expiry timestamp", current)
				}
			} else if !date(current["statusDate"]).Equal(before) {
				t.Fatal("inactive or non-member timestamp changed", current)
			}
		}
		saved, err := s.Store.one(ctx, "conferences", M{"_id": conf["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if saved["status"] != "expired" {
			t.Fatal(saved)
		}
		// An already expired conference must not affect a repository restored later.
		restored := repositories[0]
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": restored["_id"]}, M{"$set": M{"status": "ready", "statusDate": before}}); err != nil {
			t.Fatal(err)
		}
		if err := s.expireConference(ctx, saved); err != nil {
			t.Fatal(err)
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"_id": restored["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if current["status"] != "ready" {
			t.Fatal("repeat expiry changed restored repository")
		}
	})
}

func runConferenceRemovalIntegration(t *testing.T, s *Server, token, otherToken string, owner any) {
	t.Run("conference removal completes cleanup and continues after member failures", func(t *testing.T) {
		ctx := context.Background()
		call := func(id, auth string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("DELETE", "/api/conferences/"+id, nil)
			req.RemoteAddr = "198.51.100.12:1234"
			req.Header.Set("Authorization", "Bearer "+auth)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		for _, broken := range []bool{false, true} {
			id := "conference-remove-success"
			if broken {
				id = "conference-remove-partial"
			}
			history := []any{}
			rows := []M{}
			for _, name := range []string{"first", "second", "closed", "closed-zero", "closed-epoch"} {
				state := "ready"
				if broken && name == "first" {
					state = "archived"
				}
				r := M{"_id": bson.NewObjectID(), "repoId": id + "-" + name, "owner": owner, "status": state, "conference": id}
				if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
					t.Fatal(err)
				}
				entry := M{"id": r["_id"], "addDate": time.Now().Add(-time.Hour)}
				if strings.HasPrefix(name, "closed") {
					entry["removeDate"] = time.Now()
					if name == "closed-zero" {
						entry["removeDate"] = time.Time{}
					}
					if name == "closed-epoch" {
						entry["removeDate"] = time.UnixMilli(0)
					}
				}
				history = append(history, entry)
				rows = append(rows, r)
				if err := s.content.Put(ctx, str(r["repoId"]), "raw", strings.NewReader("raw"), 3, 3); err != nil {
					t.Fatal(err)
				}
				for _, coll := range []string{"files", "anonymizedpaths"} {
					if _, err := s.Store.DB.Collection(coll).InsertOne(ctx, M{"repoId": r["repoId"], "path": "", "name": "raw"}); err != nil {
						t.Fatal(err)
					}
				}
			}
			conf := M{"_id": bson.NewObjectID(), "conferenceID": id, "owners": []any{owner}, "status": "ready", "repositories": history}
			if _, err := s.Store.DB.Collection("conferences").InsertOne(ctx, conf); err != nil {
				t.Fatal(err)
			}
			if w := call(id, otherToken); w.Code != 401 {
				t.Fatal(w.Code, w.Body)
			}
			w := call(id, token)
			expected := 200
			if broken {
				expected = 500
			}
			if w.Code != expected {
				t.Fatal(w.Code, w.Body)
			}
			current, err := s.Store.one(ctx, "conferences", M{"_id": conf["_id"]})
			if err != nil || current["status"] != "removed" {
				t.Fatal(current, err)
			}
			for i, r := range rows {
				cleaned := i < 2 && !(broken && i == 0)
				current, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
				if err != nil {
					t.Fatal(err)
				}
				want := r["status"]
				if cleaned {
					want = "removed"
				}
				if current["status"] != want {
					t.Fatal(r["repoId"], current["status"], want)
				}
				for _, coll := range []string{"files", "anonymizedpaths"} {
					count, err := s.Store.DB.Collection(coll).CountDocuments(ctx, M{"repoId": r["repoId"]})
					if err != nil {
						t.Fatal(err)
					}
					wantCount := int64(1)
					if cleaned {
						wantCount = 0
					}
					if count != wantCount {
						t.Fatal(coll, count, wantCount)
					}
				}
				entries, err := s.content.List(ctx, str(r["repoId"]))
				if err != nil && !errors.Is(err, fs.ErrNotExist) {
					t.Fatal(err)
				}
				if cleaned && len(entries) != 0 {
					t.Fatal("storage remains after successful removal")
				}
				if !cleaned && len(entries) == 0 {
					t.Fatal("protected content removed")
				}
			}
			if !broken {
				if w := call(id, token); w.Code != 200 {
					t.Fatal("repeat conference removal", w.Code, w.Body)
				}
			}
		}
	})
}
