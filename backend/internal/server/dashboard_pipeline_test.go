package server

import (
	"encoding/json"
	"go.mongodb.org/mongo-driver/v2/bson"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestTypeScriptDashboardPipeline(t *testing.T) {
	raw, err := os.ReadFile("testdata/dashboard-pipeline.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now, Owner string
		Cases      []struct {
			Name      string
			RawQuery  *string
			Query     M
			Expected  any
			Error     string
			SortOrder []string
		}
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339, fixture.Now)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := oid(fixture.Owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		if !t.Run(c.Name, func(t *testing.T) {
			query := url.Values{}
			for key, value := range c.Query {
				if values, ok := value.([]any); ok {
					for _, v := range values {
						query.Add(key, str(v))
					}
				} else {
					query.Set(key, str(value))
				}
			}
			rawQuery := query.Encode()
			if c.RawQuery != nil {
				rawQuery = *c.RawQuery
			}
			q := &request{User: M{"_id": owner}, R: httptest.NewRequest("GET", "/api/user/dashboard?"+rawQuery, nil)}
			pipeline, _, _, err := dashboardPipeline(q, now)
			if c.Error != "" {
				if err == nil || err.Error() != c.Error {
					t.Fatalf("error %v; want %s", err, c.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			foundSort := false
			for _, stage := range arr(obj(pipeline[len(pipeline)-1]["$facet"])["items"]) {
				if value, present := obj(stage)["$sort"]; present {
					foundSort = true
					sort, ok := value.(bson.D)
					if !ok {
						t.Fatal("multi-key sort must use ordered BSON")
					}
					keys := []string{}
					for _, entry := range sort {
						keys = append(keys, entry.Key)
					}
					if !reflect.DeepEqual(keys, c.SortOrder) {
						t.Fatalf("sort order %v; want %v", keys, c.SortOrder)
					}
				}
			}
			if !foundSort {
				t.Fatal("missing sort stage")
			}
			got := defaultsJSON(t, responseJSON(pipeline))
			if !reflect.DeepEqual(got, c.Expected) {
				actual, _ := json.Marshal(got)
				expected, _ := json.Marshal(c.Expected)
				t.Fatalf("pipeline mismatch\ngot %s\nwant %s", actual, expected)
			}
		}) {
			return
		}
	}
}
