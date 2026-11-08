package server

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestTypeScriptResourceOutput(t *testing.T) {
	raw, e := os.ReadFile("testdata/resources.json")
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Name, Kind, Operation string
		Record                M
		Expected              any
	}
	if e = json.Unmarshal(raw, &cases); e != nil {
		t.Fatal(e)
	}
	s := &Server{Config: Config{Mask: "XXXX", Hostname: "anonymous.test"}}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var out M
			var e error
			if c.Operation == "private" {
				out = resourceJSON(c.Kind, c.Record)
			} else {
				out, e = s.embeddedOutput(context.Background(), c.Kind, c.Record)
			}
			if e != nil {
				t.Fatal(e)
			}
			raw, e := json.Marshal(out)
			if e != nil {
				t.Fatal(e)
			}
			var actual any
			if e = json.Unmarshal(raw, &actual); e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(actual, c.Expected) {
				t.Fatalf("got %s; want %#v", raw, c.Expected)
			}
		})
	}
}
