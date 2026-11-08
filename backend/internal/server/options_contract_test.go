package server

import (
	"context"
	"encoding/json"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestTypeScriptOptions(t *testing.T) {
	raw, err := os.ReadFile("testdata/options.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Input, Output  string
		Rejected       bool
		Name, Kind     string
		Body, Expected M
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := validatedOptions(c.Kind, c.Body)
			if c.Rejected {
				api, ok := err.(*APIError)
				if !ok || api.Code != "invalid_options" || api.Status != 400 {
					t.Fatalf("got %v; expected invalid_options", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			// Compare persistence values. BSON dates have millisecond precision;
			// This contract checks stored values, not HTTP timestamp formatting.
			if value, ok := got["expirationDate"].(time.Time); ok {
				got["expirationDate"] = value.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			data, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var options anonymize.Options
			if err := json.Unmarshal(data, &options); err != nil {
				t.Fatal(err)
			}
			options.Image, options.Link = nil, nil
			engine, err := anonymize.New(options, anonymize.Context{Mask: "XXXX"})
			if err != nil {
				t.Fatal(err)
			}
			result, err := engine.Transform(context.Background(), c.Input, anonymize.MaxOutput)
			if err != nil || result.Content != c.Output {
				t.Fatalf("transformed %q; expected %q; error %v", result.Content, c.Output, err)
			}
			var actual M
			if err := json.Unmarshal(data, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, c.Expected) {
				t.Fatalf("got %s; expected %#v", data, c.Expected)
			}
		})
	}
}
