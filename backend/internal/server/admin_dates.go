package server

func adminDateRange(raw string) (M, error) {
	query := parseExtendedQuery(raw).object
	dates := M{}
	for _, entry := range []struct{ Query, Operator string }{{"dateFrom", "$gte"}, {"dateTo", "$lte"}} {
		value := query[entry.Query]
		if !value.truthy() {
			continue
		}
		text, err := value.stringValue()
		if err != nil {
			return nil, err
		}
		parsed, ok := javascriptDateString(text)
		if ok {
			dates[entry.Operator] = parsed
		}
	}
	return dates, nil
}
