package server

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"net/http/httptest"
	"testing"
	"time"
)

func runExtensionIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, token string, source M) {
	ctx := context.Background()
	calls := 0
	p.onDocument = func() { calls++ }
	p.onRepository = func() { calls++ }
	defer func() { p.onDocument = nil; p.onRepository = nil }()
	for _, kind := range []string{"repo", "gist", "pr"} {
		for _, status := range []string{"ready", "queue", "download", "expired", "error", "preparing", "removing", "expiring", "removed", "archived"} {
			t.Run("extend/"+kind+"/"+status, func(t *testing.T) {
				r := M{}
				for k, v := range source {
					r[k] = v
				}
				r["_id"] = bson.NewObjectID()
				id := "extend-" + kind + "-" + status
				r[idKey(kind)] = id
				r["status"] = status
				r["statusDate"] = time.Now()
				r["options"] = M{"expirationMode": "redirect", "expirationDate": time.Date(2099, 8, 31, 12, 0, 0, 0, time.UTC), "terms": []string{}}
				if kind != "repo" {
					r["source"] = M{"provider": "fixture", "gistId": "snippet", "repositoryFullName": p.name, "pullRequestId": 1}
				}
				if _, e := s.Store.DB.Collection(collection(kind)).InsertOne(ctx, r); e != nil {
					t.Fatal(e)
				}
				calls = 0
				w := call("POST", "/api/"+kind+"/"+id+"/extend", token, nil)
				expected := 200
				switch status {
				case "preparing", "removing", "expiring", "removed":
					expected = 409
				case "archived":
					expected = 410
				}
				if w.Code != expected {
					t.Fatal(w.Code, w.Body)
				}
				current, e := s.Store.one(ctx, collection(kind), M{"_id": r["_id"]})
				if e != nil {
					t.Fatal(e)
				}
				if expected != 200 {
					if calls != 0 || str(current["status"]) != status {
						t.Fatal("invalid state modified", calls, current)
					}
					return
				}
				wantStatus := status
				wantCalls := 0
				if kind != "repo" {
					wantStatus = "ready"
					wantCalls = 1
				} else if status == "expired" {
					wantStatus = "preparing"
				}
				if calls != wantCalls || str(current["status"]) != wantStatus {
					t.Fatal("wrong reactivation", calls, current)
				}
				wantDate := time.Date(2100, 3, 3, 12, 0, 0, 0, time.UTC)
				if !date(obj(current["options"])["expirationDate"]).Equal(wantDate) {
					t.Fatal("month overflow differs", current["options"])
				}
				if kind == "repo" && str(obj(current["source"])["commit"]) != str(obj(r["source"])["commit"]) {
					t.Fatal("reactivation changed saved commit")
				}
				if kind != "repo" && !date(current["settingsSavedAt"]).Equal(date(r["settingsSavedAt"]).Truncate(time.Millisecond)) {
					t.Fatal("embedded extension changed settings timestamp")
				}
			})
		}
	}
	t.Run("reactivation enqueue failure is retryable and preserves concurrent removal", func(t *testing.T) {
		r := M{}
		for k, v := range source {
			r[k] = v
		}
		r["_id"] = bson.NewObjectID()
		r["repoId"] = "extension-failure"
		r["status"] = "expired"
		r["statusDate"] = time.Now()
		if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		command := func(v M) error {
			return s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: v}}).Err()
		}
		if e := command(M{"_id": M{"$ne": "repo:extension-failure:prepare"}}); e != nil {
			t.Fatal(e)
		}
		defer func() {
			if e := command(M{}); e != nil {
				t.Error(e)
			}
		}()
		w := call("POST", "/api/repo/extension-failure/extend", token, nil)
		if w.Code != 500 {
			t.Fatal(w.Code, w.Body)
		}
		current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if e != nil || str(current["status"]) != "error" || str(current["statusMessage"]) != "preparation_interrupted" {
			t.Fatal("reactivation stranded", current, e)
		}
		// The same helper also handles ordinary saves; an older request cannot overwrite removal.
		stale := M{}
		for k, v := range current {
			stale[k] = v
		}
		stale["status"] = "preparing"
		if _, e = s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removing"}}); e != nil {
			t.Fatal(e)
		}
		if e = s.enqueueSavedSnapshot(ctx, stale); e == nil {
			t.Fatal("expected real enqueue rejection")
		}
		current, e = s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if e != nil || str(current["status"]) != "removing" {
			t.Fatal("failed enqueue overwrote removal", current, e)
		}
	})
}
