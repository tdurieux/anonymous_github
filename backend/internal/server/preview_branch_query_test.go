package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPreviewBranchContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/preview-branches.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Branches []struct{ Name string }
		Cases    []struct {
			Query    string
			Selected *string
			Error    bool
		}
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, row := range fixture.Cases {
		match := previewBranchMatch(row.Query, "main")
		var selected *string
		var matchErr error
		for _, candidate := range fixture.Branches {
			ok, err := match(candidate.Name)
			if err != nil {
				matchErr = err
				break
			}
			if ok && selected == nil {
				name := candidate.Name
				selected = &name
			}
		}
		if (matchErr != nil) != row.Error || !row.Error && ((selected == nil) != (row.Selected == nil) || selected != nil && *selected != *row.Selected) {
			t.Fatal("deferred match", row, selected, matchErr)
		}
		branch, err := previewBranchQuery(row.Query, "main")
		if row.Error {
			if err == nil {
				t.Fatal(row)
			}
			continue
		}
		if err != nil {
			if row.Selected != nil || err.Error() != "readme_not_available" {
				t.Fatal(row, err)
			}
			continue
		}
		var matched *string
		for _, candidate := range fixture.Branches {
			if candidate.Name == branch {
				v := candidate.Name
				matched = &v
				break
			}
		}
		if (matched == nil) != (row.Selected == nil) || matched != nil && *matched != *row.Selected {
			t.Fatal(row, branch)
		}
	}
}
