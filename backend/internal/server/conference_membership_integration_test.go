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

func runConferenceMembershipIntegration(t *testing.T, s *Server, token string, owner any) {
	t.Run("repository saves update conference history immediately", func(t *testing.T) {
		ctx := context.Background()
		for _, id := range []string{"membership-a", "membership-b"} {
			c := M{"_id": bson.NewObjectID(), "conferenceID": id, "status": "ready", "owners": []any{owner}, "startDate": time.Now().Add(-time.Hour), "endDate": time.Now().Add(time.Hour), "repositories": []any{}}
			if _, err := s.Store.DB.Collection("conferences").InsertOne(ctx, c); err != nil {
				t.Fatal(err)
			}
		}
		template, err := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		source := obj(template["source"])
		body := M{"repoId": "conference-membership-test", "fullName": source["repositoryName"], "source": M{"provider": "fixture", "branch": source["branch"], "commit": source["commit"]}, "terms": []any{}, "options": M{"expirationMode": "never"}}
		save := func(conference string, create bool) {
			t.Helper()
			body["conference"] = conference
			raw, _ := json.Marshal(body)
			url := "/api/repo"
			if !create {
				url += "/conference-membership-test"
			}
			req := httptest.NewRequest("POST", url, bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.13:1234"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
		}
		history := func(id string) []any {
			t.Helper()
			c, err := s.Store.one(ctx, "conferences", M{"conferenceID": id})
			if err != nil {
				t.Fatal(err)
			}
			return arr(c["repositories"])
		}
		save("membership-a", true)
		r, err := s.Store.one(ctx, collection("repo"), M{"repoId": body["repoId"]})
		if err != nil {
			t.Fatal(err)
		}
		a := history("membership-a")
		if len(a) != 1 || str(obj(a[0])["id"]) != str(r["_id"]) || date(obj(a[0])["addDate"]).IsZero() {
			t.Fatal(a)
		}
		first := time.Now().Add(-24 * time.Hour).Truncate(time.Millisecond)
		if _, err := s.Store.update(ctx, "conferences", M{"conferenceID": "membership-a"}, M{"$set": M{"repositories.0.addDate": first}}); err != nil {
			t.Fatal(err)
		}
		save("membership-a", false)
		if !date(obj(history("membership-a")[0])["addDate"]).Equal(first) {
			t.Fatal("unchanged membership reset billing date")
		}
		save("membership-b", false)
		if date(obj(history("membership-a")[0])["removeDate"]).IsZero() || len(history("membership-b")) != 1 {
			t.Fatal("switch did not close old and open new membership")
		}
		save("membership-a", false)
		a = history("membership-a")
		if len(a) != 1 || !date(obj(a[0])["removeDate"]).IsZero() || !date(obj(a[0])["addDate"]).After(first) {
			t.Fatal("rejoin did not reset existing entry", a)
		}
		if date(obj(history("membership-b")[0])["removeDate"]).IsZero() {
			t.Fatal("previous conference remains open")
		}
		if _, err := s.Store.update(ctx, "conferences", M{"conferenceID": "membership-a"}, M{"$set": M{"status": "expired", "endDate": time.Now().Add(-time.Hour)}}); err != nil {
			t.Fatal(err)
		}
		save("membership-a", false)
		save("", false)
		if date(obj(history("membership-a")[0])["removeDate"]).IsZero() {
			t.Fatal("leaving did not close membership")
		}
	})
}
