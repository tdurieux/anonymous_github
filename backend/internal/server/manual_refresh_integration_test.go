package server

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func runManualRefreshIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, token string, source M) {
	ctx := context.Background()
	for _, state := range []string{"waiting", "active", "completed", "failed", "absent"} {
		t.Run("manual refresh job/"+state, func(t *testing.T) {
			r := M{}
			for k, v := range source {
				r[k] = v
			}
			r["_id"] = bson.NewObjectID()
			id := "manual-" + state
			r["repoId"] = id
			r["status"] = "ready"
			r["statusDate"] = time.Now()
			r["anonymizeDate"] = time.Now().Add(-time.Hour)
			if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
				t.Fatal(e)
			}
			key := "repo:" + id + ":prepare"
			if state != "absent" {
				if _, e := s.Store.DB.Collection("gojobs").InsertOne(ctx, M{"_id": key, "kind": "repo", "resourceId": id, "action": "prepare", "state": state, "finishedAt": time.Now()}); e != nil {
					t.Fatal(e)
				}
			}
			calls := 0
			p.onRepository = func() { calls++ }
			defer func() { p.onRepository = nil }()
			w := call("POST", "/api/repo/"+id+"/refresh", token, nil)
			expected := 200
			if state == "waiting" || state == "active" {
				expected = 409
			}
			if w.Code != expected {
				t.Fatal(w.Code, w.Body)
			}
			current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
			if e != nil {
				t.Fatal(e)
			}
			if str(current["status"]) != "ready" || current["refreshToken"] != nil || !date(current["anonymizeDate"]).Equal(date(r["anonymizeDate"]).Truncate(time.Millisecond)) {
				t.Fatal("unchanged repository modified or lease leaked", current)
			}
			if expected == 409 && calls != 0 {
				t.Fatal("busy refresh contacted provider")
			}
			if expected == 200 {
				job, e := s.Store.one(ctx, "gojobs", M{"_id": key})
				if e != nil || job != nil {
					t.Fatal("unchanged commit queued", job, e)
				}
			}
		})
	}
	t.Run("manual refresh contention and interrupted preparation", func(t *testing.T) {
		r := M{}
		for k, v := range source {
			r[k] = v
		}
		r["_id"] = bson.NewObjectID()
		r["repoId"] = "manual-failures"
		r["status"] = "error"
		r["statusDate"] = time.Now()
		if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		load := func() M {
			t.Helper()
			v, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
			if e != nil {
				t.Fatal(e)
			}
			return v
		}
		if _, e := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": r["repoId"], "name": "old.txt", "path": "", "size": 4}); e != nil {
			t.Fatal(e)
		}
		oldCache := contentPrefix(r) + "/old.txt"
		if e := s.content.Put(ctx, str(r["repoId"]), oldCache, strings.NewReader("data"), 4, 4); e != nil {
			t.Fatal(e)
		}
		url := "/api/repo/manual-failures/refresh"
		set := func(v M) {
			t.Helper()
			if _, e := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": v}); e != nil {
				t.Fatal(e)
			}
		}
		set(M{"refreshToken": "another", "refreshUntil": time.Now().Add(time.Minute)})
		w := call("POST", url, token, nil)
		if w.Code != 409 || str(load()["refreshToken"]) != "another" {
			t.Fatal("competing lease altered", w.Code, w.Body)
		}
		set(M{"refreshUntil": time.Now().Add(-time.Minute)})
		p.onRepository = func() {
			nested := call("POST", url, token, nil)
			if nested.Code != 409 {
				t.Fatal("overlapping refresh accepted", nested.Code, nested.Body)
			}
		}
		defer func() { p.onRepository = nil; p.missingBranch = false }()
		// Reject this specific enqueue at MongoDB so the real error path is exercised.
		validator := M{"_id": M{"$ne": "repo:manual-failures:prepare"}}
		if e := s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: validator}, {Key: "validationLevel", Value: "strict"}, {Key: "validationAction", Value: "error"}}).Err(); e != nil {
			t.Fatal(e)
		}
		defer s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: M{}}})
		w = call("POST", url, token, nil)
		if w.Code != 500 {
			t.Fatal("enqueue failure hidden", w.Code, w.Body)
		}
		current := load()
		if str(current["status"]) != "error" || str(current["statusMessage"]) != "preparation_interrupted" || current["refreshToken"] != nil {
			t.Fatal("interrupted refresh not retryable", current)
		}
		rows, e := s.Store.list(ctx, "files", M{"repoId": r["repoId"]}, 100, nil)
		if e != nil || len(rows) != 0 {
			t.Fatal("interrupted refresh retained old tree", rows, e)
		}
		cached, cacheErr := s.content.Read(ctx, str(r["repoId"]), oldCache)
		if cached != nil {
			cached.Close()
		}
		if cacheErr == nil {
			t.Fatal("interrupted refresh retained old cache")
		}
		if e := s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: M{}}}).Err(); e != nil {
			t.Fatal(e)
		}
		p.onRepository = nil
		w = call("POST", url, token, nil)
		if w.Code != 200 || str(load()["status"]) != "preparing" {
			t.Fatal("retry failed", w.Code, w.Body)
		}
		set(M{"status": "ready", "statusDate": time.Now()})
		if _, e := s.Store.update(ctx, "gojobs", M{"_id": "repo:manual-failures:prepare"}, M{"$set": M{"state": "completed", "finishedAt": time.Now()}}); e != nil {
			t.Fatal(e)
		}
		p.onRepository = func() { set(M{"refreshToken": "replacement", "refreshUntil": time.Now().Add(time.Minute)}) }
		w = call("POST", url, token, nil)
		if w.Code != 409 || str(load()["refreshToken"]) != "replacement" || str(load()["status"]) != "ready" {
			t.Fatal("replacement lease overwritten", w.Code, w.Body, load())
		}

	})
}
