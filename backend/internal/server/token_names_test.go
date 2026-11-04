package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestTypeScriptTokenNames(t *testing.T) {
	raw, err := os.ReadFile("testdata/token-names.json")
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
			got, err := adminTokenName(c.Body["name"])
			if c.Rejected {
				if err == nil {
					t.Fatal("accepted shadowed toString")
				}
				return
			}
			if err != nil || got != c.Expected {
				t.Fatalf("got %q %v want %q", got, err, c.Expected)
			}
		})
	}
}
