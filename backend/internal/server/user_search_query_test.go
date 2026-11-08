package server

import (
	"encoding/json"
	"net/url"
	"os"
	"testing"
)

type userSearchContract struct {
	Query         string
	TokenCalls    int
	Error         bool
	UpstreamQuery *string
}

func userSearchContracts(t *testing.T) []userSearchContract {
	t.Helper()
	raw, err := os.ReadFile("testdata/user-search.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []userSearchContract
	if err = json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	return rows
}
func TestUserSearchQueryContracts(t *testing.T) {
	for _, row := range userSearchContracts(t) {
		t.Run(row.Query, func(t *testing.T) {
			value, search, err := userSearchQuery(row.Query)
			calls := 0
			var upstream *string
			if err == nil && search {
				calls++
				var path string
				path, err = userSearchPath(value)
				if err == nil {
					u, e := url.Parse(path)
					if e != nil {
						t.Fatal(e)
					}
					q := u.Query().Get("q")
					upstream = &q
				}
			}
			if (err != nil) != row.Error || calls != row.TokenCalls || (upstream == nil) != (row.UpstreamQuery == nil) || upstream != nil && *upstream != *row.UpstreamQuery {
				t.Fatalf("contract %+v: calls=%d upstream=%v err=%v", row, calls, upstream, err)
			}
		})
	}
}
