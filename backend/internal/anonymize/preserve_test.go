package anonymize

import (
	"encoding/json"
	"os"
	"testing"
)

func TestNodePreserveFiles(t *testing.T) {
	data, err := os.ReadFile("testdata/preserve-files.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Patterns []string
		Path     string
		Expected bool
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if got := PreservedPath(c.Path, c.Patterns); got != c.Expected {
			t.Errorf("%q %v: got %v want %v", c.Path, c.Patterns, got, c.Expected)
		}
	}
}
func TestPreserveNormalization(t *testing.T) {
	for _, value := range []any{"refs.bib", []any{1}, []string{"//x"}, []string{"../x"}, []string{"!/"}} {
		if _, err := NormalizePreserveFiles(value); err == nil {
			t.Fatalf("accepted %v", value)
		}
	}
	out, err := NormalizePreserveFiles([]string{"*.bib", "!secret.bib", "*.bib"})
	if err != nil || len(out) != 2 || out[0] != "!secret.bib" {
		t.Fatal(out, err)
	}
}
