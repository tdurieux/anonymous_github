// Copyright 2011 the V8 project authors. All rights reserved.
// Adapted date parsing rules; BSD-3-Clause terms in ../../licenses/V8-LICENSE.

package server

// The parsing rules follow V8's dateparser (BSD-3-Clause); see
// https://github.com/v8/v8/tree/main/src/date. Runtime parsing remains in Go.
import (
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type dateToken struct {
	kind byte
	text string
	n    int
}

func dateSpace(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' }
func dateTokens(value string) []dateToken {
	runes := []rune(value)
	out := []dateToken{}
	for i := 0; i < len(runes) && runes[i] != 0; {
		start := i
		r := runes[i]
		i++
		switch {
		case r >= '0' && r <= '9':
			for i < len(runes) && runes[i] >= '0' && runes[i] <= '9' {
				i++
			}
			text := string(runes[start:i])
			significant := strings.TrimLeft(text, "0")
			if len(significant) > 9 {
				significant = significant[:9]
			}
			n, _ := strconv.Atoi(significant)
			out = append(out, dateToken{'n', text, n})
		case strings.ContainsRune(":-+.)", r):
			out = append(out, dateToken{byte(r), string(r), 0})
		case dateSpace(r):
			out = append(out, dateToken{'s', "", 0})
		case r >= 'A':
			for i < len(runes) && runes[i] >= 'A' && !dateSpace(runes[i]) {
				i++
			}
			out = append(out, dateToken{'w', strings.ToLower(string(runes[start:i])), 0})
		case r == '(':
			depth := 1
			for i < len(runes) && runes[i] != 0 && depth > 0 {
				if runes[i] == '(' {
					depth++
				}
				if runes[i] == ')' {
					depth--
				}
				i++
			}
			out = append(out, dateToken{'?', "", 0})
		default:
			out = append(out, dateToken{'?', "", 0})
		}
	}
	return append(out, dateToken{})
}

func javascriptLegacyDate(value string) (time.Time, bool) {
	tokens := dateTokens(value)
	pos := 0
	peek := func() dateToken { return tokens[pos] }
	next := func() dateToken {
		t := tokens[pos]
		if t.kind != 0 {
			pos++
		}
		return t
	}
	skip := func(kind byte) bool {
		if tokens[pos].kind == kind {
			pos++
			return true
		}
		return false
	}
	dates := []int{}
	// Retain the consumed ISO prefix when legacy parsing takes over. Once an
	// ISO time separator is reached, invalid time syntax cannot fall back.
	token := dateToken{}
	if peek().kind == '+' || peek().kind == '-' {
		sign := next()
		token = sign
		if peek().kind == 'n' && len(peek().text) == 6 {
			year := next().n
			if sign.kind != '-' || year != 0 {
				if sign.kind == '-' {
					year = -year
				}
				dates = append(dates, year)
				token = dateToken{kind: 'i'}
			}
		}
	} else if peek().kind == 'n' && len(peek().text) == 4 {
		dates = append(dates, next().n)
		token.kind = 'i'
	} else {
		token = next()
	}
	if token.kind == 'i' {
		validPrefix := true
		if skip('-') {
			t := next()
			if t.kind != 'n' || len(t.text) != 2 || t.n < 1 || t.n > 12 {
				token = t
				validPrefix = false
			} else {
				dates = append(dates, t.n)
				if skip('-') {
					t = next()
					if t.kind != 'n' || len(t.text) != 2 || t.n < 1 || t.n > 31 {
						token = t
						validPrefix = false
					} else {
						dates = append(dates, t.n)
					}
				}
			}
		}
		if validPrefix {
			if peek().kind == 'w' && peek().text == "t" {
				return time.Time{}, false
			}
			token = next()
		}
	}
	clock := []int{}
	month := 0
	ampm := -1
	tzHour, tzMinute, tzSign := -1, -1, 1
	readNumber := len(dates) > 0
	timeExpect := func(n int) bool { return (len(clock) == 1 || len(clock) == 2) && n < 60 || len(clock) == 3 && n < 1000 }
	addTime := func(n int) bool {
		if len(clock) >= 4 {
			return false
		}
		clock = append(clock, n)
		return true
	}
	finishTime := func(n int) bool {
		if !addTime(n) {
			return false
		}
		for len(clock) < 4 {
			clock = append(clock, 0)
		}
		return true
	}
	months := []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
	zones := map[string]int{"ut": 0, "utc": 0, "z": 0, "gmt": 0, "cdt": -5, "cst": -6, "edt": -4, "est": -5, "mdt": -6, "mst": -7, "pdt": -7, "pst": -8}
	for ; token.kind != 0; token = next() {
		switch token.kind {
		case 'n':
			readNumber = true
			n := token.n
			if skip(':') {
				if skip(':') {
					if len(clock) != 0 {
						return time.Time{}, false
					}
					clock = append(clock, n, 0)
				} else {
					if !addTime(n) {
						return time.Time{}, false
					}
					skip('.')
				}
			} else if skip('.') && timeExpect(n) {
				if !addTime(n) || peek().kind != 'n' {
					return time.Time{}, false
				}
				fraction := next().text + "000"
				ms, _ := strconv.Atoi(fraction[:3])
				if !finishTime(ms) {
					return time.Time{}, false
				}
			} else if tzHour >= 0 && tzMinute < 0 && n < 60 {
				tzMinute = n
			} else if timeExpect(n) {
				if !finishTime(n) {
					return time.Time{}, false
				}
				t := peek()
				if t.kind != 0 && t.kind != 's' && t.kind != '+' && t.kind != '-' && !(t.kind == 'w' && t.text == "z") {
					return time.Time{}, false
				}
			} else {
				if len(dates) >= 3 {
					return time.Time{}, false
				}
				dates = append(dates, n)
				skip('-')
			}
		case 'w':
			named := 0
			if len(token.text) >= 3 {
				for i, name := range months {
					if token.text[:3] == name {
						named = i + 1
						break
					}
				}
			}
			if (token.text == "am" || token.text == "pm") && len(clock) > 0 {
				ampm = 0
				if token.text == "pm" {
					ampm = 12
				}
			} else if named > 0 {
				month = named
				skip('-')
			} else if zone, ok := zones[token.text]; ok && readNumber {
				tzHour = zone
				tzSign = 1
				if zone < 0 {
					tzSign = -1
					tzHour = -zone
				}
				tzMinute = 0
			} else if readNumber || peek().kind == 'n' {
				return time.Time{}, false
			}
		case '+', '-':
			if tzHour == 0 && tzMinute == 0 || len(clock) > 0 {
				tzSign = 1
				if token.kind == '-' {
					tzSign = -1
				}
				n, width := 0, 0
				if peek().kind == 'n' {
					t := next()
					n, width = t.n, len(t.text)
				}
				readNumber = true
				if peek().kind == ':' {
					tzHour, tzMinute = n, -1
				} else if width == 1 || width == 2 {
					tzHour, tzMinute = n, 0
				} else if width == 3 || width == 4 {
					tzHour, tzMinute = n/100, n%100
				} else {
					return time.Time{}, false
				}
			} else if readNumber {
				return time.Time{}, false
			}
		case ')':
			if readNumber {
				return time.Time{}, false
			}
		}
	}
	if len(dates) == 0 {
		return time.Time{}, false
	}
	for len(dates) < 3 {
		dates = append(dates, 1)
	}
	year, day := 0, 0
	if month == 0 {
		if dates[0] < 1 || dates[0] > 31 {
			year, month, day = dates[0], dates[1], dates[2]
		} else {
			month, day, year = dates[0], dates[1], dates[2]
		}
	} else if dates[0] < 1 || dates[0] > 31 {
		year, day = dates[0], dates[1]
	} else {
		day, year = dates[0], dates[1]
	}
	if year >= 0 && year <= 49 {
		year += 2000
	} else if year >= 50 && year <= 99 {
		year += 1900
	}
	if year < -300000 || year > 300000 || month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}, false
	}
	for len(clock) < 4 {
		clock = append(clock, 0)
	}
	if ampm >= 0 {
		if clock[0] > 12 {
			return time.Time{}, false
		}
		clock[0] = clock[0]%12 + ampm
	}
	if clock[0] > 24 || clock[1] > 59 || clock[2] > 59 || clock[3] > 999 || clock[0] == 24 && (clock[1] != 0 || clock[2] != 0 || clock[3] != 0) {
		return time.Time{}, false
	}
	offset := 0
	if tzHour >= 0 {
		if tzMinute < 0 {
			tzMinute = 0
		}
		offset = (tzHour*60 + tzMinute) * 60 * tzSign
	}
	if math.Abs(float64(offset)) > math.MaxInt32 {
		return time.Time{}, false
	}
	parsed := time.Date(year, time.Month(month), day, clock[0], clock[1], clock[2], clock[3]*int(time.Millisecond), time.UTC).Add(-time.Duration(offset) * time.Second)
	if math.Abs(float64(parsed.UnixMilli())) > 8.64e15 {
		return time.Time{}, false
	}
	return parsed, true
}
