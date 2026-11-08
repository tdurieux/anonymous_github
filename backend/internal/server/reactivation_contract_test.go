package server

import (
	"encoding/json"
	"os"
	"testing"
)

type reactivationCase struct {
	Name, Status, Now string
	Options           M
	Expected          bool
}

func reactivationCases(t *testing.T) []reactivationCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/reactivation.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []reactivationCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}
func TestTypeScriptReactivation(t *testing.T) {
	for _, c := range reactivationCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			if got := shouldReactivateRepository(c.Status, c.Options, date(c.Now)); got != c.Expected {
				t.Fatalf("got %v; want %v", got, c.Expected)
			}
		})
	}
}
