package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestRouteInventory(t *testing.T) {
	raw, e := os.ReadFile("../../contracts/routes.json")
	if e != nil {
		t.Fatal(e)
	}
	var contracts []struct{ Method, Path string }
	if e = json.Unmarshal(raw, &contracts); e != nil {
		t.Fatal(e)
	}
	s := &Server{}
	s.register()
	for _, contract := range contracts {
		if contract.Path == "/api/healthcheck" || contract.Path == "/github/app/webhook" {
			recorder := httptest.NewRecorder()
			s.ServeHTTP(recorder, httptest.NewRequest(contract.Method, contract.Path, nil))
			expected := 200
			if contract.Path == "/github/app/webhook" {
				expected = 401
			}
			if recorder.Code != expected {
				t.Errorf("special route %s: status %d, want %d", contract.Path, recorder.Code, expected)
			}
			continue
		}
		path := strings.ReplaceAll(strings.ReplaceAll(contract.Path, "{", ""), "}", "")
		parts := strings.Split(path, "/")
		for i, p := range parts {
			if strings.HasPrefix(p, ":") {
				parts[i] = "fixture"
			}
			if strings.HasPrefix(p, "*") {
				parts[i] = "file.txt"
			}
		}
		path = strings.Join(parts, "/")
		found := false
		for _, r := range s.routes {
			if r.method == contract.Method && r.pattern.MatchString(path) {
				found = true
				if normalizeRouteTemplate(r.template) != normalizeRouteTemplate(contract.Path) {
					t.Errorf("%s %s dispatched to %s", contract.Method, contract.Path, r.template)
				}
				break
			}
		}
		if !found {
			t.Errorf("unregistered route: %s %s", contract.Method, contract.Path)
		}
	}
}

func normalizeRouteTemplate(path string) string {
	path = strings.Trim(strings.NewReplacer("{", "", "}", "").Replace(path), "/")
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if strings.HasPrefix(part, ":") {
			parts[i] = ":param"
		}
		if strings.HasPrefix(part, "*") {
			parts[i] = "*path"
		}
	}
	return strings.Join(parts, "/")
}

func TestCacheMonitoringAvailability(t *testing.T) {
	s := &Server{}
	s.register()
	for _, route := range s.routes {
		if route.method != "GET" || !route.pattern.MatchString("/api/admin/cache") {
			continue
		}
		if route.auth != "admin" {
			t.Fatal("cache monitoring must require administrator access")
		}
		recorder := httptest.NewRecorder()
		response, err := route.handler(&request{W: recorder, R: httptest.NewRequest("GET", "/api/admin/cache", nil)})
		if err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		var report struct {
			Available bool
			Reason    string
			Rows      []any
		}
		if err := json.Unmarshal(body, &report); err != nil {
			t.Fatal(err)
		}
		if report.Available || report.Reason == "" || report.Rows == nil || len(report.Rows) != 0 {
			t.Fatalf("invalid unavailable telemetry response: %s", body)
		}
		if recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("monitoring response must not be cached")
		}
		return
	}
	t.Fatal("cache monitoring route missing")
}
