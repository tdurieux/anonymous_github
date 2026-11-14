package server

import (
	"encoding/json"
	"net/url"
	"os"
	"reflect"
	"testing"
)

func TestTypeScriptAdminFilters(t *testing.T) {
	raw, err := os.ReadFile("testdata/admin-filters.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Kind         string
		Query        M
		RawQuery     string
		Error        bool
		Expected     M
		MissingOwner bool
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		values := url.Values{}
		for k, v := range c.Query {
			values.Set(k, str(v))
		}
		rawQuery := values.Encode()
		if c.RawQuery != "" {
			rawQuery = c.RawQuery
		}
		t.Run(c.Kind+"/"+rawQuery, func(t *testing.T) {
			values, err := adminFilterQuery(c.Kind, rawQuery)
			if c.Error {
				if err == nil {
					t.Fatal("expected invalid query")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var owner M
			if values.Get("owner") == "exists" {
				owner = M{"_id": "owner-id"}
			}
			filter, missing, err := adminFilter(c.Kind, values, owner)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(responseJSON(filter))
			if err != nil {
				t.Fatal(err)
			}
			var actual M
			if err := json.Unmarshal(raw, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, c.Expected) || missing != c.MissingOwner {
				t.Fatalf("got %s missing=%v; expected %#v missing=%v", raw, missing, c.Expected, c.MissingOwner)
			}
		})
	}
}
