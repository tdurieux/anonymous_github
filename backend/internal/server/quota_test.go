package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestTypeScriptQuota(t *testing.T) {
	raw, err := os.ReadFile("testdata/quota.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now    time.Time
		Filter M
		Cases  []struct {
			Row      M
			Expected bool
		}
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		if got := quotaSizeCached(c.Row); got != c.Expected {
			t.Fatal(c.Row, got, c.Expected)
		}
	}
	raw, err = json.Marshal(responseJSON(quotaFilter("owner", fixture.Now)))
	if err != nil {
		t.Fatal(err)
	}
	var actual M
	if err := json.Unmarshal(raw, &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, fixture.Filter) {
		t.Fatal(actual, fixture.Filter)
	}
}
