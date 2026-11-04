package server

import (
	"go.mongodb.org/mongo-driver/v2/bson"
	"testing"
	"time"
)

func TestMaintenanceTokenBoundary(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		allowed      bool
	}{
		{"GET", "/api/maintenance/repositories/example", true}, {"PATCH", "/api/maintenance/repositories/example/", true}, {"POST", "/api/repo/example/refresh", true},
		{"GET", "/api/user", false}, {"POST", "/github/login-token", false}, {"POST", "/api/admin/tokens", false}, {"PATCH", "/api/maintenance/repositories/other", false}, {"GET", "/api/repo/example", false}, {"DELETE", "/api/repo/example", false}, {"POST", "/api/repo/example/refresh/extra", false},
	} {
		if got := maintenanceAllows(tc.method, tc.path, []string{"example"}); got != tc.allowed {
			t.Errorf("%s %s: %v", tc.method, tc.path, got)
		}
	}
	for _, token := range []M{{"scope": "unknown", "expiresAt": time.Now().Add(time.Hour)}, {"scope": "repository-maintenance"}, {"expiresAt": time.Now().Add(-time.Second)}} {
		if validAPIToken(token) {
			t.Error("invalid token accepted")
		}
	}
	if !validAPIToken(M{"scope": "repository-maintenance", "expiresAt": time.Now().Add(time.Hour)}) {
		t.Fatal("valid token denied")
	}
}

func TestAPITokenExpiryPresence(t *testing.T) {
	for _, scope := range []string{"", "repository-maintenance"} {
		for _, expiry := range []any{time.Time{}, bson.NewDateTimeFromTime(time.Time{}), time.UnixMilli(0), bson.DateTime(0)} {
			if validAPIToken(M{"scope": scope, "expiresAt": expiry}) {
				t.Fatalf("expired token accepted: scope=%q expiry=%v", scope, expiry)
			}
		}
	}
	for _, token := range []M{{}, {"expiresAt": nil}} {
		if !validAPIToken(token) {
			t.Fatal("unscoped token without expiry rejected")
		}
	}
}
