package anonymize

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

type brokenInput struct{ err error }

func (r brokenInput) Read([]byte) (int, error) { return 0, r.err }

func TestInputFailureDoesNotPublishOrLaunchWorker(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	pool := NewPool("/not-a-worker", 1)
	defer pool.Close()
	failure := errors.New("private upstream details")
	for i := 0; i < 2; i++ {
		input := io.MultiReader(strings.NewReader("partial content"), brokenInput{failure})
		output, _, cleanup, err := pool.Process(t.Context(), input, ProcessRequest{CacheScope: "input-failure", CacheOwner: "fixture"})
		var wrapped *InputError
		if !errors.As(err, &wrapped) || !errors.Is(err, failure) || strings.Contains(err.Error(), "private") {
			t.Fatal(err)
		}
		if output != nil || cleanup != nil {
			t.Fatal("failed input produced output")
		}
		if stats := pool.Stats(); stats["workerStarts"] != uint64(0) || stats["running"] != 0 {
			t.Fatal(stats)
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "anonymous-go-text-") {
				t.Fatal("failed input left spool files", entry.Name())
			}
		}
	}
}
