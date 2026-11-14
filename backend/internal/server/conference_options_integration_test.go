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

func runConferenceOptionsIntegration(t *testing.T, s *Server, token, otherToken string, owner any) {
	t.Run("conference option casts persist and appear in public output", func(t *testing.T) {
		ctx := context.Background()
		id := "conference-options"
		seed := M{"_id": bson.NewObjectID(), "conferenceID": id, "name": "Original", "plan": M{"planID": "free_conference"}, "status": "ready", "owners": []any{owner}, "repositories": []any{}, "billing": M{"name": "Private payer"}}
		if _, err := s.Store.DB.Collection("conferences").InsertOne(ctx, seed); err != nil {
			t.Fatal(err)
		}
		requestCount := 0
		call := func(method, auth string, body M) *httptest.ResponseRecorder {
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest(method, "/api/conferences/"+id, bytes.NewReader(raw))
			req.RemoteAddr = fmt.Sprintf("198.51.101.%d:1234", requestCount/40+1)
			requestCount++
			req.Header.Set("Authorization", "Bearer "+auth)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		for _, c := range conferenceOptionCases(t) {
			if _, err := s.Store.update(ctx, "conferences", M{"_id": seed["_id"]}, M{"$set": M{"options": M{"image": true, "link": true}, "name": "Original"}}); err != nil {
				t.Fatal(err)
			}
			body := selectFields(c.Body, "options")
			body["name"], body["conferenceID"], body["startDate"], body["endDate"], body["plan"] = "Changed", id, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), M{"planID": "free_conference"}
			before, err := s.Store.one(ctx, "conferences", M{"_id": seed["_id"]})
			if err != nil {
				t.Fatal(err)
			}
			w := call("POST", token, body)
			current, err := s.Store.one(ctx, "conferences", M{"_id": seed["_id"]})
			if err != nil {
				t.Fatal(err)
			}
			if c.Rejected {
				if w.Code != 500 || !reflect.DeepEqual(current, before) {
					t.Fatal(c.Name, w.Code, w.Body, "rejected edit changed data")
				}
				continue
			}
			if w.Code != 200 {
				t.Fatal(c.Name, w.Code, w.Body)
			}
			stored := selectFields(current, "options")
			if raw := obj(stored["options"])["expirationDate"]; raw != nil {
				value := date(raw)
				obj(stored["options"])["expirationDate"] = responseDate(value)
			}
			if !reflect.DeepEqual(conferenceOptionsJSON(t, stored), c.Expected) {
				t.Fatalf("%s persisted %#v, expected %#v", c.Name, stored, c.Expected)
			}
			w = call("GET", otherToken, nil)
			var output M
			if err := json.Unmarshal(w.Body.Bytes(), &output); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || !reflect.DeepEqual(selectFields(output, "options"), c.Expected) {
				t.Fatal(c.Name, w.Code, w.Body)
			}
			if _, present := output["billing"]; present {
				t.Fatal("billing exposed to non-owner")
			}
		}
	})
}
