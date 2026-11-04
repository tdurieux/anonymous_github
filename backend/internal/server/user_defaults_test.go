package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type defaultsCase struct {
	Name         string
	Body, Stored M
	Expected     any
	Rejected     bool
}
type defaultsFixture struct {
	Cases   []defaultsCase
	Initial []struct {
		User     M
		Expected any
	}
}

func userDefaultsFixture(t *testing.T) defaultsFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/user-defaults.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture defaultsFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}
func defaultsJSON(t *testing.T, value any) any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestTypeScriptUserDefaults(t *testing.T) {
	fixture := userDefaultsFixture(t)
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			stored, err := castUserDefaults(c.Body)
			if c.Rejected {
				if err == nil {
					t.Fatal("invalid defaults accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(defaultsJSON(t, stored), defaultsJSON(t, c.Stored)) {
				t.Fatalf("stored %#v; expected %#v", stored, c.Stored)
			}
			got := userDefaults(M{"default": stored})
			if !reflect.DeepEqual(defaultsJSON(t, got), c.Expected) {
				t.Fatalf("read %#v; expected %#v", got, c.Expected)
			}
		})
	}
	for _, c := range fixture.Initial {
		if got := defaultsJSON(t, userDefaults(c.User)); !reflect.DeepEqual(got, c.Expected) {
			t.Fatalf("initial %#v; expected %#v", got, c.Expected)
		}
	}
}
func TestUserProfileOptionalPhoto(t *testing.T) {
	for _, u := range []M{{"username": "alice"}, {"username": "alice", "photo": nil}, {"username": "alice", "photo": "https://avatar.test", "isAdmin": true}} {
		got := userProfile(u)
		_, hasPhoto := got["photo"]
		_, wantPhoto := u["photo"]
		if hasPhoto != wantPhoto || got["username"] != "alice" || got["isAdmin"] != boolean(u["isAdmin"]) {
			t.Fatal(got)
		}
	}
}
