package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestOctokitPaginationContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/github-pagination.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Count    int
		Link     string
		Conflict int
		Expected struct {
			URLs []string
			IDs  []int64
		}
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			urls, ids := []string{}, []int64{}
			s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				urls = append(urls, r.URL.String())
				if len(urls) > 2 {
					t.Fatal("unexpected pagination request")
				}
				headers := http.Header{}
				count := 1
				if len(urls) == 1 {
					count = c.Count
					headers.Set("Link", c.Link)
				}
				rows := []M{}
				for i := 0; i < count; i++ {
					rows = append(rows, M{"id": len(urls)})
				}
				body, err := json.Marshal(rows)
				if err != nil {
					t.Fatal(err)
				}
				status := 200
				if len(urls) == c.Conflict {
					status = 409
				}
				return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})}}
			err := s.githubPages(context.Background(), "/user/repos", "synthetic", "", func(row M) bool { ids = append(ids, number(row["id"])); return false })
			if err != nil || !reflect.DeepEqual(urls, c.Expected.URLs) || !reflect.DeepEqual(ids, c.Expected.IDs) {
				t.Fatalf("requests=%v ids=%v error=%v; want %+v", urls, ids, err, c.Expected)
			}
		})
	}
}
