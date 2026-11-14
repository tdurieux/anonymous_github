package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestAdminMongooseCasting(t *testing.T) {
	data, err := os.ReadFile("testdata/admin-casting.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Field, Query     string
		Present, Error   bool
		Casted, RawAfter M
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, row := range cases {
		t.Run(row.Field+"/"+row.Query, func(t *testing.T) {
			value := parseExtendedQuery(row.Query).object[row.Field]
			if value.truthy() != row.Present {
				t.Fatal(row)
			}
			if !row.Present {
				return
			}
			cast, raw, err := adminCastPredicate(value)
			if (err != nil) != row.Error {
				t.Fatal(row, err)
			}
			if err != nil {
				return
			}
			normalize := func(value any) any {
				data, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				var out any
				if err = json.Unmarshal(data, &out); err != nil {
					t.Fatal(err)
				}
				return out
			}
			if !reflect.DeepEqual(normalize(M{row.Field: cast}), normalize(row.Casted)) || !reflect.DeepEqual(normalize(M{row.Field: raw}), normalize(row.RawAfter)) {
				t.Fatal(row, cast, raw)
			}
		})
	}
}
