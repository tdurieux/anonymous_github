package server

import (
	"io"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
)

func TestArchiveSpoolWithoutProviderVerifier(t *testing.T) {
	for _, body := range []string{"", "content"} {
		row := M{"path": "", "name": "file", "size": len(body)}
		input, err := spoolArchiveInput(t.Context(), strings.NewReader(body), int64(len(body)), row, &fixtureProvider{}, provider.Access{}, make([]byte, 32<<10))
		if err != nil {
			t.Fatal(err)
		}
		actual, err := io.ReadAll(input.file)
		input.close()
		if err != nil || string(actual) != body {
			t.Fatal(string(actual), err)
		}
	}
	for _, size := range []int64{-1, anonymize.MaxInput + 1, 3, 5} {
		input, err := spoolArchiveInput(t.Context(), strings.NewReader("data"), size, M{"name": "file", "size": 4}, &fixtureProvider{}, provider.Access{}, make([]byte, 32<<10))
		input.close()
		if err == nil {
			t.Fatal("bad size accepted", size)
		}
	}
}
