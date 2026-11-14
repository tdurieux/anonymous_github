package server

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestTypeScriptValidation(t *testing.T) {
	raw, e := os.ReadFile("testdata/validation.json")
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Name, Kind string
		Body       M
		Expected   *struct {
			Code   string
			Status int
		}
	}
	if e = json.Unmarshal(raw, &cases); e != nil {
		t.Fatal(e)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			e := validateResourceInput(c.Kind, c.Body)
			if c.Expected == nil {
				if e != nil {
					t.Fatal(e)
				}
				return
			}
			var api *APIError
			if !errors.As(e, &api) || api.Code != c.Expected.Code || api.Status != c.Expected.Status {
				t.Fatalf("got %v; expected %+v", e, c.Expected)
			}
		})
	}
}
