package server

import (
	"encoding/json"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"os"
	"testing"
)

func TestLegacySourcePathContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/legacy-source-paths.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Record                           M
		Commit, Revision, Path, Expected string
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		paths := legacySourcePaths(f.Record, provider.Access{Ref: provider.Ref{Commit: f.Commit}}, provider.Entry{Path: f.Path, Revision: f.Revision})
		if len(paths) != 3 || paths[1] != f.Expected || paths[2] != f.Path {
			t.Fatal(paths, f.Expected)
		}
	}
}
