package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestStatsHistoryTypeScriptContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/stats-history.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Now      string
		Rows     []M
		Current  M
		Expected []M
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for i, row := range cases {
		before, _ := json.Marshal([]any{row.Rows, row.Current})
		result := mergeCurrentStats(row.Rows, row.Current, date(row.Now))
		for _, expected := range row.Expected {
			expected["date"] = date(expected["date"]).UTC()
		}
		if !reflect.DeepEqual(result, row.Expected) {
			t.Fatalf("case %d: got %+v expected %+v", i, result, row.Expected)
		}
		after, _ := json.Marshal([]any{row.Rows, row.Current})
		if string(before) != string(after) {
			t.Fatal("history merge mutated inputs", i)
		}
	}
}
