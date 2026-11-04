package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runSettingsLifecycleIntegration(t *testing.T, s *Server, p *fixtureProvider, token string) {
	t.Run("unchanged source settings lifecycle", func(t *testing.T) {
		ctx := context.Background()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		p.revoked = true
		defer func() { p.revoked = false }()
		before := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		call := func(id string, options M) *httptest.ResponseRecorder {
			source := obj(original["source"])
			body := M{"repoId": id, "fullName": source["repositoryName"], "source": M{"branch": source["branch"], "commit": source["commit"]}, "terms": []any{"new term"}, "options": options}
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest("POST", "/api/repo/"+id, bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.5:1234"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		insert := func(id, status string) M {
			t.Helper()
			r := selectFields(original, "owner", "source", "providerAccess", "options")
			r["_id"], r["repoId"], r["status"], r["anonymizeDate"], r["statusDate"] = bson.NewObjectID(), id, status, before, before
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
				t.Fatal(err)
			}
			return r
		}
		for i, c := range reactivationCases(t) {
			id := fmt.Sprintf("settings-lifecycle-%d", i)
			insert(id, c.Status)
			blocked := c.Status == "archived" || c.Status == "removing" || c.Status == "expiring"
			liveJob := c.Status == "preparing" || c.Status == "queue" || c.Status == "download"
			if liveJob {
				if err := s.enqueue(ctx, "repo", id, "prepare"); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Store.update(ctx, "gojobs", M{"_id": "repo:" + id + ":prepare"}, M{"$set": M{"state": "active", "attempts": 2}}); err != nil {
					t.Fatal(err)
				}
			}
			w := call(id, c.Options)
			if blocked {
				if w.Code != 409 {
					t.Fatalf("%s: %d %s", c.Name, w.Code, w.Body)
				}
				continue
			}
			want := c.Status
			if c.Expected {
				want = "preparing"
			}
			var response M
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || response["status"] != want {
				t.Fatalf("%s: %d %s", c.Name, w.Code, w.Body)
			}
			current, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(current["source"], original["source"]) || !reflect.DeepEqual(current["providerAccess"], original["providerAccess"]) {
				t.Fatal("source or binding changed", c.Name)
			}
			if !date(current["settingsSavedAt"]).After(before) {
				t.Fatal("settings timestamp missing", c.Name)
			}
			if c.Expected {
				if !date(current["anonymizeDate"]).After(before) || current["statusMessage"] != nil {
					t.Fatal("reactivation metadata", c.Name, current)
				}
			} else if !date(current["anonymizeDate"]).Equal(before) || !date(current["statusDate"]).Equal(before) {
				t.Fatal("settings edit changed lifecycle", c.Name, current)
			}
			job, err := s.Store.one(ctx, "gojobs", M{"_id": "repo:" + id + ":prepare"})
			if err != nil {
				t.Fatal(err)
			}
			if liveJob {
				if job["state"] != "active" || number(job["attempts"]) != 2 {
					t.Fatal("active job changed", c.Name, job)
				}
			} else if c.Expected {
				if job == nil || job["state"] != "waiting" {
					t.Fatal("reactivation not queued", c.Name, job)
				}
			} else if job != nil {
				t.Fatal("unnecessary preparation", c.Name, job)
			}
		}
		id := "settings-reactivation-failure"
		insert(id, "removed")
		command := func(v M) error {
			return s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "gojobs"}, {Key: "validator", Value: v}, {Key: "validationLevel", Value: "strict"}, {Key: "validationAction", Value: "error"}}).Err()
		}
		if err := command(M{"_id": M{"$ne": "repo:" + id + ":prepare"}}); err != nil {
			t.Fatal(err)
		}
		defer command(M{})
		if w := call(id, M{"expirationMode": "never"}); w.Code != 500 {
			t.Fatal(w.Code, w.Body)
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"repoId": id})
		if err != nil || current["status"] != "error" || current["statusMessage"] != "preparation_interrupted" {
			t.Fatal("failed enqueue stranded reactivation", current, err)
		}
	})
}
