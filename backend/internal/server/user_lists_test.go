package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestTypeScriptUserMembership(t *testing.T) {
	raw, err := os.ReadFile("testdata/user-membership.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ User, Expected M }
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		raw, err := json.Marshal(repositoryMembership(c.User))
		if err != nil {
			t.Fatal(err)
		}
		var got M
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, c.Expected) {
			t.Fatalf("got %s; expected %#v", raw, c.Expected)
		}
	}
}
