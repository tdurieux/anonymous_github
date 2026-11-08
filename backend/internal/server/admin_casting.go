package server

import (
	"errors"
	"strings"
)

func adminCastString(v *queryValue) (any, error) {
	if value, ok := v.scalarValue(); ok {
		return value, nil
	}
	if v != nil && v.kind == 'o' {
		if id, ok := v.object["_id"].scalarValue(); ok && id != "" {
			return id, nil
		}
	}
	return nil, errors.New("invalid_admin_filter")
}
func adminCastStrings(v *queryValue, allowEmpty bool) (any, error) {
	values := []*queryValue{v}
	if v != nil && v.kind == 'a' {
		values = v.array
	}
	out := []any{}
	for _, value := range values {
		if value == nil {
			continue
		}
		if allowEmpty && value.kind == 'a' && len(value.array) == 0 {
			out = append(out, []any{})
			continue
		}
		cast, err := adminCastString(value)
		if err != nil {
			return nil, err
		}
		out = append(out, cast)
	}
	return out, nil
}
func adminCastOperators(v *queryValue, allowNot bool) (M, error) {
	out := M{}
	for _, key := range v.keys {
		value := v.object[key]
		var cast any
		var err error
		switch key {
		case "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$regex", "$options":
			cast, err = adminCastString(value)
		case "$in", "$nin", "$all":
			cast, err = adminCastStrings(value, key != "$all")
		case "$exists":
			scalar, ok := value.scalarValue()
			if !ok {
				return nil, errors.New("invalid_admin_filter")
			}
			switch scalar {
			case "true", "1", "yes":
				cast = true
			case "false", "0", "no":
				cast = false
			default:
				return nil, errors.New("invalid_admin_filter")
			}
		case "$type":
			if value.kind == 's' {
				cast = value.scalar
			} else if value.kind == 'a' {
				list := []any{}
				for _, item := range value.array {
					if item == nil {
						continue
					}
					if item.kind != 's' {
						return nil, errors.New("invalid_admin_filter")
					}
					list = append(list, item.scalar)
				}
				cast = list
			} else {
				return nil, errors.New("invalid_admin_filter")
			}
		case "$not":
			if allowNot && value.kind == 'o' && len(value.keys) > 0 && strings.HasPrefix(value.keys[0], "$") {
				cast, err = adminCastOperators(value, false)
			} else {
				cast, err = adminCastString(value)
			}
		default:
			return nil, errors.New("invalid_admin_filter")
		}
		if err != nil {
			return nil, err
		}
		out[key] = cast
	}
	return out, nil
}

// Mongoose rewrites scalar-field arrays to $in in the find/count filter, but
// leaves the original array used by aggregation unchanged. Operator objects
// receive cast values in the echoed filter; aggregation already captured the
// original values before those mutations.
func adminCastPredicate(v *queryValue) (cast, raw any, err error) {
	raw = v.nativeValue()
	if v != nil && v.kind == 'a' {
		values, e := adminCastStrings(v, false)
		return M{"$in": values}, raw, e
	}
	if v != nil && v.kind == 'o' {
		for key := range v.object {
			if strings.HasPrefix(key, "$") {
				operators, e := adminCastOperators(v, true)
				return operators, operators, e
			}
		}
	}
	cast, err = adminCastString(v)
	return cast, raw, err
}
