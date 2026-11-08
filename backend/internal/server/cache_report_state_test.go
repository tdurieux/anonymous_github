package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
)

func TestCacheReportStateContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/cache-report-state.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Input struct {
			Name, Storage                                      string
			Enabled, Source, Results, SourceError, ResultError bool
		}
		Expected any
		Headers  map[string]string
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Input.Name, func(t *testing.T) {
			s := &Server{Config: Config{SharedCacheEnabled: f.Input.Enabled, Storage: f.Input.Storage}}
			for _, entry := range []struct {
				present, broken bool
				dest            **blobcache.Cache
			}{{f.Input.Source, f.Input.SourceError, &s.sourceCache}, {f.Input.Results, f.Input.ResultError, &s.resultCache}} {
				if !entry.present {
					continue
				}
				c, err := blobcache.New(t.Context(), blobcache.Options{Root: t.TempDir(), Budget: 65536, MaxObject: 4096})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { c.Close() })
				*entry.dest = c
				if entry.broken {
					c.Close()
				}
			}
			w := httptest.NewRecorder()
			result, err := s.adminCache(&request{W: w, R: httptest.NewRequest("GET", "/api/admin/cache", nil)})
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var got any
			if err = json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, f.Expected) {
				t.Fatal(string(encoded), f.Expected)
			}
			for name, value := range f.Headers {
				if w.Header().Get(name) != value {
					t.Fatal(name, w.Header(), value)
				}
			}
		})
	}
}
