package server

import (
	"encoding/json"
	"net/url"
	"os"
	"reflect"
	"testing"
)

func TestTypeScriptAdminPagination(t *testing.T) {
	raw, err := os.ReadFile("testdata/admin-pagination.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Kind     string
		Query    M
		Expected M
		RawQuery string
		Error    bool
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		values := url.Values{}
		for key, value := range c.Query {
			if list, ok := value.([]any); ok {
				for _, v := range list {
					values.Add(key, str(v))
				}
			} else {
				values.Set(key, str(value))
			}
		}
		rawQuery := values.Encode()
		if c.RawQuery != "" {
			rawQuery = c.RawQuery
		}
		t.Run(c.Kind+"/"+rawQuery, func(t *testing.T) {
			page, limit, sort, _, err := adminListPage(rawQuery)
			if c.Error {
				if err == nil {
					t.Fatal("expected coercion error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			actual := M{"page": page, "limit": limit, "sort": sort}
			raw, _ := json.Marshal(actual)
			var normalized M
			if err := json.Unmarshal(raw, &normalized); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(normalized, c.Expected) {
				t.Fatalf("got %s; expected %#v", raw, c.Expected)
			}
		})
	}
}
