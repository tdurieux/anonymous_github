// cache-benchmark measures complete worker/cache operations, including input
// spooling, output reads and cleanup. It makes no HTTP or database requests.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
)

type sample struct {
	Mode         string    `json:"mode"`
	MedianMs     float64   `json:"medianMs"`
	P95Ms        float64   `json:"p95Ms"`
	SamplesMs    []float64 `json:"samplesMs"`
	WorkerStarts uint64    `json:"workerStarts"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "anonymization-worker" {
		os.Exit(anonymize.RunProcess())
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	fixtures := []struct {
		name, input string
		terms       []string
	}{
		{"small text", strings.Repeat("hello Alice and Bob\n", 3000), []string{"Alice", "Bob"}},
		{"2 MiB absent terms", strings.Repeat("0123456789abcdef\n", 123362), []string{"Alice", "Researcher", "user@example.org"}},
		{"2 MiB replacements", strings.Repeat("Alice met Bob\n", 149797), []string{"Alice", "Bob"}},
		{"128 KiB JavaScript boundary", strings.Repeat("éAliceé Alice\n", 8192), []string{"\\bAlice\\b"}},
	}
	for _, fixture := range fixtures {
		pool := anonymize.NewPool(executable, 1)
		request := anonymize.ProcessRequest{Options: anonymize.Options{Terms: fixture.terms}, Context: anonymize.Context{Mask: "XXXX", Hostname: "anonymous.test"}, MaxOutput: anonymize.MaxOutput, CacheScope: "benchmark-revision", CacheOwner: "benchmark"}
		var expected string
		var outputBytes int64
		execute := func() (float64, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			start := time.Now()
			file, _, cleanup, err := pool.Process(ctx, strings.NewReader(fixture.input), request)
			if err != nil {
				return 0, err
			}
			digest := sha256.New()
			n, err := io.Copy(digest, file)
			cleanup()
			elapsed := float64(time.Since(start)) / float64(time.Millisecond)
			if err != nil {
				return 0, err
			}
			hash := hex.EncodeToString(digest.Sum(nil))
			if expected != "" && hash != expected {
				return 0, fmt.Errorf("%s output mismatch", fixture.name)
			}
			expected, outputBytes = hash, n
			return elapsed, nil
		}
		samples := []sample{}
		for _, mode := range []string{"cold", "warm"} {
			result := sample{Mode: mode, SamplesMs: []float64{}}
			before := pool.Stats()["workerStarts"].(uint64)
			for i := 0; i < 7; i++ {
				if mode == "cold" {
					pool.RemoveResults("benchmark")
				}
				elapsed, err := execute()
				if err != nil {
					pool.Close()
					return err
				}
				result.SamplesMs = append(result.SamplesMs, elapsed)
			}
			result.WorkerStarts = pool.Stats()["workerStarts"].(uint64) - before
			if mode == "warm" && result.WorkerStarts != 0 {
				pool.Close()
				return fmt.Errorf("warm cache launched a worker")
			}
			sorted := append([]float64(nil), result.SamplesMs...)
			sort.Float64s(sorted)
			result.MedianMs, result.P95Ms = sorted[len(sorted)/2], sorted[len(sorted)-1]
			samples = append(samples, result)
		}
		pool.Close()
		result := map[string]any{"fixture": fixture.name, "runtime": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "cpuCount": runtime.NumCPU(), "measuredAt": time.Now().UTC().Format(time.RFC3339), "inputBytes": len(fixture.input), "outputBytes": outputBytes, "outputSHA256": expected, "samples": samples, "medianSpeedup": samples[0].MedianMs / samples[1].MedianMs, "scope": "single sequential worker/cache path; excludes HTTP, MongoDB, Redis, provider access, and authorization"}
		if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
			return err
		}
	}
	return nil
}
