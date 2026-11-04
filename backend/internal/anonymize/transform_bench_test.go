package anonymize

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func BenchmarkReplacementPaths(b *testing.B) {
	terms := []string{"first.last", "user@example.org", "dept.example.edu", "lab.io", "project.org", "Author X. Name"}
	for i := 0; i < 41; i++ {
		terms = append(terms, fmt.Sprintf("Researcher%d", i))
	}
	for _, name := range []string{"sparse", "dense"} {
		b.Run(name, func(b *testing.B) {
			input := "first.last\n" + strings.Repeat("123,456,78.91234,-45.123456\n", 1800000) + "\nhttps://host/user@example.org"
			rules := terms
			if name == "dense" {
				input = strings.Repeat("Alice 123 first.last,45.678,-23.456\n", 600000)
				rules = append([]string{"Alice"}, terms...)
			}
			engine, err := New(Options{Terms: rules}, Context{Mask: "XXXX"})
			if err != nil {
				b.Fatal(err)
			}
			b.SetBytes(int64(len(input)))
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				if _, err := engine.Transform(context.Background(), input, MaxOutput); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
