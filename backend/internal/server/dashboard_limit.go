package server

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var dashboardDecimal = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// Match Math.min(100, Math.max(1, Math.floor(Number(query.limit)) || 50)).
// Repeated query values stringify as an array, rather than selecting the first.
func dashboardLimit(values []string) int {
	if len(values) == 0 {
		return 50
	}
	value := strings.TrimFunc(strings.Join(values, ","), func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	if value == "" {
		return 50
	}
	if value == "Infinity" || value == "+Infinity" {
		return 100
	}
	if value == "-Infinity" {
		return 1
	}
	if len(value) >= 2 && value[0] == '0' {
		base := 0
		switch value[1] {
		case 'x', 'X':
			base = 16
		case 'b', 'B':
			base = 2
		case 'o', 'O':
			base = 8
		}
		if base != 0 {
			if len(value) == 2 {
				return 50
			}
			n := 0
			for _, r := range value[2:] {
				digit := -1
				switch {
				case r >= '0' && r <= '9':
					digit = int(r - '0')
				case r >= 'a' && r <= 'f':
					digit = int(r-'a') + 10
				case r >= 'A' && r <= 'F':
					digit = int(r-'A') + 10
				}
				if digit < 0 || digit >= base {
					return 50
				}
				n = min(100, n*base+digit)
			}
			if n == 0 {
				return 50
			}
			return n
		}
	}
	if !dashboardDecimal.MatchString(value) {
		return 50
	}
	n, err := strconv.ParseFloat(value, 64)
	if err != nil && !math.IsInf(n, 0) {
		return 50
	}
	n = math.Floor(n)
	if n == 0 || math.IsNaN(n) {
		return 50
	}
	if n < 1 {
		return 1
	}
	if n > 100 {
		return 100
	}
	return int(n)
}
