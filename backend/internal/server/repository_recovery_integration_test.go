package server

import (
	"context"
	"errors"
	"go.mongodb.org/mongo-driver/v2/bson"
	"net/http/httptest"
	"testing"
	"time"
)

func runRepositoryRecoveryIntegration(t *testing.T, s *Server, call func(string, string, string, any) *httptest.ResponseRecorder, token string, source M) {
	t.Helper()
	ctx := context.Background()
	for _, status := range []string{"error", "preparing", "download", "queue", "removed", "removing", "expired", "expiring", "archived"} {
		for _, stale := range []bool{false, true} {
			t.Run("repository recovery/"+status+"/"+map[bool]string{true: "stale", false: "fresh"}[stale], func(t *testing.T) {
				r := M{}
				for k, v := range source {
					r[k] = v
				}
				r["_id"] = bson.NewObjectID()
				id := "recovery-" + str(r["_id"])
				r["repoId"] = id
				r["status"] = status
				stamp := time.Now()
				if stale {
					stamp = stamp.Add(-10 * time.Minute)
				}
				r["statusDate"] = stamp
				r["statusMessage"] = "old_failure"
				if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
					t.Fatal(e)
				}
				// Authenticated owners may inspect options without triggering recovery.
				w := call("GET", "/api/repo/"+id+"/options", token, nil)
				wantOwner := 200
				if status == "archived" {
					wantOwner = 410
				}
				if w.Code != wantOwner {
					t.Fatal("owner options", w.Code, w.Body)
				}
				w = call("GET", "/api/repo/"+id+"/options", "", nil)
				expected := 425
				switch status {
				case "removed", "removing", "expired", "expiring", "archived":
					expected = 410
				case "error":
					if !stale {
						expected = 500
					}
				}
				if w.Code != expected {
					t.Fatal(w.Code, w.Body)
				}
				current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
				if e != nil {
					t.Fatal(e)
				}
				job, e := s.Store.one(ctx, "gojobs", M{"_id": "repo:" + id + ":prepare"})
				if e != nil {
					t.Fatal(e)
				}
				recover := stale && (status == "error" || status == "preparing" || status == "download")
				if recover {
					if str(current["status"]) != "preparing" || current["statusMessage"] != nil || job == nil || str(job["state"]) != "waiting" {
						t.Fatal("recovery not scheduled", current, job)
					}
					// A duplicate view must not reset queue attempts or enqueue another job.
					s.Store.update(ctx, "gojobs", M{"_id": job["_id"]}, M{"$set": M{"attempts": 2}})
					w = call("GET", "/api/repo/"+id+"/options", "", nil)
					if w.Code != 425 {
						t.Fatal(w.Code, w.Body)
					}
					job, e = s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
					if e != nil || number(job["attempts"]) != 2 {
						t.Fatal("duplicate recovery reset job", job, e)
					}
				} else if str(current["status"]) != status || job != nil {
					t.Fatal("protected state changed", current, job)
				}
			})
		}
	}
	t.Run("repository recovery date presence", func(t *testing.T) {
		for _, tc := range []struct {
			name    string
			stamp   any
			recover bool
		}{
			{"zero", time.Time{}, true}, {"epoch", time.UnixMilli(0), true}, {"missing", nil, false}, {"invalid", "invalid", false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				r := M{}
				for k, v := range source {
					r[k] = v
				}
				r["_id"] = bson.NewObjectID()
				r["repoId"] = "date-recovery-" + str(r["_id"])
				r["status"] = "error"
				r["statusDate"] = tc.stamp
				if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
					t.Fatal(err)
				}
				defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"_id": r["_id"]})
				defer s.Store.DB.Collection("gojobs").DeleteMany(ctx, M{"resourceId": r["repoId"]})
				err := s.repositoryOptionsCheck(ctx, r)
				var api *APIError
				want := 500
				if tc.recover {
					want = 425
				}
				if !errors.As(err, &api) || api.Status != want {
					t.Fatal("recovery response", err)
				}
				job, err := s.Store.one(ctx, "gojobs", M{"resourceId": r["repoId"]})
				if err != nil || (job != nil) != tc.recover {
					t.Fatal("recovery scheduling", job, err)
				}
			})
		}
	})
	t.Run("stale snapshot cannot recover a removed repository", func(t *testing.T) {
		r := M{}
		for k, v := range source {
			r[k] = v
		}
		r["_id"] = bson.NewObjectID()
		r["repoId"] = "stale-recovery-cas"
		r["status"] = "error"
		r["statusDate"] = time.Now().Add(-10 * time.Minute)
		if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		if _, e := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removing", "statusDate": time.Now()}}); e != nil {
			t.Fatal(e)
		}
		e := s.repositoryOptionsCheck(ctx, r)
		var api *APIError
		if !errors.As(e, &api) || api.Status != 409 {
			t.Fatal("stale recovery accepted", e)
		}
	})
}

func runRepositoryRefreshIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, source M) {
	t.Run("repository refresh trigger and retries", func(t *testing.T) {
		ctx := context.Background()
		r := M{}
		for k, v := range source {
			r[k] = v
		}
		r["_id"] = bson.NewObjectID()
		r["repoId"] = "refresh-trigger"
		r["status"] = "ready"
		r["lastView"] = time.Now().Add(-48 * time.Hour)
		r["options"] = M{"expirationMode": "never", "update": true, "terms": []string{}}
		if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		calls := 0
		oldCommit := p.commit
		p.onRepository = func() { calls++ }
		defer func() { p.onRepository = nil; p.commit = oldCommit; p.revoked = false }()
		load := func() M {
			t.Helper()
			v, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
			if e != nil {
				t.Fatal(e)
			}
			return v
		}
		w := call("GET", "/api/repo/refresh-trigger/files", "", nil)
		if w.Code != 200 || calls != 0 {
			t.Fatal("file read triggered refresh", w.Code, calls, w.Body)
		}
		url := "/api/repo/refresh-trigger/options"
		for expected := 1; expected <= 2; expected++ {
			w = call("GET", url, "", nil)
			if w.Code != 200 || calls != expected || load()["goRefreshCheckedAt"] != nil {
				t.Fatal("up-to-date check throttled", w.Code, calls, w.Body)
			}
		}
		p.revoked = true
		w = call("GET", url, "", nil)
		if w.Code != 403 || load()["goRefreshCheckedAt"] != nil {
			t.Fatal("failed refresh retained claim", w.Code, w.Body)
		}
		p.revoked = false
		w = call("GET", url, "", nil)
		if w.Code != 200 || calls != 3 {
			t.Fatal("failed refresh suppressed retry", w.Code, calls, w.Body)
		}
		p.commit = "revision:updated"
		w = call("GET", url, "", nil)
		saved := load()
		if w.Code != 200 || str(saved["status"]) != "preparing" || str(obj(saved["source"])["commit"]) != p.commit || date(saved["anonymizeDate"]).Before(time.Now().Add(-time.Minute)) {
			t.Fatal("changed commit response", w.Code, w.Body, saved)
		}
		if _, e := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "ready"}}); e != nil {
			t.Fatal(e)
		}
		p.onRepository = func() {
			if _, e := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removing", "statusDate": time.Now()}}); e != nil {
				t.Fatal(e)
			}
		}
		w = call("GET", url, "", nil)
		if w.Code != 409 || str(load()["status"]) != "removing" {
			t.Fatal("refresh overwrote removal", w.Code, w.Body)
		}
	})
}
