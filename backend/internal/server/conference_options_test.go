package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

type conferenceOptionCase struct {
	Name           string
	Body, Expected M
	Rejected       bool
}

func conferenceOptionCases(t *testing.T) []conferenceOptionCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/conference-options.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []conferenceOptionCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}
func TestTypeScriptConferenceOptions(t *testing.T) {
	for _, c := range conferenceOptionCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			got, err := conferenceOptions(c.Body)
			if c.Rejected {
				if err == nil {
					t.Fatal("invalid options accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if value, ok := obj(got["options"])["expirationDate"].(time.Time); ok {
				obj(got["options"])["expirationDate"] = responseDate(value)
			}
			if !reflect.DeepEqual(conferenceOptionsJSON(t, got), c.Expected) {
				t.Fatalf("got %#v, expected %#v", got, c.Expected)
			}
		})
	}
}

func conferenceOptionsJSON(t *testing.T, value M) M {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out M
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
