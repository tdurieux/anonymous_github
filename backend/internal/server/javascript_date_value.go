package server

import (
	"math"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// JSON primitives follow Date construction, not Mongoose's Date-field casting.
// Invalid dates are distinct from coercions that throw before validation.
func javascriptDateValue(value any) (time.Time, bool, error) {
	switch v := value.(type) {
	case nil:
		return time.UnixMilli(0).UTC(), true, nil
	case bool:
		if v {
			return time.UnixMilli(1).UTC(), true, nil
		}
		return time.UnixMilli(0).UTC(), true, nil
	case int:
		return javascriptDateValue(float64(v))
	case int64:
		return javascriptDateValue(float64(v))
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 8.64e15 {
			return time.Time{}, false, nil
		}
		return time.UnixMilli(int64(v)).UTC(), true, nil
	case time.Time:
		return javascriptDateValue(float64(v.UnixMilli()))
	case bson.DateTime:
		return javascriptDateValue(float64(v))
	default:
		text, err := tokenNameString(value)
		if err != nil {
			return time.Time{}, false, err
		}
		parsed, ok := javascriptDateString(text)
		return parsed, ok, nil
	}
}

func conferenceFormDates(body M) (time.Time, time.Time, error) {
	start, startOK, err := javascriptDateValue(body["startDate"])
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	end, endOK, err := javascriptDateValue(body["endDate"])
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if !startOK || !endOK {
		return time.Time{}, time.Time{}, fail("internal_error", 500)
	}
	return start, end, nil
}
