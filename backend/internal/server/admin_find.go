package server

import (
	"errors"
	"math"

	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository and conference lists use find, whose negative limit means a
// single batch. User lists use aggregation, where negative limits are invalid.
func (s *Server) adminFindPage(q *request, coll string, filter, sort, projection M, page, limit float64) ([]M, error) {
	skip := (page - 1) * limit
	if math.IsNaN(skip) || math.IsInf(skip, 0) || skip < 0 || skip >= math.Exp2(63) || limit <= -math.Exp2(63) || limit >= math.Exp2(63) {
		return nil, errors.New("invalid_pagination")
	}
	cursor, err := s.Store.DB.Collection(coll).Find(q.ctx(), filter, options.Find().SetSort(sort).SetProjection(projection).SetSkip(int64(skip)).SetLimit(int64(limit)))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(q.ctx())
	rows := []M{}
	err = cursor.All(q.ctx(), &rows)
	return rows, err
}
