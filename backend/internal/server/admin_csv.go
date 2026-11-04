package server

import (
	"io"
	"strconv"
	"strings"
	"time"
)

func csvDate(v any) string {
	if !inputTruthy(v) {
		return ""
	}
	d := date(v)
	if value, ok := v.(string); ok && d.IsZero() {
		var err error
		d, err = time.Parse(time.RFC3339Nano, value)
		if err != nil {
			d, err = time.Parse("2006-01-02", value)
		}
		if err != nil {
			return ""
		}
	}
	return str(responseDate(d))
}
func csvField(value any) string {
	text := str(value)
	if strings.ContainsAny(text, ",\"\n\r") {
		return "\"" + strings.ReplaceAll(text, "\"", "\"\"") + "\""
	}
	return text
}
func csvNumber(value any) any {
	if !inputTruthy(value) {
		return 0
	}
	return value
}
func (s *Server) adminCSV(q *request, kind, coll string, filter, sort M) (any, error) {
	rows, e := s.aggregate(q, coll, []M{{"$match": filter}, {"$sort": sort}, {"$limit": 50000}, {"$project": M{"accessTokens": 0, "apiTokens": 0, "accessToken": 0, "refreshToken": 0, "source.accessToken": 0}}})
	if e != nil {
		return nil, e
	}
	filename := "repositories"
	if kind == "users" || kind == "conferences" {
		filename = kind
	}
	q.W.Header().Set("Content-Type", "text/csv; charset=utf-8")
	q.W.Header().Set("Content-Disposition", `attachment; filename="`+filename+"-"+time.Now().UTC().Format("2006-01-02")+`.csv"`)
	if err := writeAdminCSV(q.W, kind, rows); err != nil {
		return nil, err
	}
	return written{}, nil
}
func writeAdminCSV(writer io.Writer, kind string, rows []M) error {
	columns := []string{"repoId", "status", "statusMessage", "anonymizeDate", "lastView", "pageView", "sourceRepository", "sourceBranch", "sourceCommit", "conference", "storage", "terms"}
	if kind == "users" {
		columns = []string{"username", "email", "status", "isAdmin", "repoCount", "dateOfEntry"}
	}
	if kind == "conferences" {
		columns = []string{"conferenceID", "name", "status", "price", "repoCount", "startDate", "endDate"}
	}
	if kind == "repos" && len(rows) == 0 {
		columns = []string{"repoId"}
	}
	if _, err := io.WriteString(writer, strings.Join(columns, ",")); err != nil {
		return err
	}
	for _, r := range rows {
		source := obj(r["source"])
		values := M{"repoId": r["repoId"], "status": r["status"], "statusMessage": r["statusMessage"], "anonymizeDate": csvDate(r["anonymizeDate"]), "lastView": csvDate(r["lastView"]), "pageView": csvNumber(r["pageView"]), "sourceRepository": source["repositoryName"], "sourceBranch": source["branch"], "sourceCommit": source["commit"], "conference": r["conference"], "storage": csvNumber(obj(r["size"])["storage"]), "terms": len(arr(obj(r["options"])["terms"]))}
		if kind == "users" {
			email := ""
			if emails := arr(r["emails"]); len(emails) > 0 {
				email = str(obj(emails[0])["email"])
			}
			values = M{"username": r["username"], "email": email, "status": r["status"], "isAdmin": strconv.FormatBool(boolean(r["isAdmin"])), "repoCount": len(arr(r["repositories"])), "dateOfEntry": csvDate(r["dateOfEntry"])}
		}
		if kind == "conferences" {
			values = M{"conferenceID": r["conferenceID"], "name": r["name"], "status": r["status"], "price": csvNumber(r["price"]), "repoCount": len(arr(r["repositories"])), "startDate": csvDate(r["startDate"]), "endDate": csvDate(r["endDate"])}
		}
		row := make([]string, len(columns))
		for i, key := range columns {
			row[i] = csvField(values[key])
		}
		if _, err := io.WriteString(writer, "\n"+strings.Join(row, ",")); err != nil {
			return err
		}
	}
	return nil
}
