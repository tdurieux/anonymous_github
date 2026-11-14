package server

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestTypeScriptDashboardCursors(t *testing.T) {
	raw, err := os.ReadFile("testdata/dashboard-cursors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Sort, Cursor string
		Rejected     bool
		Expected     M
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		got, err := dashboardCursor(c.Cursor, c.Sort, strings.TrimPrefix(c.Sort, "-"))
		if c.Rejected {
			if err == nil {
				t.Fatalf("case %d accepted invalid cursor", i)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(defaultsJSON(t, responseJSON(got)), defaultsJSON(t, c.Expected)) {
			t.Fatalf("case %d: %#v %v want %#v", i, got, err, c.Expected)
		}
	}
}
