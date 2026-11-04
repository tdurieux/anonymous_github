package server

import (
	"math"
	"math/big"
	"regexp"
	"strings"
	"unicode"
)

var adminSortField = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.]*$`)

func adminListPage(raw string) (float64, float64, M, bool, error) {
	values := parseExtendedQuery(raw).object
	pageText, err := values["page"].stringValue()
	if err != nil {
		return 0, 0, nil, false, err
	}
	page := adminParseInt(pageText, 1)
	limitText, err := values["limit"].stringValue()
	if err != nil {
		return 0, 0, nil, false, err
	}
	limit := math.Min(adminParseInt(limitText, 10), 1000)
	field, scalar := values["sort"].scalarValue()
	if !scalar || !adminSortField.MatchString(field) {
		field = "_id"
	}
	direction := int64(-1)
	if value, ok := values["direction"].scalarValue(); ok && value == "asc" {
		direction = 1
	}
	format, _ := values["format"].scalarValue()
	return page, limit, M{field: direction}, format == "csv", nil
}

// parseInt without a radix accepts a sign, decimal digits or a hexadecimal
// prefix, then rounds the integer to JavaScript's Number representation.
func adminParseInt(value string, fallback float64) float64 {
	value = strings.TrimLeftFunc(value, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	sign := 1.0
	if len(value) > 0 && (value[0] == '+' || value[0] == '-') {
		if value[0] == '-' {
			sign = -1
		}
		value = value[1:]
	}
	base := 10
	if strings.HasPrefix(value, "0x") || strings.HasPrefix(value, "0X") {
		base = 16
		value = value[2:]
	}
	count := 0
	for _, c := range value {
		if c >= '0' && c <= '9' || base == 16 && (c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			count++
		} else {
			break
		}
	}
	if count == 0 {
		return fallback
	}
	n, ok := new(big.Int).SetString(value[:count], base)
	if !ok || n.Sign() == 0 {
		return fallback
	}
	out, _ := n.Float64()
	return sign * out
}

// Statistics history retains its separately specified positive window bounds.
func adminPageInt(value string, fallback, upper int64) int64 {
	n := adminParseInt(value, float64(fallback))
	if n < 1 {
		return fallback
	}
	return int64(math.Min(n, float64(upper)))
}
