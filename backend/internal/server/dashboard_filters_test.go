package server

import (
	"encoding/json"
	"net/url"
	"os"
	"reflect"
	"testing"
)

func TestTypeScriptDashboardFilters(t *testing.T) {
	raw, err := os.ReadFile("testdata/dashboard-filters.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Query, Expected M }
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
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
		got, err := dashboardFilter(parseExtendedQuery(query.Encode()).object)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(defaultsJSON(t, got), defaultsJSON(t, c.Expected)) {
			t.Fatalf("case %d: got %#v want %#v", i, got, c.Expected)
		}
	}
}
