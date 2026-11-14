package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"os"
	"runtime"
	"strings"
	"time"
)

func main() {
	terms := []string{"first.last", "user@example.org", "dept.example.edu", "lab.io", "project.org", "Author X. Name"}
	for i := 0; i < 41; i++ {
		terms = append(terms, fmt.Sprintf("Researcher%d", i))
	}
	row := "123,456,78.91234,-45.123456\n"
	fixtures := []struct {
		name  string
		input func() string
		terms []string
	}{
		{"2 MB CSV, 47 absent terms", func() string { return strings.Repeat(row, 70000) }, terms},
		{"100 MB CSV, 47 absent terms", func() string { return strings.Repeat(row, 3600000) }, terms},
		{"50 MB CSV, sparse matches", func() string {
			return "first.last\n" + strings.Repeat(row, 1800000) + "\nhttps://host/user@example.org"
		}, terms},
		{"22 MB text, 1.2 million replacements", func() string { return strings.Repeat("Alice 123 first.last,45.678,-23.456\n", 600000) }, append([]string{"Alice"}, terms...)},
	}
	for _, f := range fixtures {
		input := f.input()
		start := time.Now()
		e, err := anonymize.New(anonymize.Options{Terms: f.terms}, anonymize.Context{Mask: "XXXX"})
		if err != nil {
			panic(err)
		}
		compile := time.Since(start)
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		start = time.Now()
		out, err := e.Transform(ctx, input, anonymize.MaxOutput)
		elapsed := time.Since(start)
		cancel()
		runtime.ReadMemStats(&after)
		result := map[string]any{"runtime": runtime.Version(), "name": f.name, "inputBytes": len(input), "compileMs": float64(compile.Microseconds()) / 1000, "matchMs": float64(elapsed.Microseconds()) / 1000, "allocatedBytes": after.TotalAlloc - before.TotalAlloc}
		if err != nil {
			result["error"] = err.Error()
		} else {
			result["outputBytes"] = len(out.Content)
			digest := sha256.Sum256([]byte(out.Content))
			result["sha256"] = hex.EncodeToString(digest[:])
		}
		json.NewEncoder(os.Stdout).Encode(result)
	}
}
