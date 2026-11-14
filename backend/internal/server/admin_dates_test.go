package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestAdminDateRangeContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/admin-dates.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Query    string
		Expected any
		Error    bool
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, row := range cases {
		t.Run(row.Query, func(t *testing.T) {
			dates, err := adminDateRange(row.Query)
			if (err != nil) != row.Error {
				t.Fatal(row, err)
			}
			if err != nil {
				return
			}
			var value any
			if len(dates) > 0 {
				value = M{"date": dates}
			}
			data, err := json.Marshal(responseJSON(value))
			if err != nil {
				t.Fatal(err)
			}
			var actual any
			if err = json.Unmarshal(data, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, row.Expected) {
				t.Fatal(row.Query, string(data), row.Expected)
			}
		})
	}
}
