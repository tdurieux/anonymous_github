package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestTypeScriptAdminUser(t *testing.T) {
	raw, err := os.ReadFile("testdata/admin-user.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now   time.Time
		Cases []struct {
			Name           string
			User, Expected M
			Repositories   []M
		}
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			value := adminUserJSON(c.User, c.Repositories, fixture.Now)
			raw, err := json.Marshal(responseJSON(value))
			if err != nil {
				t.Fatal(err)
			}
			var actual M
			if err := json.Unmarshal(raw, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, c.Expected) {
				t.Fatalf("got %s; expected %#v", raw, c.Expected)
			}
		})
	}
}
