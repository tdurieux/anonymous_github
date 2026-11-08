package server

import (
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"testing"
)

func TestDisabledDownloadIncludesAdministrators(t *testing.T) {
	s := &Server{Config: Config{Download: false}}
	for _, admin := range []bool{false, true} {
		_, e := s.zip(&request{Identity: security.Identity{Admin: admin}})
		var api *APIError
		if !errors.As(e, &api) || api.Code != "download_not_enabled" || api.Status != 403 {
			t.Fatal(admin, e)
		}
	}
}
