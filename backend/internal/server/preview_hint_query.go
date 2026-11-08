package server

import (
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func previewHintFilter(raw string) (M, error) {
	query := parseExtendedQuery(raw).object
	if reconnect, _ := query["reconnect"].scalarValue(); reconnect == "1" {
		return nil, nil
	}
	value := query["repositoryID"]
	if !value.truthy() {
		return nil, nil
	}
	if value.kind == 'a' {
		ids := []bson.ObjectID{}
		for _, item := range value.array {
			if item == nil {
				continue
			}
			id, err := previewHintID(item)
			if err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		return M{"_id": M{"$in": ids}}, nil
	}
	id, err := previewHintID(value)
	if err != nil {
		return nil, err
	}
	return M{"_id": id}, nil
}

func previewHintID(value *queryValue) (bson.ObjectID, error) {
	invalid := errors.New("invalid_repository_id")
	if value == nil {
		return bson.NilObjectID, invalid
	}
	if value.kind == 'o' {
		// Only wrapped explicit IDs are supported, never query operators.
		for key := range value.object {
			if strings.HasPrefix(key, "$") {
				return bson.NilObjectID, invalid
			}
		}
		value = value.object["_id"]
		if value == nil {
			return bson.NilObjectID, invalid
		}
	}
	text, err := value.stringValue()
	if err != nil {
		return bson.NilObjectID, invalid
	}
	if id, err := bson.ObjectIDFromHex(text); err == nil {
		return id, nil
	}
	// Mongoose's installed ObjectId caster accepts 12 ASCII code units.
	if len(text) == 12 {
		var id bson.ObjectID
		for i := range text {
			if text[i] >= 128 {
				return bson.NilObjectID, invalid
			}
			id[i] = text[i]
		}
		return id, nil
	}
	return bson.NilObjectID, invalid
}
