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

func runConferenceFormIntegration(t *testing.T, s *Server, token, otherToken string, owner any) {
	t.Run("conference edits preserve history and status", func(t *testing.T) {
		ctx := context.Background()
		call := func(method, id, auth string, body M) *httptest.ResponseRecorder {
			raw, _ := json.Marshal(body)
			path := "/api/conferences"
			if id != "" {
				path += "/" + id
			}
			req := httptest.NewRequest(method, path, bytes.NewReader(raw))
			req.RemoteAddr = "198.51.100.10:1234"
			req.Header.Set("Authorization", "Bearer "+auth)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		valid := func() M {
			return M{"name": "Updated", "conferenceID": "ignored-edit-id", "startDate": time.Now().Add(-time.Hour), "endDate": time.Now().Add(24 * time.Hour), "plan": M{"planID": "free_conference"}, "options": M{"image": true}}
		}
		checkError := func(w *httptest.ResponseRecorder, status int, code string) {
			t.Helper()
			var response M
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err, w.Body)
			}
			if w.Code != status || str(response["error"]) != code {
				t.Fatalf("want %d %s, got %d %s", status, code, w.Code, w.Body)
			}
		}
		for _, status := range []string{"ready", "expired", "removed"} {
			id := "conference-form-" + status
			document := M{"_id": bson.NewObjectID(), "conferenceID": id, "name": "Original", "owners": []any{owner}, "status": status,
				"plan": M{"planID": "premium_conference", "pricePerRepository": 0.5}, "billing": M{"name": "Original payer"},
				"repositories": []any{M{"id": bson.NewObjectID(), "addDate": time.Now().Add(-48 * time.Hour).Truncate(time.Millisecond), "removeDate": time.Now().Add(-24 * time.Hour).Truncate(time.Millisecond)}}}
			if _, err := s.Store.DB.Collection("conferences").InsertOne(ctx, document); err != nil {
				t.Fatal(err)
			}
			before, err := s.Store.one(ctx, "conferences", M{"conferenceID": id})
			if err != nil {
				t.Fatal(err)
			}
			checkError(call("POST", id, otherToken, M{}), 401, "not_authorized")
			checkError(call("POST", id, token, M{}), 400, "billing_plan_change_not_supported")
			body := valid()
			body["plan"] = M{"planID": "unknown"}
			checkError(call("POST", id, token, body), 400, "billing_plan_change_not_supported")
			body = valid()
			body["plan"] = M{"planID": "premium_conference"}
			body["name"] = ""
			checkError(call("POST", id, token, body), 400, "conf_name_missing")
			after, err := s.Store.one(ctx, "conferences", M{"conferenceID": id})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rejected edit mutated conference")
			}
			body = valid()
			body["plan"] = M{"planID": "premium_conference"}
			body["billing"] = M{"name": "Ignored payer"}
			w := call("POST", id, token, body)
			if w.Code != 200 || w.Body.String() != "ok" {
				t.Fatal(w.Code, w.Body)
			}
			after, err = s.Store.one(ctx, "conferences", M{"conferenceID": id})
			if err != nil {
				t.Fatal(err)
			}
			if after["status"] != status || after["name"] != "Updated" {
				t.Fatal(after)
			}
			for _, field := range []string{"_id", "conferenceID", "owners", "repositories", "plan", "billing"} {
				if !reflect.DeepEqual(after[field], before[field]) {
					t.Fatal("edit changed", field)
				}
			}
		}
		checkError(call("POST", "conference-missing", token, valid()), 404, "conference_not_found")
		checkError(call("GET", "conference-missing", token, nil), 404, "conf_not_found")
		checkError(call("DELETE", "conference-missing", token, nil), 400, "conf_not_found")
		body := valid()
		body["conferenceID"] = "conference-form-create"
		w := call("POST", "", token, body)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		created, err := s.Store.one(ctx, "conferences", M{"conferenceID": body["conferenceID"]})
		if err != nil {
			t.Fatal(err)
		}
		if created["status"] != "ready" || len(arr(created["repositories"])) != 0 || str(obj(created["plan"])["planID"]) != "free_conference" {
			t.Fatal(created)
		}
		expectedDate := time.Date(2099, 3, 1, 0, 0, 0, 0, time.UTC)
		for index, test := range []struct {
			Value    any
			Expected time.Time
		}{
			{"March 1 2099", expectedDate}, {"2099-02-29", expectedDate}, {"2099-02-28T24:00:00Z", expectedDate},
			{[]string{"2099", "3", "1"}, expectedDate}, {float64(expectedDate.UnixMilli()), expectedDate},
			{"0001-01-01", time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC)}, {true, time.UnixMilli(1).UTC()},
		} {
			id := fmt.Sprintf("conference-date-%d", index)
			body := valid()
			body["conferenceID"] = id
			body["startDate"] = test.Value
			body["endDate"] = "April 1 2099"
			w := call("POST", "", token, body)
			if w.Code != 200 {
				t.Fatal("date creation", test, w.Code, w.Body)
			}
			document, err := s.Store.one(ctx, "conferences", M{"conferenceID": id})
			if err != nil || !date(document["startDate"]).Equal(test.Expected) || !date(document["endDate"]).Equal(time.Date(2099, 4, 1, 0, 0, 0, 0, time.UTC)) {
				t.Fatal("stored date", test, document, err)
			}
			body["startDate"] = "May 1 2099"
			body["endDate"] = []string{"2099", "6", "1"}
			if w = call("POST", id, token, body); w.Code != 200 {
				t.Fatal("date edit", w.Code, w.Body)
			}
			before, err := s.Store.one(ctx, "conferences", M{"conferenceID": id})
			if err != nil {
				t.Fatal(err)
			}
			if !date(before["startDate"]).Equal(time.Date(2099, 5, 1, 0, 0, 0, 0, time.UTC)) || !date(before["endDate"]).Equal(time.Date(2099, 6, 1, 0, 0, 0, 0, time.UTC)) {
				t.Fatal("edited dates", before)
			}
			for _, invalid := range []any{"invalid", M{"toString": "bad"}} {
				body["startDate"] = invalid
				checkError(call("POST", id, token, body), 500, "internal_error")
				after, err := s.Store.one(ctx, "conferences", M{"conferenceID": id})
				if err != nil || !reflect.DeepEqual(before, after) {
					t.Fatal("invalid date mutated conference", err)
				}
			}
		}

	})
}
