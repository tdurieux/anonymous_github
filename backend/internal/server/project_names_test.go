package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestTypeScriptProjectNames(t *testing.T) {
	raw, err := os.ReadFile("testdata/project-names.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Body     M
		Expected string
		Rejected bool
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			kind, id, name, err := validateProjectName(c.Body)
			if c.Rejected {
				if err == nil {
					t.Fatal("accepted invalid input")
				}
				return
			}
			if err != nil || name != c.Expected || kind != c.Body["type"] || id != c.Body["id"] {
				t.Fatalf("got %q %q %q %v", kind, id, name, err)
			}
		})
	}
}
