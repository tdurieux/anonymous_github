package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestConferenceDatePersistenceContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/conference-dates.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Body     M
		Error    bool
		Expected M
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, row := range cases {
		start, end, err := conferenceFormDates(row.Body)
		if (err != nil) != row.Error {
			t.Fatal(row, err)
		}
		if err != nil {
			continue
		}
		got := defaultsJSON(t, responseJSON(M{"startDate": start, "endDate": end}))
		if !reflect.DeepEqual(got, defaultsJSON(t, row.Expected)) {
			t.Fatal(row, got)
		}
	}
}
