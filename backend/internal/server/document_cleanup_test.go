package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type documentCleanupCase struct {
	Kind            string
	Input, Expected M
}

func documentCleanupCases(t *testing.T) []documentCleanupCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/document-cleanup.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []documentCleanupCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}
func TestTypeScriptDocumentCleanup(t *testing.T) {
	for i, c := range documentCleanupCases(t) {
		before := defaultsJSON(t, c.Input)
		got := clearedDocumentPayload(c.Kind, c.Input)
		if !reflect.DeepEqual(defaultsJSON(t, got), defaultsJSON(t, c.Expected)) {
			t.Fatalf("case %d: got %#v want %#v", i, got, c.Expected)
		}
		if !reflect.DeepEqual(defaultsJSON(t, c.Input), before) {
			t.Fatal("mutated source snapshot")
		}
	}
}
