package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestFileQueryContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/file-query.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Query                           string
		Download, Force, Refresh, Error bool
	}
	if err = json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		query := parseExtendedQuery(row.Query).object
		force, err := query["force"].looseStringEqual("1")
		// The fixture evaluates the list's force coercion before the preview's
		// short-circuiting refresh expression.
		if (err != nil) != row.Error {
			t.Fatal(row, err)
		}
		if row.Error {
			continue
		}
		refresh, err := previewRefresh(row.Query)
		if err != nil || force != row.Force || refresh != row.Refresh || query["download"].truthy() != row.Download {
			t.Fatal(row, force, refresh, err)
		}
	}
	refresh, err := previewRefresh("reconnect=1&force[toString]=x")
	if err != nil || !refresh {
		t.Fatal("reconnect must short-circuit force conversion", refresh, err)
	}
}
