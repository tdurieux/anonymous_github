package server

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"
)

type conferenceFormCase struct {
	Name     string
	Body     M
	Expected *struct {
		Code   string
		Status int
	}
}

func conferenceFormCases(t *testing.T) (time.Time, []conferenceFormCase) {
	t.Helper()
	raw, err := os.ReadFile("testdata/conferences.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now   time.Time
		Cases []conferenceFormCase
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture.Now, fixture.Cases
}
func TestTypeScriptConferenceForms(t *testing.T) {
	now, cases := conferenceFormCases(t)
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			_, err := validateConferenceForm(c.Body, now)
			if c.Expected == nil {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var api *APIError
			if !errors.As(err, &api) || api.Code != c.Expected.Code || api.Status != c.Expected.Status {
				t.Fatalf("got %v; expected %+v", err, c.Expected)
			}
		})
	}
}
