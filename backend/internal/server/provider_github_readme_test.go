package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestGitHubReadmeDecodingContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/readme-decoding.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Data     M
		Expected string
		Error    string
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := decodeGitHubReadme(c.Data)
			if c.Error != "" {
				if err == nil {
					t.Fatal("invalid response accepted", got)
				}
				return
			}
			if err != nil || got != c.Expected || !utf8.ValidString(got) {
				t.Fatalf("got %q, %v; want %q", got, err, c.Expected)
			}
		})
	}
}
func TestGitHubReadmeAllocationBound(t *testing.T) {
	for _, content := range []any{M{"length": float64(maxReadmeBytes + 1)}, M{"length": 1e300}} {
		if _, err := decodeGitHubReadme(M{"content": content}); err == nil {
			t.Fatal("unbounded array-like accepted")
		}
	}
	if _, err := decodeGitHubReadme(M{"encoding": "utf16le", "content": strings.Repeat("a", maxReadmeBytes/2+1)}); err == nil {
		t.Fatal("unbounded UTF-16 expansion accepted")
	}
}
