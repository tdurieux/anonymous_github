package anonymize

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

func TestOutputAndLimits(t *testing.T) {
	e, err := New(Options{Terms: []string{"Alice=>Bob", "Bob=>$&"}}, Context{Mask: "XXXX"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := e.Transform(context.Background(), "Alice and Bob", 1024)
	if err != nil || r.Content != "$& and $&" {
		t.Fatal(r, err)
	}
	if _, err = e.Transform(context.Background(), "Alice and Bob", 2); err == nil {
		t.Fatal("output limit ignored")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = e.Transform(ctx, "Alice", 1024); err == nil {
		t.Fatal("cancellation ignored")
	}
}
func TestOriginalBytesPreserved(t *testing.T) {
	e, _ := New(Options{Terms: []string{"Alice"}}, Context{})
	for _, raw := range [][]byte{{0xc3, 0x28, 0xff, 0xfe}, []byte("plain \r\nΔ café"), {0xff, 0xfe, 'a'}} {
		out, _, err := e.Bytes(context.Background(), raw, 1024)
		if err != nil || !bytes.Equal(out, raw) {
			t.Fatalf("changed unmatched bytes: %x %v", out, err)
		}
	}
}
func TestRegexDeadline(t *testing.T) {
	e, err := New(Options{Terms: []string{"a+a+a+a+a+a+b(?=x)"}}, Context{})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err = e.Transform(context.Background(), strings.Repeat("a", 250), 1024); err == nil {
		t.Fatal("expected regex timeout")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("regex timeout exceeded")
	}
}
func FuzzOutputBound(f *testing.F) {
	f.Add("Alice", "hello Alice")
	f.Add("a*", "aaa")
	f.Add("研究", "研究 foo")
	f.Fuzz(func(t *testing.T, term, input string) {
		if len(term) > 256 || len(input) > 4096 {
			return
		}
		e, err := New(Options{Terms: []string{term}}, Context{})
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		r, err := e.Transform(ctx, input, 8192)
		if err == nil && len(r.Content) > 8192 {
			t.Fatal("output exceeded limit")
		}
	})
}
func BenchmarkDenseReplacements(b *testing.B) {
	input := strings.Repeat("Alice 123 first.last,45.678,-23.456\n", 600000)
	e, _ := New(Options{Terms: []string{"Alice", "first.last"}}, Context{})
	b.SetBytes(int64(len(input)))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := e.Transform(context.Background(), input, MaxOutput); err != nil {
			b.Fatal(err)
		}
	}
}

func TestReplacementIntroducesSearchCharacters(t *testing.T) {
	for _, tc := range []struct {
		terms       []string
		input, want string
	}{
		{[]string{"Alice=>Researcher0", "Researcher0=>done"}, "Alice", "done"},
		{[]string{"Alice=>é", "é=>done"}, "Alice", "done"},
		{[]string{"x.=>a", "ab=>done"}, "x-b", "done"},
		{[]string{"Alice=>ALICE"}, "Alice", "ALICE"},
		{[]string{"(?<=😀)Alice=>X"}, "😀Alice 😀Alice", "😀X 😀X"},
		{[]string{"(?=😀)=>X"}, "😀😀", "XX😀XX😀"},
	} {
		e, err := New(Options{Terms: tc.terms}, Context{})
		if err != nil {
			t.Fatal(err)
		}
		got, err := e.Transform(context.Background(), tc.input, 1024)
		if err != nil || got.Content != tc.want {
			t.Fatalf("%v %q: got %q want %q, %v", tc.terms, tc.input, got.Content, tc.want, err)
		}
	}
}

func BenchmarkFallbackOffsets(b *testing.B)    { benchmarkFallback(b, "Alice(?=!)") }
func BenchmarkFallbackLookaround(b *testing.B) { benchmarkFallback(b, "(?<=!)Alice(?=!)") }
func benchmarkFallback(b *testing.B, pattern string) {
	input := strings.Repeat("😀 café not-a-name\n", 100000) + "!Alice!"
	e, err := New(Options{Terms: []string{pattern}}, Context{})
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(input)))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := e.Transform(context.Background(), input, MaxOutput); err != nil {
			b.Fatal(err)
		}
	}
}

func TestFallbackASCIIBoundaries(t *testing.T) {
	for _, tc := range []struct{ pattern, input, want string }{
		{`(?<=😀)Alice=>X`, "😀Aliceé", "😀Xé"},
		{`\bAlice(?=!)=>X`, "éAlice!", "éX!"},
		{`\BAlice(?=!)=>X`, "éAlice!", "éAlice!"},
		{`\BAlice(?=!)=>X`, "xAlice!", "xX!"},
	} {
		engine, e := New(Options{Terms: []string{tc.pattern}}, Context{})
		if e != nil {
			t.Fatal(e)
		}
		got, e := engine.Transform(context.Background(), tc.input, 1024)
		if e != nil || got.Content != tc.want {
			t.Fatalf("%s: %q != %q: %v", tc.pattern, got.Content, tc.want, e)
		}
	}
}

func TestASCIIFilters(t *testing.T) {
	for i := 0; i < 256; i++ {
		s := strings.Repeat(string([]byte{byte(i)}), 17)
		ascii, letters := asciiLetters(s)
		if ascii != (i < 128) {
			t.Fatalf("ASCII classification for %d", i)
		}
		var expected uint32
		b := byte(i) | 32
		if i < 128 && b >= 'a' && b <= 'z' {
			expected = 1 << (b - 'a')
		}
		if letters != expected {
			t.Fatalf("letters for %d: %x != %x", i, letters, expected)
		}
		if ascii && string(asciiLower(byte(i))) != strings.ToLower(string(byte(i))) {
			t.Fatalf("case folding for %d", i)
		}
	}
}
