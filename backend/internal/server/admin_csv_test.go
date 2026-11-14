package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestTypeScriptAdminCSV(t *testing.T) {
	raw, err := os.ReadFile("testdata/admin-csv.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Kind, Expected string
		Rows                 []M
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var output bytes.Buffer
			if err := writeAdminCSV(&output, c.Kind, c.Rows); err != nil {
				t.Fatal(err)
			}
			if output.String() != c.Expected {
				t.Fatalf("got %q; expected %q", output.String(), c.Expected)
			}
		})
	}
}

type rejectedCSVWriter struct{}

func (rejectedCSVWriter) Write([]byte) (int, error) { return 0, errors.New("synthetic_write_failure") }
func TestAdminCSVWriteError(t *testing.T) {
	if err := writeAdminCSV(rejectedCSVWriter{}, "repos", nil); err == nil {
		t.Fatal("write error ignored")
	}
}
