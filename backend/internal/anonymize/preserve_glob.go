package anonymize

import (
	"github.com/dlclark/regexp2"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Bound expansion so a saved rule cannot multiply work exponentially.
func expandPreserveBraces(pattern string, budget *int) []string {
	if *budget <= 0 {
		return nil
	}
	start, depth := -1, 0
	for i := 0; i < len(pattern); i++ {
		if pattern[i] == '\\' {
			i++
			continue
		}
		if pattern[i] == '{' {
			if start < 0 {
				start = i
			}
			depth++
		}
		if pattern[i] != '}' || start < 0 {
			continue
		}
		depth--
		if depth != 0 {
			continue
		}
		body := pattern[start+1 : i]
		choices := []string{}
		level, last := 0, 0
		for j := 0; j < len(body); j++ {
			if body[j] == '\\' {
				j++
				continue
			}
			switch body[j] {
			case '{':
				level++
			case '}':
				level--
			case ',':
				if level == 0 {
					choices = append(choices, body[last:j])
					last = j + 1
				}
			}
		}
		if len(choices) > 0 {
			choices = append(choices, body[last:])
		} else {
			values := strings.Split(body, "..")
			if len(values) == 2 || len(values) == 3 {
				a, ae := strconv.Atoi(values[0])
				b, be := strconv.Atoi(values[1])
				alpha := false
				if ae != nil || be != nil {
					if len(values[0]) == 1 && len(values[1]) == 1 && ((values[0][0] >= 'a' && values[0][0] <= 'z' && values[1][0] >= 'a' && values[1][0] <= 'z') || (values[0][0] >= 'A' && values[0][0] <= 'Z' && values[1][0] >= 'A' && values[1][0] <= 'Z')) {
						a, b, alpha = int(values[0][0]), int(values[1][0]), true
					} else {
						continue
					}
				}
				step := 1
				if len(values) == 3 {
					var err error
					step, err = strconv.Atoi(values[2])
					if err != nil || step == 0 {
						continue
					}
					if step < 0 {
						step = -step
					}
				}
				if a > b {
					step = -step
				}
				width := 0
				if !alpha {
					for _, v := range values[:2] {
						stripped := strings.TrimPrefix(v, "-")
						if len(stripped) > 1 && stripped[0] == '0' && len(stripped) > width {
							width = len(stripped)
						}
					}
				}
				for n := a; (step > 0 && n <= b) || (step < 0 && n >= b); n += step {
					if len(choices) >= *budget {
						return nil
					}
					value := strconv.Itoa(n)
					if alpha {
						value = string(rune(n))
					} else if width > 0 {
						sign := ""
						if n < 0 {
							sign = "-"
							value = strings.TrimPrefix(value, "-")
						}
						if len(value) < width {
							value = strings.Repeat("0", width-len(value)) + value
						}
						value = sign + value
					}
					choices = append(choices, value)
					if (step > 0 && n > b-step) || (step < 0 && n < b-step) {
						break
					}
				}
			}
		}
		if len(choices) == 0 {
			continue
		}
		out := []string{}
		for _, choice := range choices {
			out = append(out, expandPreserveBraces(pattern[:start]+choice+pattern[i+1:], budget)...)
			if *budget <= 0 {
				return out
			}
		}
		return out
	}
	*budget--
	return []string{pattern}
}
func preserveComponentRegex(pattern string) string {
	out := ""
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		if c == '\\' && i+1 < len(pattern) {
			i++
			out += regexp.QuoteMeta(pattern[i : i+1])
			continue
		}
		if strings.ContainsRune("@+?*!", rune(c)) && i+1 < len(pattern) && pattern[i+1] == '(' {
			level, end := 1, -1
			for j := i + 2; j < len(pattern); j++ {
				if pattern[j] == '\\' {
					j++
					continue
				}
				if pattern[j] == '(' {
					level++
				}
				if pattern[j] == ')' {
					level--
					if level == 0 {
						end = j
						break
					}
				}
			}
			if end >= 0 {
				body := pattern[i+2 : end]
				alternatives := []string{}
				level, last := 0, 0
				for j := 0; j < len(body); j++ {
					if body[j] == '\\' {
						j++
						continue
					}
					if body[j] == '(' {
						level++
					}
					if body[j] == ')' {
						level--
					}
					if body[j] == '|' && level == 0 {
						alternatives = append(alternatives, preserveComponentRegex(body[last:j]))
						last = j + 1
					}
				}
				alternatives = append(alternatives, preserveComponentRegex(body[last:]))
				group := "(?:" + strings.Join(alternatives, "|") + ")"
				suffix := preserveComponentRegex(pattern[end+1:])
				if c == '!' {
					return out + "(?!" + group + suffix + "$)[^/]*" + suffix
				}
				out += group
				if c != '@' {
					out += string(c)
				}
				i = end
				continue
			}
		}
		switch c {
		case '*':
			out += "[^/]*"
		case '?':
			out += "[^/]"
		case '[':
			end := -1
			for j := i + 1; j < len(pattern); j++ {
				if pattern[j] == '\\' {
					j++
					continue
				}
				if pattern[j] == ']' && j > i+1 {
					end = j
					break
				}
			}
			if end < 0 {
				out += `\[`
				continue
			}
			class := pattern[i : end+1]
			if strings.HasPrefix(class, "[!") {
				class = "[^" + class[2:]
			}
			out += class
			i = end
		default:
			out += regexp.QuoteMeta(string(c))
		}
	}
	return out
}

var preserveComponents = struct {
	sync.Mutex
	expressions map[string]*regexp2.Regexp
}{expressions: map[string]*regexp2.Regexp{}}

func preserveComponent(pattern, value string) bool {
	if !strings.ContainsAny(pattern, "*?[]()\\") {
		return pattern == value
	}
	preserveComponents.Lock()
	expression, exists := preserveComponents.expressions[pattern]
	if !exists {
		var err error
		expression, err = regexp2.Compile("^(?:"+preserveComponentRegex(pattern)+")$", regexp2.ECMAScript)
		if err != nil {
			expression = nil
		} else {
			expression.MatchTimeout = 5 * time.Millisecond
		}
		if len(preserveComponents.expressions) >= 1024 {
			clear(preserveComponents.expressions)
		}
		preserveComponents.expressions[pattern] = expression
	}
	preserveComponents.Unlock()
	if expression == nil {
		return pattern == value
	}
	matched, err := expression.MatchString(value)
	return err == nil && matched
}
