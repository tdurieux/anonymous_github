package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
)

func TestMonitoringQueryContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/monitoring-query.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Query              string
		Performance, Cache int
		Error              bool
	}
	if err = json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		s := &Server{}
		q := &request{R: httptest.NewRequest("GET", "/api/admin/performance?"+row.Query, nil)}
		result, err := s.requestPerformance(q)
		if (err != nil) != row.Error {
			t.Fatalf("query %q: error %v", row.Query, err)
		}
		if row.Error {
			if _, err := s.cacheTelemetry(q); err == nil {
				t.Fatal("cache report swallowed conversion error", row.Query)
			}
			continue
		}
		if number(result.(M)["windowMinutes"]) != int64(row.Performance) {
			t.Fatal(row, result)
		}
		raw, err := extendedQueryString(row.Query, "minutes")
		if err != nil || cacheWindow([]string{raw}) != row.Cache {
			t.Fatal(row, raw, err)
		}
	}
}
