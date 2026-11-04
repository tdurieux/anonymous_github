package anonymize

import (
	"context"
	"math/rand"
	"strings"
	"testing"
)

func TestASCIIFoldFinder(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 500; trial++ {
		var input strings.Builder
		for i := 0; i < 120; i++ {
			input.WriteByte("aAbBcC. _012"[rng.Intn(12)])
		}
		s := input.String()
		for _, pattern := range []string{"a", "ab", "abc", "c.c", "012", "_", ""} {
			find := asciiFoldFinder(s, pattern)
			lower := strings.ToLower(s)
			for offset := 0; offset <= len(s); offset++ {
				want := strings.Index(lower[offset:], pattern)
				if want >= 0 {
					want += offset
				}
				if got := find(offset); got != want {
					t.Fatalf("%q %q offset %d: got %d want %d", s, pattern, offset, got, want)
				}
			}
		}
	}
}

func TestASCIIFastPathMatchesRegex(t *testing.T) {
	rng := rand.New(rand.NewSource(17))
	pieces := []string{"Alice", "ALICE", "alice", "malice", "first.last", "FIRST-LAST", "first\nlast", "lab.io", "LAB/IO", "_Alice", "Alice_", " ", "\n", "https://host/Alice"}
	for _, terms := range [][]string{{"Alice", "first.last", "lab.io"}, {"Alice => FIRST-LAST", "first.last => lab.io", "lab.io => end"}} {
		fast, err := New(Options{Terms: terms}, Context{Mask: "XXXX"})
		if err != nil {
			t.Fatal(err)
		}
		reference, err := New(Options{Terms: terms}, Context{Mask: "XXXX"})
		if err != nil {
			t.Fatal(err)
		}
		for i := range reference.rules {
			reference.rules[i].fastPattern = ""
			reference.rules[i].required = ""
		}
		for trial := 0; trial < 200; trial++ {
			var s strings.Builder
			for i := 0; i < 40; i++ {
				s.WriteString(pieces[rng.Intn(len(pieces))])
				s.WriteByte(' ')
			}
			got, err := fast.Transform(context.Background(), s.String(), MaxOutput)
			if err != nil {
				t.Fatal(err)
			}
			want, err := reference.Transform(context.Background(), s.String(), MaxOutput)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("fast path differs for %q: got %#v want %#v", s.String(), got, want)
			}
		}
	}
}

func TestASCIIFoldFinderDenseFalsePrefixes(t *testing.T) {
	s := strings.Repeat("cCbB ", 1000) + "ABC abc AbC"
	find := asciiFoldFinder(s, "abc")
	for offset := 0; offset <= len(s); offset++ {
		want := strings.Index(strings.ToLower(s[offset:]), "abc")
		if want >= 0 {
			want += offset
		}
		if got := find(offset); got != want {
			t.Fatalf("offset %d: got %d want %d", offset, got, want)
		}
	}
}
