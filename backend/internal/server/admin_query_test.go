package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestAdminQueryContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/admin-query.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Queue []struct {
			Query, Queue, Range, Error string
			Minutes                    int64
		}
		Errors []struct {
			Query, Error  string
			Offset, Limit int64
		}
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, row := range fixture.Queue {
		name, selected, minutes, err := queueMetricSelection(row.Query)
		if row.Error != "" {
			if err == nil || err.Error() != row.Error {
				t.Fatal(row, err)
			}
			continue
		}
		if err != nil || name != row.Queue || selected != row.Range || minutes != row.Minutes {
			t.Fatal(row, name, selected, minutes, err)
		}
	}
	for _, row := range fixture.Errors {
		offset, limit, err := errorQueryPage(row.Query)
		if row.Error != "" {
			if err == nil || err.Error() != row.Error {
				t.Fatal(row, err)
			}
			continue
		}
		if err != nil || offset != row.Offset || limit != row.Limit {
			t.Fatal(row, offset, limit, err)
		}
	}
}
