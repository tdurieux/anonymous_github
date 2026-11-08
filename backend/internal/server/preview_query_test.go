package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
)

func TestPreviewQueryContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/preview-query.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Query, Choice                    string
		SavedResource, InvalidConnection bool
	}
	if err = json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		query := parseExtendedQuery(row.Query).object
		_, saved := query["anonymizedRepoId"].scalarValue()
		choice, err := previewConnectionChoice(query["connection"], "github")
		if saved != row.SavedResource || (err != nil) != row.InvalidConnection || err == nil && choice != row.Choice {
			t.Fatal(row, saved, choice, err)
		}
	}
	query := parseExtendedQuery("connection=provider-specific-grant").object
	if choice, err := previewConnectionChoice(query["connection"], "fixture"); err != nil || choice != "provider-specific-grant" {
		t.Fatal(choice, err)
	}
	s := &Server{}
	q := &request{R: httptest.NewRequest("GET", "/?connection[]=oauth", nil)}
	if _, err := s.previewRepositoryAccess(q, nil, "github", "bad/name/extra"); err == nil || err.Error() != "repo_not_found" {
		t.Fatal("repository validation must precede connection selection", err)
	}
}
