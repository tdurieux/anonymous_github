package server

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var jsISODate = regexp.MustCompile(`^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$`)

// Parse the ECMAScript ISO date forms in UTC, as used by the deployment.
// Days up to 31 normalize across month boundaries; invalid time fields do not.
func javascriptISODate(value string) (time.Time, bool) {
	parts := jsISODate.FindStringSubmatch(value)
	if parts == nil || parts[1] == "-000000" {
		return time.Time{}, false
	}
	integer := func(s string, fallback int) int {
		if s == "" {
			return fallback
		}
		n, _ := strconv.Atoi(s)
		return n
	}
	year, month, day := integer(parts[1], 0), integer(parts[2], 1), integer(parts[3], 1)
	hour, minute, second := integer(parts[4], 0), integer(parts[5], 0), integer(parts[6], 0)
	fraction := parts[7] + "000"
	ms := integer(fraction[:3], 0)
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59 || hour == 24 && (minute != 0 || second != 0 || strings.Trim(parts[7], "0") != "") {
		return time.Time{}, false
	}
	offset := 0
	if zone := parts[8]; zone != "" && zone != "Z" && zone != "z" {
		digits := strings.ReplaceAll(zone[1:], ":", "")
		hours, minutes := integer(digits[:2], 0), integer(digits[2:], 0)
		if hours > 23 || minutes > 59 {
			return time.Time{}, false
		}
		offset = (hours*60 + minutes) * 60
		if zone[0] == '-' {
			offset = -offset
		}
	}
	parsed := time.Date(year, time.Month(month), day, hour, minute, second, ms*int(time.Millisecond), time.UTC).Add(-time.Duration(offset) * time.Second)
	if math.Abs(float64(parsed.UnixMilli())) > 8.64e15 {
		return time.Time{}, false
	}
	return parsed, true
}

// javascriptDateString implements the date-string forms used by the UTC deployment.
func javascriptDateString(text string) (time.Time, bool) {
	text, _, _ = strings.Cut(text, "\x00")
	if parsed, ok := javascriptISODate(text); ok {
		return parsed, true
	}
	return javascriptLegacyDate(text)
}
