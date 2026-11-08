package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestTypeScriptDashboardLimits(t *testing.T) {
	raw, err := os.ReadFile("testdata/dashboard-limits.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Values   []string
		Expected int
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if got := dashboardLimit(c.Values); got != c.Expected {
			t.Fatalf("%q: got %d want %d", c.Values, got, c.Expected)
		}
	}
}
