package server

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestTypeScriptQuotaKeys(t *testing.T) {
	raw, err := os.ReadFile("testdata/github-quota.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Token, Scope string
		Expected           []string
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := legacyGitHubQuotaKeys(c.Token, c.Scope)
			if !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("got %v, want %v", got, c.Expected)
			}
		})
	}
}

func TestLegacyQuotaRejectsMalformedScopes(t *testing.T) {
	for _, scope := range []string{"app-user:not-an-object-id", "installation:123:../token", "installation:123:0", "installation:123:-1", "installation:123:042", "installation:123:42:other", "app:123:456"} {
		if keys := legacyGitHubQuotaKeys("synthetic", scope); len(keys) != 1 {
			t.Fatal("unexpected scope alias", scope, keys)
		}
	}
}
