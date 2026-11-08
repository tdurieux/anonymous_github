// Package anonymize preserves the ordered transformation contract of the
// existing backend. Regular patterns use Go's linear-time engine; extensions
// use an explicitly time-bounded ECMAScript-compatible engine.
package anonymize

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/dlclark/regexp2"
	unicodeencoding "golang.org/x/text/encoding/unicode"
	"golang.org/x/text/unicode/norm"
)

const MaxInput = 100 * 1024 * 1024
const MaxOutput = 4 * MaxInput

type Options struct {
	Terms      []string `json:"terms" bson:"terms"`
	Image      *bool    `json:"image,omitempty" bson:"image,omitempty"`
	Link       *bool    `json:"link,omitempty" bson:"link,omitempty"`
	RepoName   string   `json:"repoName,omitempty"`
	BranchName string   `json:"branchName,omitempty"`
	RepoID     string   `json:"repoId,omitempty"`
	SourceURLs []string `json:"sourceURLs"`
}
type Context struct {
	Mask     string `json:"mask"`
	Hostname string `json:"hostname"`
}
type Result struct {
	Content string `json:"content"`
	Changed bool   `json:"changed"`
}
type rule struct {
	re                    *regexp.Regexp
	js                    *regexp2.Regexp
	before, after         bool
	mask                  string
	fastPattern           string
	fastBefore, fastAfter bool
	required              string
	requiredLetters       uint32
}
type Engine struct {
	rules   []rule
	options Options
	config  Context
	self    []*regexp.Regexp
}

var urlRE = regexp.MustCompile(`<?\b((https?|ftp|file)://)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b/?>?`)
var anchoredURL = regexp.MustCompile("^" + urlRE.String())
var imageRE = regexp2.MustCompile(`!\[[^\]]*\]\((?<filename>.*?)(?="|\))(?<optionalpart>".*")?\)`, regexp2.ECMAScript)
var quantified = regexp.MustCompile(`\(([\s\S]*?)\)\s*(?:[*+]|\{\d+(?:,\d*)?\})`)
var innerQuant = regexp.MustCompile(`[*+]|\{\d+(?:,\d*)?\}`)
var escapeRE = regexp.MustCompile(`[-\[\]{}()*+?.,\\^$|#]`)
var sniffRE = regexp.MustCompile(`^\(\?[:=!]?|^\(|\)$`)
var classes = map[rune]string{
	'a': "[aàáâãäåāăąǎ]", 'c': "[cçćĉċč]", 'd': "[dďđ]", 'e': "[eèéêëēĕėęěȩ]", 'g': "[gĝğġģǧ]", 'h': "[hĥħȟ]", 'i': "[iìíîïĩīĭįıǐ]", 'j': "[jĵǰ]", 'k': "[kķǩ]", 'l': "[lĺļľŀł]", 'n': "[nñńņňŉŋ]", 'o': "[oòóôõöōŏőøǒ]", 'r': "[rŕŗř]", 's': "[sśŝşšș]", 't': "[tţťŧț]", 'u': "[uùúûüũūŭůűųǔ]", 'w': "[wŵẁẃẅ]", 'y': "[yýÿŷỳ]", 'z': "[zźżž]",
}

func init() { imageRE.MatchTimeout = time.Second }
func StripDiacritics(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Diacritic, r) {
			return -1
		}
		return r
	}, norm.NFD.String(s))
}
func DiacriticInsensitive(s string) string {
	var out strings.Builder
	inClass := false
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r == '\\' && i+1 < len(runes) {
			i++
			n := runes[i]
			if strings.ContainsRune(`^$\.*+?()[]{}|/dDsSwWbBnrtvf0cxupP`, n) {
				out.WriteRune('\\')
			}
			out.WriteRune(n)
			continue
		}
		if r == '[' && !inClass {
			inClass = true
			out.WriteRune(r)
			continue
		}
		if r == ']' && inClass {
			inClass = false
			out.WriteRune(r)
			continue
		}
		if !inClass {
			if c, ok := classes[unicode.ToLower(r)]; ok {
				out.WriteString(c)
				continue
			}
		}
		out.WriteRune(r)
	}
	return out.String()
}
func ParseTerm(s string) (term, replacement string, custom bool) {
	i := strings.Index(s, "=>")
	if i < 0 {
		return s, "", false
	}
	t := strings.TrimRightFunc(s[:i], unicode.IsSpace)
	if t == "" {
		return s, "", false
	}
	return t, strings.TrimLeftFunc(s[i+2:], unicode.IsSpace), true
}
func asciiWord(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_'
}
func unicodeWord(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' }
func boundaries(pattern string) (bool, bool) {
	s := []rune(sniffRE.ReplaceAllString(pattern, ""))
	if len(s) == 0 {
		return false, false
	}
	return asciiWord(s[0]), asciiWord(s[len(s)-1])
}
func catastrophic(s string) bool {
	for _, m := range quantified.FindAllStringSubmatch(s, -1) {
		if innerQuant.MatchString(m[1]) || strings.Contains(m[1], "|") {
			return true
		}
	}
	return false
}

func New(opt Options, c Context) (*Engine, error) {
	if len(opt.Terms) > 1000 {
		return nil, errors.New("too_many_anonymization_terms")
	}
	if c.Mask == "" {
		c.Mask = "XXXX"
	}
	e := &Engine{options: opt, config: c}
	for i, s := range opt.Terms {
		if len(s) > 8192 {
			return nil, errors.New("anonymization_term_too_large")
		}
		if strings.TrimSpace(s) == "" {
			continue
		}
		term, mask, custom := ParseTerm(s)
		if !custom {
			mask = fmt.Sprintf("%s-%d", c.Mask, i+1)
		}
		if _, err := regexp2.Compile(term, regexp2.ECMAScript|regexp2.IgnoreCase); err != nil || catastrophic(term) {
			term = escapeRE.ReplaceAllStringFunc(term, func(s string) string { return `\` + s })
		}
		stripped := StripDiacritics(term)
		for pass, variant := range []string{term, DiacriticInsensitive(stripped)} {
			sniff := term
			if pass == 1 {
				sniff = stripped
			}
			before, after := boundaries(sniff)
			source := variant
			if pass == 0 {
				if before {
					source = `\b` + source
				}
				if after {
					source += `\b`
				}
			}
			r := rule{before: pass == 1 && before, after: pass == 1 && after, mask: mask}
			if sniff != "" && isASCII(sniff) && !strings.ContainsAny(sniff, `\^$*+?()[]{}|`) {
				r.fastPattern = strings.ToLower(sniff)
				r.fastBefore = before
				r.fastAfter = after
				for _, piece := range strings.Split(r.fastPattern, ".") {
					// Share absence checks for numbered names such as Researcher0
					// through Researcher40. A required prefix is only a rejection
					// filter; the full pattern still decides every replacement.
					prefix := strings.TrimRight(piece, "0123456789")
					if len(prefix) >= 3 {
						piece = prefix
					}
					if len(piece) > len(r.required) {
						r.required = piece
					}
				}
				_, r.requiredLetters = asciiLetters(r.required)
			}
			var err error
			r.re, err = regexp.Compile("(?i)" + source)
			// Go's FindAll omits an empty match adjacent to a nonempty match.
			// ECMAScript global replacement retains it; use the compatible iterator.
			if err == nil {
				plain, pe := regexp.Compile("(?i)" + variant)
				if pe == nil && plain.MatchString("") {
					r.re = nil
					err = errors.New("empty_match_requires_ecmascript_iterator")
				}
			}
			if err != nil {
				if pass == 1 {
					if before {
						source = `(?<![\p{L}\p{N}_])` + source
					}
					if after {
						source += `(?![\p{L}\p{N}_])`
					}
				}
				r.js, err = regexp2.Compile(javascriptBoundaries(source, pass == 1), regexp2.ECMAScript|regexp2.IgnoreCase)
				if err != nil {
					continue
				}
				r.js.MatchTimeout = time.Second
				r.before = false
				r.after = false
			}
			e.rules = append(e.rules, r)
		}
	}
	links := opt.SourceURLs
	// Retain the historical API for direct callers. Provider-backed resources
	// always supply their adapter's explicit list, including an empty list.
	if links == nil && opt.RepoName != "" && opt.BranchName != "" {
		links = []string{"https://raw.githubusercontent.com/" + opt.RepoName + "/" + opt.BranchName, "https://github.com/" + opt.RepoName + "/blob/" + opt.BranchName, "https://github.com/" + opt.RepoName + "/tree/" + opt.BranchName, "https://github.com/" + opt.RepoName}
	}
	for _, link := range links {
		if link != "" {
			e.self = append(e.self, regexp.MustCompile("(?i)"+regexp.QuoteMeta(link)))
		}
	}

	return e, nil
}

// boundedReplace checks allocation limits before appending any replacement.
func boundedReplace(ctx context.Context, s string, find func(int) (int, int, error), replacement func(string) (string, error), limit int) (string, error) {
	var out strings.Builder
	cursor, search := 0, 0
	matched := false
	for search <= len(s) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		start, end, err := find(search)
		if err != nil {
			return "", err
		}
		if start < 0 {
			break
		}
		value, err := replacement(s[start:end])
		if err != nil {
			return "", err
		}
		if value != s[start:end] {
			if out.Len()+start-cursor+len(value) > limit {
				return "", errors.New("anonymized_output_too_large")
			}
			if !matched {
				out.Grow(min(len(s), limit))
			}
			out.WriteString(s[cursor:start])
			out.WriteString(value)
			cursor = end
			matched = true
		}
		search = end
		if end == start {
			if end == len(s) {
				break
			}
			_, n := utf8.DecodeRuneInString(s[end:])
			search += n
		}
	}
	if !matched {
		return s, nil
	}
	if out.Len()+len(s)-cursor > limit {
		return "", errors.New("anonymized_output_too_large")
	}
	out.WriteString(s[cursor:])
	return out.String(), nil
}
func findRE(re *regexp.Regexp, s string) func(int) (int, int, error) {
	// Slicing before a \b or ^ changes its meaning. FindAll preserves the full
	// context, but allocates per match; rule.replace below uses a rune iterator.
	const matchLimit = 1_000_000
	matches := re.FindAllStringIndex(s, matchLimit+1)
	i := 0
	return func(offset int) (int, int, error) {
		if len(matches) > matchLimit {
			return -1, -1, errors.New("anonymization_match_limit_exceeded")
		}
		for i < len(matches) && matches[i][0] < offset {
			i++
		}
		if i >= len(matches) {
			return -1, -1, nil
		}
		m := matches[i]
		i++
		return m[0], m[1], nil
	}
}
func (r rule) replace(ctx context.Context, s string, limit int) (string, error) {
	if r.fastPattern != "" && isASCII(s) {
		return r.replaceASCII(ctx, s, limit)
	}
	if r.js != nil {
		match, err := r.js.FindStringMatch(s)
		if err != nil {
			return "", errors.New("anonymization_regex_timeout")
		}
		if match == nil {
			return s, nil
		}
		// regexp2 owns the rune input. Translate its monotonically increasing
		// offsets incrementally instead of allocating another rune slice and
		// an input-sized byte-offset table.
		runeOffset, byteOffset := 0, 0
		advance := func(target int) int {
			for runeOffset < target {
				_, width := utf8.DecodeRuneInString(s[byteOffset:])
				byteOffset += width
				runeOffset++
			}
			return byteOffset
		}
		finder := func(_ int) (int, int, error) {
			if err != nil {
				return -1, -1, errors.New("anonymization_regex_timeout")
			}
			if match == nil {
				return -1, -1, nil
			}
			start := advance(match.Index)
			end := advance(match.Index + match.Length)
			match, err = r.js.FindNextMatch(match)
			return start, end, nil
		}
		return boundedReplace(ctx, s, finder, func(string) (string, error) { return r.mask, nil }, limit)
	}
	finder := findRE(r.re, s)
	filtered := func(offset int) (int, int, error) {
		for {
			start, end, err := finder(offset)
			if err != nil || start < 0 {
				return start, end, err
			}
			if r.before && start > 0 {
				v, _ := utf8.DecodeLastRuneInString(s[:start])
				if unicodeWord(v) {
					continue
				}
			}
			if r.after && end < len(s) {
				v, _ := utf8.DecodeRuneInString(s[end:])
				if unicodeWord(v) {
					continue
				}
			}
			return start, end, nil
		}
	}
	return boundedReplace(ctx, s, filtered, func(string) (string, error) { return r.mask, nil }, limit)
}
func (e *Engine) Transform(ctx context.Context, input string, limit int) (Result, error) {
	return e.transform(ctx, input, limit, false)
}
func (e *Engine) Path(ctx context.Context, input string) (string, error) {
	r, err := e.transform(ctx, input, MaxOutput, true)
	return r.Content, err
}
func (e *Engine) transform(ctx context.Context, input string, limit int, pathOnly bool) (Result, error) {
	if len(input) > MaxInput {
		return Result{}, errors.New("anonymization_input_too_large")
	}
	if limit <= 0 || limit > MaxOutput {
		limit = MaxOutput
	}
	content := input
	changed := false
	if !pathOnly {
		if e.options.Image != nil && !*e.options.Image {
			var err error
			content, err = imageRE.ReplaceFunc(content, func(regexp2.Match) string { changed = true; return e.config.Mask }, -1, -1)
			if err != nil {
				return Result{}, errors.New("anonymization_regex_timeout")
			}
			if len(content) > limit {
				return Result{}, errors.New("anonymized_output_too_large")
			}
		}
		if e.options.Link != nil && !*e.options.Link {
			var err error
			content, err = boundedReplace(ctx, content, findURL(content), func(string) (string, error) { changed = true; return e.config.Mask, nil }, limit)
			if err != nil {
				return Result{}, err
			}
		}
		for _, re := range e.self {
			s := content
			finder := findRE(re, s)
			checked := func(offset int) (int, int, error) {
				for {
					a, b, err := finder(offset)
					if a < 0 || err != nil {
						return a, b, err
					}
					if b == len(s) || strings.ContainsRune("/?#", rune(s[b])) {
						return a, b, nil
					}
				}
			}
			var err error
			content, err = boundedReplace(ctx, s, checked, func(string) (string, error) {
				changed = true
				return "https://" + e.config.Hostname + "/r/" + e.options.RepoID, nil
			}, limit)
			if err != nil {
				return Result{}, err
			}
		}
	}
	ascii, letters := asciiLetters(content)
	presence := map[string]bool{}
	for _, r := range e.rules {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		if ascii && r.required != "" {
			if r.requiredLetters&^letters != 0 {
				continue
			}
			present, ok := presence[r.required]
			if !ok {
				present = asciiFoldFinder(content, r.required)(0) >= 0
				presence[r.required] = present
			}
			if !present {
				continue
			}
		}
		previous := content
		if !pathOnly && strings.Contains(content, "://") {
			var err error
			content, err = boundedReplace(ctx, content, findURL(content), func(url string) (string, error) {
				v, err := r.replace(ctx, url, limit)
				if err != nil {
					return "", err
				}
				if v != url {
					changed = true
					return r.mask, nil
				}
				return url, nil
			}, limit)
			if err != nil {
				return Result{}, err
			}
		}
		if content != previous {
			maskASCII, maskLetters := asciiLetters(r.mask)
			ascii = ascii && maskASCII
			letters |= maskLetters
		}
		var next string
		var err error
		if ascii && r.fastPattern != "" {
			next, err = r.replaceASCII(ctx, content, limit)
		} else {
			next, err = r.replace(ctx, content, limit)
		}
		if err != nil {
			return Result{}, err
		}
		if next != content {
			changed = true
		}
		content = next
		if content != previous {
			// Replacements only introduce mask bytes. A conservative letter set
			// avoids rescanning the entire ASCII output after every rule. Stale
			// letters can cause extra searches, never suppress a valid match.
			if ascii {
				maskASCII, maskLetters := asciiLetters(r.mask)
				ascii = maskASCII
				letters |= maskLetters
			} else {
				ascii, letters = asciiLetters(content)
			}
			presence = map[string]bool{}
		}
	}
	return Result{content, changed}, nil
}

// A table avoids a variable shift and several branches for every input byte.
// The high bit records non-ASCII input; lower bits form a conservative filter.
var asciiLetterBits = func() [256]uint32 {
	var table [256]uint32
	for i := 0; i < 256; i++ {
		b := byte(i) | 32
		if i >= 128 {
			table[i] = 1 << 31
		} else if b >= 'a' && b <= 'z' {
			table[i] = 1 << (b - 'a')
		}
	}
	return table
}()

func asciiLetters(s string) (bool, uint32) {
	var bits uint32
	i := 0
	for ; i+8 <= len(s); i += 8 {
		bits |= asciiLetterBits[s[i]] | asciiLetterBits[s[i+1]] | asciiLetterBits[s[i+2]] | asciiLetterBits[s[i+3]] |
			asciiLetterBits[s[i+4]] | asciiLetterBits[s[i+5]] | asciiLetterBits[s[i+6]] | asciiLetterBits[s[i+7]]
	}
	for ; i < len(s); i++ {
		bits |= asciiLetterBits[s[i]]
	}
	return bits&(1<<31) == 0, bits & ((1 << 26) - 1)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 128 {
			return false
		}
	}
	return true
}

// asciiFoldFinder searches monotonically without allocating a lowercase copy.
// Cache both anchor-byte candidates so an absent case is scanned only once,
// rather than scanning the remaining suffix again for every dense match.
func asciiFoldFinder(s, pattern string) func(int) int {
	if pattern == "" {
		return func(offset int) int { return offset }
	}
	anchor := len(pattern) - 1
	first := pattern[anchor]
	upper := first
	if first >= 'a' && first <= 'z' {
		upper -= 'a' - 'A'
	}
	lowerAt, upperAt := -2, -2
	folded := ""
	fallback := false
	misses := 0
	locate := func(at *int, offset int, b byte) {
		if *at == -2 || (*at >= 0 && *at < offset) {
			*at = strings.IndexByte(s[offset:], b)
			if *at >= 0 {
				*at += offset
			}
		}
	}
	return func(offset int) int {
		if fallback {
			index := strings.Index(folded[offset:], pattern)
			if index >= 0 {
				index += offset
			}
			return index
		}
		for offset+len(pattern) <= len(s) {
			locate(&lowerAt, offset+anchor, first)
			candidate := lowerAt
			if upper != first {
				locate(&upperAt, offset+anchor, upper)
				if candidate < 0 || upperAt >= 0 && upperAt < candidate {
					candidate = upperAt
				}
			}
			if candidate < 0 {
				return -1
			}
			candidate -= anchor
			match := true
			for i := 0; i < anchor; i++ {
				if asciiLower(s[candidate+i]) != pattern[i] {
					match = false
					break
				}
			}
			if match {
				misses = 0
				return candidate
			}
			offset = candidate + 1
			misses++
			if misses == 128 {
				// Dense false anchor-byte matches favor the standard substring
				// search. Bound speculative scanning before paying for a copy.
				folded, fallback = strings.ToLower(s), true
				index := strings.Index(folded[offset:], pattern)
				if index >= 0 {
					index += offset
				}
				return index
			}
		}
		return -1
	}
}
func asciiLower(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

func (r rule) replaceASCII(ctx context.Context, s string, limit int) (string, error) {
	pattern := r.fastPattern
	prefix := pattern
	if i := strings.IndexByte(prefix, '.'); i >= 0 {
		prefix = prefix[:i]
	}
	findPrefix := asciiFoldFinder(s, prefix)
	finder := func(offset int) (int, int, error) {
		for offset+len(pattern) <= len(s) {
			if err := ctx.Err(); err != nil {
				return -1, -1, err
			}
			start := offset
			if prefix != "" {
				index := findPrefix(offset)
				if index < 0 {
					return -1, -1, nil
				}
				start = index
			}
			end := start + len(pattern)
			if end > len(s) {
				return -1, -1, nil
			}
			valid := true
			for i := len(prefix); i < len(pattern); i++ {
				if pattern[i] == '.' {
					if s[start+i] == '\n' {
						valid = false
						break
					}
				} else if pattern[i] != asciiLower(s[start+i]) {
					valid = false
					break
				}
			}
			if valid && r.fastBefore && start > 0 && asciiWord(rune(s[start-1])) == asciiWord(rune(s[start])) {
				valid = false
			}
			if valid && r.fastAfter && end < len(s) && asciiWord(rune(s[end-1])) == asciiWord(rune(s[end])) {
				valid = false
			}
			if valid {
				return start, end, nil
			}
			offset = start + 1
		}
		return -1, -1, nil
	}
	return boundedReplace(ctx, s, finder, func(string) (string, error) { return r.mask, nil }, limit)
}
func findURL(s string) func(int) (int, int, error) {
	return func(offset int) (int, int, error) {
		for offset < len(s) {
			i := strings.Index(s[offset:], "://")
			if i < 0 {
				return -1, -1, nil
			}
			colon := offset + i
			offset = colon + 3
			for _, scheme := range []string{"https", "http", "ftp", "file"} {
				start := colon - len(scheme)
				if start < 0 || s[start:colon] != scheme {
					continue
				}
				if start > 0 && asciiWord(rune(s[start-1])) {
					continue
				}
				if start > 0 && s[start-1] == '<' {
					start--
				}
				m := anchoredURL.FindStringIndex(s[start:])
				if m != nil {
					return start + m[0], start + m[1], nil
				}
			}
		}
		return -1, -1, nil
	}
}

// Bytes preserves the original byte sequence when the text is unchanged.
func (e *Engine) Bytes(ctx context.Context, input []byte, limit int) ([]byte, bool, error) {
	decoded, decodeErr := unicodeencoding.UTF8.NewDecoder().Bytes(input)
	if decodeErr != nil {
		return nil, false, decodeErr
	}
	text := string(decoded)
	result, err := e.Transform(ctx, text, limit)
	if err != nil {
		return nil, false, err
	}
	if result.Content == text {
		if len(input) > limit {
			return nil, false, errors.New("anonymized_output_too_large")
		}
		return input, result.Changed, nil
	}
	return []byte(result.Content), result.Changed, nil
}
