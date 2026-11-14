package server

import (
	"encoding/json"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"os"
	"testing"
)

func TestSharedResultKeyContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/shared-result-key.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Record, Row                      M
		Options                          anonymize.Options
		Digest, Mask, Hostname, Expected string
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		s := &Server{Config: Config{Mask: f.Mask, Hostname: f.Hostname}}
		key, err := s.sharedResultKey(f.Record, f.Row, f.Digest, f.Options)
		if err != nil || key != f.Expected {
			t.Fatal(key, f.Expected, err)
		}
	}
}
