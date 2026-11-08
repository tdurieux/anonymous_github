package server

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

type appProfileContract struct {
	Name     string
	Profile  M
	Rejected bool
}

func appProfileContracts(t *testing.T) []appProfileContract {
	t.Helper()
	data, err := os.ReadFile("testdata/oauth-profile.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []appProfileContract
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}
func TestAppProfileContracts(t *testing.T) {
	for _, tc := range appProfileContracts(t) {
		t.Run(tc.Name, func(t *testing.T) {
			err := validateAppProfile(tc.Profile)
			if (err != nil) != tc.Rejected {
				t.Fatal("profile predicate differs", err)
			}
			if err != nil {
				var api *APIError
				if !errors.As(err, &api) || api.Code != "github_app_reconnect_required" || api.Status != 403 {
					t.Fatal("wrong profile error", err)
				}
			}
		})
	}
}
