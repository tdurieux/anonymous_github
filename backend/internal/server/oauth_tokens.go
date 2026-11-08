package server

import (
	"math"
	"time"
)

func tokenLifetime(value any) (time.Duration, bool) {
	seconds, ok := value.(float64)
	// Responses come from JSON. Strings and booleans are not numeric lifetimes.
	// Bound before converting to Duration so a malformed upstream cannot overflow.
	if !ok || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 || seconds > float64(math.MaxInt64/int64(time.Second)) {
		return 0, false
	}
	return time.Duration(seconds * float64(time.Second)), true
}
func appTokenLifetimes(tokens M) (time.Duration, time.Duration, error) {
	access, accessOK := tokens["access_token"].(string)
	refresh, refreshOK := tokens["refresh_token"].(string)
	accessTTL, accessValid := tokenLifetime(tokens["expires_in"])
	refreshTTL, refreshValid := tokenLifetime(tokens["refresh_token_expires_in"])
	if !accessOK || access == "" || !refreshOK || refresh == "" || !accessValid || !refreshValid {
		return 0, 0, fail("github_app_reconnect_required", 401)
	}
	return accessTTL, refreshTTL, nil
}
