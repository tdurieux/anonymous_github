package server

import (
	"io"
	"strings"
	"testing"
)

func TestCacheReadLimit(t *testing.T) {
	for _, input := range []string{"", "1234", "12345"} {
		_, err := io.ReadAll(&cacheLimitReader{reader: strings.NewReader(input), remaining: 4})
		if len(input) <= 4 {
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		api, ok := err.(*APIError)
		if !ok || api.Status != 413 || api.Code != "file_too_big" {
			t.Fatal(err)
		}
	}
}
