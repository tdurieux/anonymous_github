package server

// Cast the fields handled by Mongoose's user-default update. This is separate
// from repository option validation: saved defaults can contain null terms and
// page is a string here, while repository creation validates runnable settings.
func castUserDefaults(body M) (M, error) {
	out := selectFields(body, "terms", "options")
	if value, present := out["terms"]; present && value != nil {
		values, ok := value.([]any)
		if !ok {
			values = []any{value}
		}
		terms := []any{}
		for _, value := range values {
			if value == nil {
				terms = append(terms, nil)
				continue
			}
			text, valid := termString(value)
			if !valid {
				return nil, fail("invalid_defaults", 400)
			}
			terms = append(terms, text)
		}
		out["terms"] = terms
	}
	if value, present := out["options"]; present {
		switch value.(type) {
		case M, map[string]any:
			options := selectFields(obj(value), "expirationMode", "update", "image", "pdf", "notebook", "link", "page")
			for _, key := range []string{"update", "image", "pdf", "notebook", "link"} {
				if value, ok := options[key]; ok {
					converted, valid := optionBoolean(value)
					if !valid {
						return nil, fail("invalid_defaults", 400)
					}
					options[key] = converted
				}
			}
			for _, key := range []string{"expirationMode", "page"} {
				if value, ok := options[key]; ok && value != nil {
					text, valid := termString(value)
					if !valid {
						return nil, fail("invalid_defaults", 400)
					}
					options[key] = text
				}
			}
			out["options"] = options
		}
	}
	return out, nil
}
func userDefaults(user M) any {
	if value, present := user["default"]; present && value == nil {
		return nil
	}
	out := selectFields(obj(user["default"]), "terms", "options")
	defaults(out, M{"terms": []any{}, "options": M{}})
	return out
}
func userProfile(user M) M {
	out := selectFields(user, "username", "photo")
	out["isAdmin"] = boolean(user["isAdmin"])
	return out
}
