package server

import (
	"errors"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// queryValue models the bounded extended query values used by Express/qs.
// Arrays stay sparse until string conversion, as qs compacts after merging.
type queryValue struct {
	kind               byte // s: string, a: array, o: object
	scalar             string
	array              []*queryValue
	object             map[string]*queryValue
	keys               []string
	overflow, conflict bool
	maximum            int
}

func queryObject() *queryValue {
	return &queryValue{kind: 'o', object: map[string]*queryValue{}, maximum: -1}
}
func (v *queryValue) put(k string, x *queryValue) {
	if _, ok := v.object[k]; !ok {
		v.keys = append(v.keys, k)
	}
	v.object[k] = x
	if n, e := strconv.Atoi(k); e == nil && n >= 0 && strconv.Itoa(n) == k && n > v.maximum {
		v.maximum = n
	}
}
func queryArrayObject(v *queryValue) *queryValue {
	o := queryObject()
	o.conflict = v.conflict
	for i, x := range v.array {
		if x != nil {
			o.put(strconv.Itoa(i), x)
		}
	}
	return o
}
func queryConcat(a, b *queryValue) *queryValue {
	if a.kind == 'o' && a.overflow {
		values := []*queryValue{b}
		if b.kind == 'a' {
			values = b.array
		}
		for _, v := range values {
			a.put(strconv.Itoa(a.maximum+1), v)
		}
		return a
	}
	values := []*queryValue{}
	for _, v := range []*queryValue{a, b} {
		if v.kind == 'a' {
			values = append(values, v.array...)
		} else {
			values = append(values, v)
		}
	}
	result := &queryValue{kind: 'a', array: values}
	if len(values) > 20 {
		result = queryArrayObject(result)
		result.overflow = true
	}
	return result
}
func mergeQuery(a, b *queryValue) *queryValue {
	if a == nil {
		return b
	}
	if b.kind == 's' && b.scalar == "" {
		return a
	}
	if b.kind == 's' {
		switch a.kind {
		case 'a':
			a.array = append(a.array, b)
			count := 0
			for _, v := range a.array {
				if v != nil {
					count++
				}
			}
			if count > 20 {
				a = queryArrayObject(a)
				a.overflow = true
			}
			return a
		case 'o':
			if a.overflow || a.conflict {
				a.put(strconv.Itoa(a.maximum+1), b)
				return a
			}
			return &queryValue{kind: 'a', array: []*queryValue{a, b}, conflict: true}
		default:
			return queryConcat(a, b)
		}
	}
	if a.kind == 's' {
		if b.overflow {
			out := queryObject()
			out.put("0", a)
			out.overflow = true
			for _, k := range b.keys {
				n, _ := strconv.Atoi(k)
				out.put(strconv.Itoa(n+1), b.object[k])
			}
			return out
		}
		return queryConcat(a, b)
	}
	if a.kind == 'a' && b.kind == 'a' {
		for i, v := range b.array {
			if v == nil {
				continue
			}
			if i < len(a.array) && a.array[i] != nil {
				if a.array[i].kind != 's' && v.kind != 's' {
					a.array[i] = mergeQuery(a.array[i], v)
				} else {
					a.array = append(a.array, v)
				}
			} else {
				for len(a.array) <= i {
					a.array = append(a.array, nil)
				}
				a.array[i] = v
			}
		}
		count := 0
		for _, v := range a.array {
			if v != nil {
				count++
			}
		}
		if count > 20 {
			a = queryArrayObject(a)
			a.overflow = true
		}
		return a
	}
	if a.kind == 'a' {
		a = queryArrayObject(a)
	}
	if b.kind == 'a' {
		b = queryArrayObject(b)
	}
	for _, k := range b.keys {
		a.put(k, mergeQuery(a.object[k], b.object[k]))
	}
	a.overflow = a.overflow || b.overflow
	return a
}
func decodeQuery(s string) string {
	decoded, err := url.QueryUnescape(s)
	if err != nil || !utf8.ValidString(decoded) {
		return strings.ReplaceAll(s, "+", " ")
	}
	return decoded
}
func querySegments(key string) []string {
	first := strings.IndexByte(key, '[')
	if first < 0 {
		return []string{key}
	}
	out := []string{}
	if first > 0 {
		out = append(out, key[:first])
	}
	open := first
	for depth := 0; open >= 0 && depth < 5; depth++ {
		level, close := 1, -1
		for i := open + 1; i < len(key); i++ {
			if key[i] == '[' {
				level++
			}
			if key[i] == ']' {
				level--
				if level == 0 {
					close = i
					break
				}
			}
		}
		if close < 0 {
			return append(out, "["+key[open:]+"]")
		}
		out = append(out, key[open:close+1])
		next := strings.IndexByte(key[close+1:], '[')
		if next < 0 {
			open = -1
		} else {
			open = close + 1 + next
		}
	}
	if open >= 0 {
		out = append(out, "["+key[open:]+"]")
	}
	return out
}
func queryTree(key string, v *queryValue) *queryValue {
	parts := querySegments(key)
	for i := len(parts) - 1; i >= 0; i-- {
		part := parts[i]
		if part == "[]" {
			if !v.overflow {
				v = queryConcat(&queryValue{kind: 'a'}, v)
			}
			continue
		}
		bracket := strings.HasPrefix(part, "[") && strings.HasSuffix(part, "]")
		if bracket {
			part = part[1 : len(part)-1]
		}
		index, err := strconv.Atoi(part)
		if bracket && err == nil && index >= 0 && strconv.Itoa(index) == part && index < 20 {
			a := &queryValue{kind: 'a', array: make([]*queryValue, index+1)}
			a.array[index] = v
			v = a
		} else {
			o := queryObject()
			if part != "__proto__" {
				o.put(part, v)
			}
			o.overflow = bracket && err == nil && index >= 20 && strconv.Itoa(index) == part
			v = o
		}
	}
	return v
}
func (v *queryValue) stringValue() (string, error) {
	if v == nil {
		return "undefined", nil
	}
	if v.kind == 's' {
		return v.scalar, nil
	}
	if v.kind == 'o' {
		if v.object["toString"] != nil {
			return "", errors.New("invalid_query_value")
		}
		return "[object Object]", nil
	}
	parts := []string{}
	for _, x := range v.array {
		if x != nil {
			s, e := x.stringValue()
			if e != nil {
				return "", e
			}
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, ","), nil
}

// extendedQueryString follows the application's Express extended parser:
// at most 1000 parameters, depth 5 and 20 array entries. No prototype state is
// represented, and malformed escapes remain literal rather than disappearing.
func extendedQueryString(raw, name string) (string, error) {
	return parseExtendedQuery(raw).object[name].stringValue()
}

func parseExtendedQuery(raw string) *queryValue {
	raw = strings.NewReplacer("%5B", "[", "%5b", "[", "%5D", "]", "%5d", "]").Replace(raw)
	fields := strings.SplitN(raw, "&", 1001)
	if len(fields) > 1000 {
		fields = fields[:1000]
	}
	values := map[string]*queryValue{}
	keys := []string{}
	for _, field := range fields {
		pos := strings.IndexByte(field, '=')
		if bracket := strings.Index(field, "]="); bracket >= 0 {
			pos = bracket + 1
		}
		key, val := field, ""
		if pos >= 0 {
			key, val = field[:pos], field[pos+1:]
		}
		key = decodeQuery(key)
		if key == "" {
			continue
		}
		v := &queryValue{kind: 's', scalar: decodeQuery(val)}
		if old := values[key]; old != nil {
			values[key] = queryConcat(old, v)
		} else {
			values[key] = v
			keys = append(keys, key)
		}
	}
	// JS enumerates canonical numeric object keys before other keys.
	sort.SliceStable(keys, func(i, j int) bool {
		a, ea := strconv.ParseUint(keys[i], 10, 32)
		b, eb := strconv.ParseUint(keys[j], 10, 32)
		na := ea == nil && a < 4294967295 && strconv.FormatUint(a, 10) == keys[i]
		nb := eb == nil && b < 4294967295 && strconv.FormatUint(b, 10) == keys[j]
		return na && (!nb || a < b)
	})
	root := queryObject()
	for _, key := range keys {
		root = mergeQuery(root, queryTree(key, values[key]))
	}
	return root
}

// Query arrays and objects are truthy even when their string form is empty.
func (v *queryValue) truthy() bool { return v != nil && (v.kind != 's' || v.scalar != "") }
func (v *queryValue) stringDefault(fallback string) (string, error) {
	if !v.truthy() {
		return fallback, nil
	}
	return v.stringValue()
}
func (v *queryValue) nativeValue() any {
	if v == nil {
		return nil
	}
	if v.kind == 's' {
		return v.scalar
	}
	if v.kind == 'a' {
		out := []any{}
		for _, x := range v.array {
			if x != nil {
				out = append(out, x.nativeValue())
			}
		}
		return out
	}
	out := M{}
	for k, x := range v.object {
		out[k] = x.nativeValue()
	}
	return out
}

// scalarValue never coerces arrays or objects into authorization inputs.
func (v *queryValue) scalarValue() (string, bool) {
	if v == nil || v.kind != 's' {
		return "", false
	}
	return v.scalar, true
}

// Parse JavaScript numeric forms relevant to monitoring windows. Radix
// literals beyond uint64 cannot equal any supported window and return NaN.
func queryWindowNumber(raw string) float64 {
	value := strings.TrimFunc(raw, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
	if value == "" {
		return 0
	}
	if value == "Infinity" || value == "+Infinity" {
		return math.Inf(1)
	}
	if value == "-Infinity" {
		return math.Inf(-1)
	}
	if dashboardDecimal.MatchString(value) {
		n, _ := strconv.ParseFloat(value, 64)
		return n
	}
	if len(value) > 2 && value[0] == '0' {
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
			n, err := strconv.ParseUint(value[2:], base, 64)
			if err == nil {
				return float64(n)
			}
		}
	}
	return math.NaN()
}

func (v *queryValue) looseStringEqual(expected string) (bool, error) {
	if v == nil {
		return false, nil
	}
	value, err := v.stringValue()
	return value == expected, err
}
func previewRefresh(raw string) (bool, error) {
	query := parseExtendedQuery(raw).object
	reconnect, _ := query["reconnect"].scalarValue()
	if reconnect == "1" {
		return true, nil
	}
	return query["force"].looseStringEqual("1")
}
