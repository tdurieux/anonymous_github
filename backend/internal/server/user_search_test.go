package server

import (
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
)

func TestGitHubUserSearchLength(t *testing.T) {
	// Expected values follow the TypeScript route's q.length >= 2 condition.
	for _, c := range []struct {
		query  string
		search bool
	}{
		{"", false}, {"a", false}, {"é", false}, {"中", false},
		{"\uffff", false}, {" ", false}, {"ab", true}, {"éa", true},
		{"中文", true}, {"e\u0301", true}, {"😀", true}, {"  ", true},
	} {
		t.Run(c.query, func(t *testing.T) {
			if got := githubUserSearchable(c.query); got != c.search {
				t.Fatalf("searchable = %v, want %v", got, c.search)
			}
			if !c.search {
				// No store or HTTP client: short queries must return before
				// credential lookup or an upstream call.
				s := &Server{}
				q := &request{R: httptest.NewRequest("GET", "/?q="+url.QueryEscape(c.query), nil)}
				got, err := s.githubUsers(q)
				if err != nil || !reflect.DeepEqual(got, []any{}) {
					t.Fatalf("response = %#v, %v", got, err)
				}
			}
		})
	}
}
