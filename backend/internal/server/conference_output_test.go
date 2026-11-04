package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestTypeScriptConferenceOutput(t *testing.T) {
	raw, err := os.ReadFile("testdata/conference-output.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now   time.Time
		Cases []struct {
			Name     string
			Record   M
			Expected M
		}
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			value := conferenceJSONAt(c.Record, fixture.Now)
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var actual M
			if err := json.Unmarshal(raw, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, c.Expected) {
				t.Fatalf("got %s; expected %+v", raw, c.Expected)
			}
		})
	}
}
