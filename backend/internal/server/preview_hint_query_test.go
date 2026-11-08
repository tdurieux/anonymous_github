package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestPreviewHintContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/preview-hints.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Query  string
		Filter any
		Error  bool
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		filter, err := previewHintFilter(c.Query)
		if (err != nil) != c.Error {
			t.Fatal(c, filter, err)
		}
		if err != nil {
			continue
		}
		encoded, err := json.Marshal(filter)
		if err != nil {
			t.Fatal(err)
		}
		var actual any
		if err = json.Unmarshal(encoded, &actual); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, c.Filter) {
			t.Fatal(c.Query, actual, c.Filter)
		}
	}
	for _, query := range []string{"repositoryID[$ne]=507f1f77bcf86cd799439011", "repositoryID[$exists]=true"} {
		if _, err := previewHintFilter(query); err == nil {
			t.Fatal("operator accepted", query)
		}
	}
}
