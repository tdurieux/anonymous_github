package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestTypeScriptDashboardCursorEncoding(t *testing.T) {
	raw, err := os.ReadFile("testdata/dashboard-cursor-output.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Sort, Type, ID, Expected string
		Value                    any
		Date                     bool
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		value := c.Value
		if c.Date {
			value = time.UnixMilli(int64(value.(float64))).UTC()
		}
		id, err := oid(c.ID)
		if err != nil {
			t.Fatal(err)
		}
		got, err := encodeDashboardCursor(c.Sort, M{"_sort": value, "_type": c.Type, "_id": id})
		if err != nil || got != c.Expected {
			t.Fatalf("case %d: got %s %v want %s", i, got, err, c.Expected)
		}
		if c.Date {
			decoded, err := dashboardCursor(got, c.Sort, strings.TrimPrefix(c.Sort, "-"))
			if err != nil || !decoded["value"].(time.Time).Equal(value.(time.Time)) {
				t.Fatalf("case %d date round trip: %v %v", i, decoded, err)
			}
		}
	}
}
