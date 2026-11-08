package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runConferenceRecoveryIntegration(t *testing.T, s *Server, token string, owner any) {
	t.Run("membership replay retains save time after failure", func(t *testing.T) {
		ctx := context.Background()
		original, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		r := selectFields(original, "source", "providerAccess", "options")
		r["_id"], r["repoId"], r["owner"], r["status"], r["conference"] = bson.NewObjectID(), "membership-recovery", owner, "ready", "recovery-a"
		r["settingsSavedAt"] = time.Now().Add(-time.Hour).Truncate(time.Millisecond)
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{"recovery-a", "recovery-b"} {
			history := []any{}
			if id == "recovery-a" {
				history = append(history, M{"id": r["_id"], "addDate": r["settingsSavedAt"]})
			}
			c := M{"_id": bson.NewObjectID(), "conferenceID": id, "owners": []any{owner}, "status": "ready", "startDate": time.Now().Add(-time.Hour), "endDate": time.Now().Add(time.Hour), "repositories": history}
			if _, err := s.Store.DB.Collection("conferences").InsertOne(ctx, c); err != nil {
				t.Fatal(err)
			}
		}
		call := func(to string) *httptest.ResponseRecorder {
			source := obj(r["source"])
			body := M{"repoId": r["repoId"], "fullName": source["repositoryName"], "source": M{"provider": "fixture", "branch": source["branch"], "commit": source["commit"]}, "terms": []any{}, "options": M{"expirationMode": "never"}, "conference": to}
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest("POST", "/api/repo/membership-recovery", bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.14:1234"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		validator := func(v M) error {
			return s.Store.DB.RunCommand(ctx, bson.D{{Key: "collMod", Value: "conferences"}, {Key: "validator", Value: v}, {Key: "validationLevel", Value: "strict"}, {Key: "validationAction", Value: "error"}}).Err()
		}
		if err := validator(M{"reject_test_write": M{"$exists": true}}); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := validator(M{}); err != nil {
				t.Error(err)
			}
		}()
		if w := call("recovery-b"); w.Code != 500 {
			t.Fatal(w.Code, w.Body)
		}
		pending, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		event := obj(pending["conferenceMembership"])
		at := date(event["at"])
		if pending["conference"] != "recovery-b" || at.IsZero() || event["from"] != "recovery-a" || event["to"] != "recovery-b" {
			t.Fatal(pending)
		}
		if err := validator(M{}); err != nil {
			t.Fatal(err)
		}
		if err := s.replayConferenceMemberships(ctx, ""); err != nil {
			t.Fatal(err)
		}
		read := func(id string) M {
			t.Helper()
			c, err := s.Store.one(ctx, "conferences", M{"conferenceID": id})
			if err != nil {
				t.Fatal(err)
			}
			rows := arr(c["repositories"])
			if len(rows) != 1 {
				t.Fatal(id, rows)
			}
			return obj(rows[0])
		}
		if !date(read("recovery-a")["removeDate"]).Equal(at) || !date(read("recovery-b")["addDate"]).Equal(at) {
			t.Fatal("replay changed event time")
		}
		current, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if current["conferenceMembership"] != nil {
			t.Fatal("completed event remains")
		}
		if w := call("recovery-a"); w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		latest := date(read("recovery-a")["addDate"])
		if !latest.After(at) {
			t.Fatal("transition timestamps did not increase")
		}
		if err := s.flushConferenceMembership(ctx, pending); err != nil {
			t.Fatal(err)
		}
		if !date(read("recovery-a")["addDate"]).Equal(latest) || !date(read("recovery-a")["removeDate"]).IsZero() || !date(read("recovery-b")["removeDate"]).Equal(latest) {
			t.Fatal("stale replay changed newer membership")
		}
		if _, err := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"status": "removed"}}); err != nil {
			t.Fatal(err)
		}
		c, err := s.Store.one(ctx, "conferences", M{"conferenceID": "recovery-a"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.reconcileConference(ctx, c); err != nil {
			t.Fatal(err)
		}
		if !date(read("recovery-a")["removeDate"]).IsZero() {
			t.Fatal("repository status rewrote membership history")
		}
	})
}
