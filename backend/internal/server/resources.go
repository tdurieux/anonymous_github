package server

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func (q *request) resource(kind string, edit bool) (result M, resultErr error) {
	done := q.Server.startStage(q.ctx(), "repository")
	defer func() { done(resultErr) }()
	id := q.Params["id"]
	if id == "" || id == "undefined" {
		return nil, fail(missing(kind), 404)
	}
	r, err := q.Server.Store.one(q.ctx(), collection(kind), resourceFilter(kind, id))
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, fail(missing(kind), 404)
	}
	if edit && !canEdit(q.Identity, r) {
		return nil, fail("not_authorized", 403)
	}
	return r, nil
}
func canEdit(u security.Identity, r M) bool {
	co := []security.Coauthor{}
	for _, v := range arr(r["coauthors"]) {
		c := obj(v)
		co = append(co, security.Coauthor{Username: str(c["username"]), GitHubID: str(c["githubId"])})
	}
	return u.CanEdit(str(r["owner"]), co)
}
func (s *Server) checkResource(ctx context.Context, kind string, r M) error {
	status := str(r["status"])
	if status == "archived" {
		return fail("repository_archived", 410)
	}
	opt := obj(r["options"])
	if status == "ready" && str(opt["expirationMode"]) != "never" && inputTruthy(opt["expirationDate"]) && !date(opt["expirationDate"]).After(time.Now()) {
		ok, err := s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": M{"status": "expiring", "statusDate": time.Now()}})
		if err != nil {
			return err
		}
		if !ok {
			return fail("repository_changed", 409)
		}
		status = "expiring"
	}
	for _, inactive := range []string{"expired", "expiring", "removed", "removing"} {
		if status == inactive {
			prefix := kind
			if kind == "repo" {
				prefix = "repository"
			}
			if kind == "pr" {
				prefix = "pull_request"
			}
			return fail(prefix+"_expired", 410)
		}
	}
	if status != "ready" {
		prefix := kind
		if kind == "repo" {
			prefix = "repository"
		}
		if kind == "pr" {
			prefix = "pull_request"
		}
		if status == "error" {
			code := str(r["statusMessage"])
			if code == "" {
				code = prefix + "_not_accessible"
				if kind != "repo" {
					code = prefix + "_not_available"
				}
			}
			return fail(code, 500)
		}
		if kind == "repo" && strings.HasPrefix(str(r["statusMessage"]), "rate_limited:") {
			if reset, e := strconv.ParseInt(strings.TrimPrefix(str(r["statusMessage"]), "rate_limited:"), 10, 64); e == nil && reset > 0 {
				return &APIError{Code: "rate_limited", Status: 425, ResetAt: reset}
			}
		}
		return fail(prefix+"_not_ready", 425)
	}
	return nil
}
func (s *Server) anonymizerOptions(r M, kind string) (anonymize.Options, error) {
	var opt anonymize.Options
	b, _ := json.Marshal(r["options"])
	if json.Unmarshal(b, &opt) != nil {
		return opt, fail("invalid_options", 400)
	}
	opt.RepoID = str(r[idKey(kind)])
	if kind == "repo" {
		p, a, e := s.repositoryProvider(r)
		if e != nil {
			return opt, e
		}
		opt.RepoName = a.Ref.Name
		opt.BranchName = a.Ref.Branch
		opt.SourceURLs = p.SelfLinks(a.Ref)
		if opt.SourceURLs == nil {
			opt.SourceURLs = []string{}
		}
	}
	return opt, nil
}
func (s *Server) engine(r M, kind string) (*anonymize.Engine, error) {
	opt, e := s.anonymizerOptions(r, kind)
	if e != nil {
		return nil, e
	}
	return anonymize.New(opt, anonymize.Context{Mask: s.Config.Mask, Hostname: s.Config.Hostname})
}

func (s *Server) privateResource(kind string) handler {
	return func(q *request) (any, error) {
		r, err := q.resource(kind, true)
		if err != nil {
			return nil, err
		}
		out := resourceJSON(kind, r)
		if kind == "repo" {
			out["ownerId"] = str(r["owner"])
			role := "coauthor"
			if q.Identity.ID == str(r["owner"]) {
				role = "owner"
			} else if q.Identity.Admin {
				role = "admin"
			}
			out["role"] = role
			a, e := s.providerAccess(r)
			if e != nil {
				return nil, e
			}
			connection := str(a.Binding["kind"])
			if connection == "" && a.Ref.Provider == "github" {
				connection = "oauth"
			}
			out["connection"] = connection
		}
		return out, nil
	}
}
func (s *Server) publicOptions(kind string) handler {
	return func(q *request) (any, error) {
		q.W.Header().Set("Cache-Control", "no-cache")
		r, err := q.resource(kind, false)
		if err != nil {
			return nil, err
		}
		can := canEdit(q.Identity, r)
		status := str(r["status"])
		opt := obj(r["options"])
		var redirect any
		if status == "archived" {
			return nil, fail("repository_archived", 410)
		}
		if !can && status == "expired" && str(opt["expirationMode"]) == "redirect" {
			url, e := s.sourceURL(r, kind)
			if e != nil {
				return nil, e
			}
			if url != "" {
				redirect = url
			}

		} else if !can {
			if kind == "repo" {
				err = s.repositoryOptionsCheck(q.ctx(), r)
			} else {
				err = s.embeddedOptionsCheck(q.ctx(), kind, r)
			}
			if err != nil {
				return nil, err
			}
		}
		out := M{"url": redirect, "lastUpdateDate": r["statusDate"], "isAdmin": q.Identity.Admin, "isOwner": q.Identity.Active() && q.Identity.ID == str(r["owner"])}
		if kind == "repo" {
			out["lastUpdateDate"] = latestStoredDate(r["anonymizeDate"], r["settingsSavedAt"], r["publishedAt"])
			if v, ok := r["anonymizeDate"]; ok {
				out["anonymizedAt"] = v
			}
			if v, ok := obj(r["source"])["commitDate"]; ok {
				out["sourceCommitDate"] = v
			}
			for _, k := range []string{"settingsSavedAt", "publishedAt"} {
				if v, ok := r[k]; ok {
					out[k] = v
				}
			}
			out["download"] = s.Config.Download || q.Identity.Admin
			out["hasWebsite"] = boolean(opt["page"]) && opt["pageSource"] != nil
			e, err := s.engine(r, kind)
			if err != nil {
				return nil, err
			}
			folders := []string{}
			for _, p := range stringsOf(r["truncatedFolders"]) {
				value, err := e.Path(q.ctx(), p)
				if err != nil {
					return nil, err
				}
				folders = append(folders, value)
			}
			out["truncatedFolders"] = folders
			sub, err := s.Store.one(q.ctx(), "files", M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "path": "", "name": ".gitmodules"})
			if err != nil {
				return nil, err
			}
			if sub == nil {
				sub, err = s.Store.one(q.ctx(), "files", M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "submodule": M{"$exists": true, "$ne": "included"}})
				if err != nil {
					return nil, err
				}
			}
			out["hasSubmodules"] = sub != nil
		}
		return out, nil
	}
}
func (s *Server) preview(q *request) (any, error) {
	var inputs []string
	single := false
	if value, ok := q.Body["content"].(string); ok {
		inputs = []string{value}
		single = true
	} else if values, ok := q.Body["contents"].([]any); ok {
		for _, v := range values {
			value, ok := v.(string)
			if !ok {
				return nil, fail("missing_content", 400)
			}
			inputs = append(inputs, value)
		}
	} else {
		return nil, fail("missing_content", 400)
	}
	var opt anonymize.Options
	b, _ := json.Marshal(q.Body["options"])
	if json.Unmarshal(b, &opt) != nil {
		return nil, fail("invalid_options", 400)
	}

	preserved, err := anonymize.NormalizePreserveFiles(obj(q.Body["options"])["preserveFiles"])
	if err != nil {
		return nil, fail(err.Error(), 400)
	}
	file, present := obj(q.Body["options"])["filePath"]
	if present {
		value, ok := file.(string)
		if !ok || !safeSourcePath(value) {
			return nil, fail("invalid_path", 400)
		}
		if anonymize.PreservedPath(value, preserved) {
			opt.Terms = []string{}
		}
	}
	q.W.Header().Set("Cache-Control", "private, no-store")
	e, err := anonymize.New(opt, anonymize.Context{Mask: s.Config.Mask, Hostname: s.Config.Hostname})
	if err != nil {
		return nil, fail(err.Error(), 400)
	}
	outputs := []string{}
	ctx, cancel := context.WithTimeout(q.ctx(), time.Second)
	defer cancel()
	for _, input := range inputs {
		result, err := e.Transform(ctx, input, 1024*1024)
		if err != nil {
			return nil, fail("anonymization_failed", 422)
		}
		outputs = append(outputs, result.Content)
	}
	if single {
		return M{"content": outputs[0]}, nil
	}
	return M{"contents": outputs}, nil
}

var resourceID = regexp.MustCompile(`^[0-9a-zA-Z_-]{3,}$`)
var commitID = regexp.MustCompile(`^[a-fA-F0-9]+$`)

// Mongoose string fields accept scalar values and documents with a string _id.
func resourceOptionString(value any) (string, bool) {
	if id, ok := obj(value)["_id"].(string); ok && id != "" {
		return id, true
	}
	return termString(value)
}

func validatedOptions(kind string, body M) (M, error) {
	raw, ok := body["terms"].([]any)
	if !ok {
		return nil, fail("invalid_terms_format", 400)
	}
	if len(raw) > 1000 {
		return nil, fail("too_many_anonymization_terms", 400)
	}
	terms := []string{}
	for _, t := range raw {
		s, ok := termString(t)
		if !ok || len(s) > 8192 {
			return nil, fail("invalid_terms_format", 400)
		}
		terms = append(terms, s)
	}
	if body["options"] == nil {
		return nil, fail("options_not_provided", 400)
	}
	fields := []string{"expirationMode", "expirationDate", "update", "image", "link"}
	switch kind {
	case "repo":
		fields = append(fields, "pdf", "notebook", "page", "pageSource", "preserveFiles")
	case "gist", "pr":
		fields = append(fields, "title", "body", "comments", "origin", "username", "date")
		if kind == "gist" {
			fields = append(fields, "content")
		} else {
			fields = append(fields, "diff")
		}
	}
	opt := selectFields(obj(body["options"]), fields...)
	if kind == "repo" {
		patterns, err := anonymize.NormalizePreserveFiles(opt["preserveFiles"])
		if err != nil {
			return nil, fail(err.Error(), 400)
		}
		opt["preserveFiles"] = patterns
	}
	castStringField := func(fields M, key string) error {
		value, exists := fields[key]
		if !exists || value == nil {
			return nil
		}
		converted, valid := resourceOptionString(value)
		if !valid {
			return fail("invalid_options", 400)
		} else {
			fields[key] = converted
		}
		return nil
	}
	if err := castStringField(opt, "expirationMode"); err != nil {
		return nil, err
	}
	if source, exists := opt["pageSource"]; exists && source != nil {
		switch source.(type) {
		case M, map[string]any, []any:
			page := selectFields(obj(source), "branch", "path")
			for _, key := range []string{"branch", "path"} {
				if err := castStringField(page, key); err != nil {
					return nil, err
				}
			}
			if len(page) == 0 {
				delete(opt, "pageSource")
			} else {
				opt["pageSource"] = page
			}
		default:
			return nil, fail("invalid_options", 400)
		}
	}
	opt["terms"] = terms
	if v, ok := opt["expirationDate"]; ok && inputTruthy(v) {
		t, valid, err := javascriptDateValue(v)
		if err != nil || !valid {
			return nil, fail("invalid_expiration_date", 400)
		}
		opt["expirationDate"] = t
	} else {
		delete(opt, "expirationDate")
	}
	for _, k := range []string{"update", "image", "pdf", "notebook", "link", "page", "title", "body", "comments", "content", "origin", "username", "date", "diff"} {
		if v, ok := opt[k]; ok {
			converted, valid := optionBoolean(v)
			if !valid {
				return nil, fail("invalid_options", 400)
			}
			opt[k] = converted
		}
	}
	return opt, nil
}
func (s *Server) saveResource(kind string, create bool) handler {
	return func(q *request) (any, error) {
		body := q.Body
		var previous M
		var err error
		existingProvider := ""
		if !create {
			previous, err = q.resource(kind, true)
			if err != nil {
				return nil, err
			}
			for _, st := range []string{"archived", "removing", "expiring"} {
				if _, reconnect := body["reconnectRepositoryId"]; kind == "repo" && reconnect && st == "archived" {
					continue
				}
				if str(previous["status"]) == st {
					return nil, fail("invalid_status", 409)
				}
			}
			existingProvider, err = sourceProvider(obj(previous["source"]))
			if err != nil {
				return nil, err
			}
			if incoming := obj(body["source"])["provider"]; incoming != nil && str(incoming) != existingProvider {
				return nil, fail("provider_binding_mismatch", 409)
			}
		}
		if err := validateResourceProviderInput(kind, body, existingProvider); err != nil {
			return nil, err
		}
		if kind == "repo" && previous != nil {
			if _, _, err := validateRepositoryReconnect(q, previous, existingProvider); err != nil {
				return nil, err
			}
			if err := s.flushConferenceMembership(q.ctx(), previous); err != nil {
				return nil, err
			}
		}
		oldConference := ""
		if previous != nil {
			oldConference = str(previous["conference"])
		}
		newConference := str(body["conference"])
		if kind != "repo" || previous == nil || oldConference != newConference {
			if err := s.validateConference(q, newConference); err != nil {
				return nil, err
			}
		}
		id := str(body[idKey(kind)])
		opt, err := validatedOptions(kind, body)
		if err != nil {
			return nil, err
		}
		source := obj(body["source"])
		if body["source"] == nil {
			return nil, fail("source_not_provided", 400)
		}
		if previous != nil && str(previous[idKey(kind)]) != id {
			return nil, fail("invalid_"+idKey(kind), 400)
		}

		billingFields := M{}
		if kind == "repo" && s.Config.Billing.Enabled {
			owner := q.Identity.ID
			if previous != nil {
				owner = str(previous["owner"])
			}
			managed := previous == nil || boolean(previous["billingManaged"])
			oldSource := obj(previous["source"])
			sourceChanged := previous == nil || str(body["fullName"]) != str(oldSource["repositoryName"]) || str(source["branch"]) != str(oldSource["branch"]) || str(source["commit"]) != str(oldSource["commit"])
			needsAdmission := sourceChanged || oldConference != newConference || shouldReactivateRepository(str(previous["status"]), opt, time.Now())
			if managed {
				billingFields, err = s.billingResourceSettings(q.ctx(), owner, id, newConference, opt, previous)
				if err != nil {
					return nil, err
				}
			} else if opt["expirationMode"] == "never" && (obj(previous["options"])["expirationMode"] != "never" || previous["billingNeverExpiresUntil"] != nil) {
				existing := time.Time{}
				if obj(previous["options"])["expirationMode"] == "never" {
					existing = date(previous["billingNeverExpiresUntil"])
				}
				deadline, e := s.billingNeverDeadline(q.ctx(), owner, id, existing)
				if e != nil {
					return nil, e
				}
				billingFields["billingNeverExpiresUntil"] = deadline
			}
			if needsAdmission {
				if err = s.billingConferenceAdmission(q.ctx(), owner, id, newConference); err != nil {
					return nil, err
				}
				if managed {
					if err = s.reserveBillingRepository(q.ctx(), owner, id, number(obj(previous["size"])["storage"]), newConference, "", 0); err != nil {
						return nil, err
					}
				}
			}
		}
		_, reconnectRequested := body["reconnectRepositoryId"]
		// Settings-only saves must not need a working GitHub grant or replace its identity binding.
		if kind == "repo" && previous != nil && !reconnectRequested {
			old := obj(previous["source"])
			same := str(body["fullName"]) == str(old["repositoryName"]) && str(source["branch"]) == str(old["branch"]) && str(source["commit"]) == str(old["commit"])
			if same {
				now := membershipSaveTime(previous)
				set := M{"options": opt, "conference": str(body["conference"]), "settingsSavedAt": now}
				for key, value := range billingFields {
					set[key] = value
				}
				recordConferenceMembership(set, oldConference, newConference, now)
				reactivating := shouldReactivateRepository(str(previous["status"]), opt, now)
				if reactivating {
					set["status"], set["statusDate"], set["anonymizeDate"], set["statusMessage"] = "preparing", now, now, nil
				}
				ok, e := s.Store.update(q.ctx(), collection(kind), membershipSaveFilter(kind, previous), M{"$set": set})
				if e != nil {
					return nil, e
				}
				if !ok {
					return nil, fail("connection_changed", 409)
				}
				for key, value := range set {
					previous[key] = value
				}
				if err := s.flushConferenceMembership(q.ctx(), previous); err != nil {
					return nil, err
				}
				if reactivating {
					if e := s.enqueueSavedSnapshot(q.ctx(), previous); e != nil {
						return nil, e
					}
				}
				return M{"status": previous["status"]}, nil
			}
		}
		owner := q.User["_id"]
		if previous != nil {
			owner = previous["owner"]
		}
		savedSource := M{}
		binding := M{}
		switch kind {
		case "repo":
			savedSource, binding, err = s.saveRepositorySource(q, previous, source)
			if err != nil {
				return nil, err
			}

		case "gist", "pr":
			savedSource, binding, err = s.saveDocumentSource(q, kind, previous, source, owner)
			if err != nil {
				return nil, err
			}
		}

		now := membershipSaveTime(previous)
		record := M{idKey(kind): id, "owner": owner, "source": savedSource, "options": opt, "conference": str(body["conference"]), "settingsSavedAt": now, "anonymizeDate": now, "status": "preparing", "statusDate": now, "githubAccess": binding}
		for key, value := range billingFields {
			record[key] = value
		}
		if id, e := sourceProvider(savedSource); e == nil && id != "github" {
			delete(record, "githubAccess")
			record["providerAccess"] = binding
		}
		if kind == "repo" {
			recordConferenceMembership(record, oldConference, newConference, now)
		}
		if create {
			record["_id"] = bson.NewObjectID()
			record["dateOfEntry"] = now
			record["coauthors"] = []any{}
			record["size"] = M{"storage": 0, "file": 0}
			if _, err = s.Store.DB.Collection(collection(kind)).InsertOne(q.ctx(), record); err != nil {
				return nil, fail(idKey(kind)+"_already_used", 400)
			}
		} else {
			ok, err := s.Store.update(q.ctx(), collection(kind), membershipSaveFilter(kind, previous), M{"$set": record})
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, fail("connection_changed", 409)
			}
			record["_id"] = previous["_id"]
		}
		if kind != "repo" {
			// TS returns the fully downloaded document from create and update.
			current, e := s.Store.one(q.ctx(), collection(kind), M{"_id": record["_id"]})
			if e != nil {
				return nil, e
			}
			if current == nil {
				return nil, fail(missing(kind), 404)
			}
			if e = s.refreshEmbedded(q.ctx(), kind, current); e != nil {
				return nil, e
			}
			return resourceJSON(kind, current), nil
		}
		if err := s.flushConferenceMembership(q.ctx(), record); err != nil {
			return nil, err
		}
		err = s.enqueueSavedSnapshot(q.ctx(), record)
		if err != nil {
			return nil, err
		}
		return M{"status": "preparing"}, nil
	}
}
func (s *Server) lifecycle(kind, action string) handler {
	return func(q *request) (any, error) {
		r, err := q.resource(kind, true)
		if err != nil {
			return nil, err
		}
		if str(r["status"]) == "archived" {
			return nil, fail("repository_archived", 410)
		}
		if action == "extend" {
			return s.extendResource(q.ctx(), kind, r)
		}

		if action == "refresh" && q.Identity.ID == str(r["owner"]) {
			if err = s.resetOwnerAlerts(q.ctx(), r["owner"], kind, r["_id"]); err != nil {
				return nil, err
			}
		}
		if action == "refresh" && kind != "repo" {
			if err = s.refreshEmbedded(q.ctx(), kind, r); err != nil {
				return nil, err
			}
			return M{"status": r["status"]}, nil
		}
		status, job := "preparing", "prepare"
		if action == "remove" {
			if str(r["status"]) == "removed" {
				return nil, fail("is_removed", 410)
			}
			if !q.Identity.Owns(str(r["owner"])) {
				return nil, fail("not_authorized", 403)
			}
			finish, e := s.beginAlertDeactivation(q.ctx(), r["owner"])
			if e != nil {
				return nil, e
			}
			defer finish()
			status, job = "removing", "remove"
		}
		if (str(r["status"]) == "removing" || str(r["status"]) == "expiring") && !(kind == "repo" && action == "remove") {
			return nil, fail("invalid_status", 409)
		}
		set := M{"status": status, "statusDate": time.Now()}
		if action == "refresh" && kind == "repo" {
			if err = s.manualRepositoryRefresh(q.ctx(), r); err != nil {
				return nil, err
			}
			return M{"status": r["status"]}, nil
		}
		if action == "refresh" {
			switch str(r["status"]) {
			case "preparing", "queue", "download":
				return nil, fail("invalid_status", 409)
			}
		}

		ok, err := s.Store.update(q.ctx(), collection(kind), revisionFilter(r), M{"$set": set})
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fail("connection_changed", 409)
		}
		if kind != "repo" && action == "remove" {
			if err = s.runJob(q.ctx(), M{"kind": kind, "resourceId": r[idKey(kind)], "action": "remove"}); err != nil {
				return nil, err
			}
			current, e := s.Store.one(q.ctx(), collection(kind), M{"_id": r["_id"]})
			if e != nil {
				return nil, e
			}
			if current == nil {
				return nil, fail(missing(kind), 404)
			}
			return M{"status": current["status"]}, nil
		}
		if err = s.enqueue(q.ctx(), kind, str(r[idKey(kind)]), job); err != nil {
			return nil, err
		}
		return M{"status": status}, nil
	}
}
func (s *Server) files(mode string) handler {
	return func(q *request) (any, error) {
		if mode == "search" {
			q.W.Header().Set("Cache-Control", "no-cache")
		}
		r, err := q.resource("repo", false)
		if err != nil {
			return nil, err
		}
		if err = s.checkResource(q.ctx(), "repo", r); err != nil {
			return nil, err
		}
		if mode == "counts" {
			q.W.Header().Set("Cache-Control", "no-cache")
			return s.folderCounts(q.ctx(), r)
		}

		query := ""
		if mode == "search" {
			var usable bool
			query, usable, err = fileSearchQuery(q.R.URL.RawQuery)
			if err != nil {
				return nil, err
			}
			if !usable {
				return []M{}, nil
			}
		}
		requested := ""
		if mode != "search" && mode != "counts" {
			requested, err = folderQuery(q.R.URL.RawQuery)
			if err != nil {
				return nil, err
			}
			requested, err = s.originalFolder(q.ctx(), r, requested)
			if err != nil {
				return nil, err
			}
		}
		filter := M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r)}
		if mode != "search" && mode != "counts" {
			filter["path"] = requested
		}
		cursor, err := s.Store.DB.Collection("files").Find(q.ctx(), filter, options.Find().SetSort(bson.D{{Key: "path", Value: 1}, {Key: "name", Value: 1}}).SetBatchSize(256).SetProjection(M{"name": 1, "path": 1, "size": 1, "sha": 1}))
		if err != nil {
			return nil, err
		}
		defer cursor.Close(q.ctx())
		e, err := s.engine(r, "repo")
		if err != nil {
			return nil, err
		}
		q.W.Header().Set("Cache-Control", "no-cache")
		out := []M{}
		lower := cases.Lower(language.Und)
		for cursor.Next(q.ctx()) {
			var row M
			if err := cursor.Decode(&row); err != nil {
				return nil, err
			}
			name, err := e.Path(q.ctx(), str(row["name"]))
			if err != nil {
				return nil, err
			}
			path, err := e.Path(q.ctx(), str(row["path"]))
			if err != nil {
				return nil, err
			}
			if mode == "search" {
				if !strings.Contains(lower.String(path+"/"+name), query) {
					continue
				}
			} else if str(row["path"]) != requested {
				continue
			}
			item := M{"name": name, "path": path}
			if value, ok := row["size"]; ok {
				item["size"] = value
			}

			if mode != "search" && number(row["size"]) != 0 {
				digest := sha1.Sum([]byte(str(row["sha"])))
				item["sha"] = hex.EncodeToString(digest[:])[:8]
			}

			out = append(out, item)
			if mode == "search" && len(out) == 500 {
				break
			}
		}
		if err := cursor.Err(); err != nil {
			return nil, err
		}
		return out, nil
	}
}
func (s *Server) embeddedContent(kind string) handler {
	return func(q *request) (any, error) {
		r, err := q.resource(kind, false)
		if err != nil {
			return nil, err
		}
		if err = s.checkResource(q.ctx(), kind, r); err != nil {
			return nil, err
		}
		out, err := s.embeddedOutput(q.ctx(), kind, r)
		if err != nil {
			return nil, err
		}
		_, err = s.Store.update(q.ctx(), collection(kind), M{"_id": r["_id"]}, M{"$inc": M{"pageView": 1}, "$set": M{"lastView": time.Now()}})
		q.W.Header().Set("Cache-Control", "no-cache")
		return out, err
	}
}

func (s *Server) embeddedOutput(ctx context.Context, kind string, r M) (M, error) {
	e, err := s.engine(r, kind)
	if err != nil {
		return nil, err
	}
	opt := obj(r["options"])
	key := "gist"
	if kind == "pr" {
		key = "pullRequest"
	}
	source := obj(r[key])
	out := selectFields(r, "anonymizeDate")
	if kind == "gist" {
		if v, ok := source["isPublic"]; ok {
			out["isPublic"] = v
		}
	} else {
		for _, k := range []string{"merged", "mergedDate", "state", "draft"} {
			if v, ok := source[k]; ok {
				out[k] = v
			}
		}
	}
	transform := func(value any) (string, error) {
		r, err := e.Transform(ctx, str(value), anonymize.MaxOutput)
		return r.Content, err
	}
	fields := map[string]string{"body": "body", "diff": "diff"}
	if kind == "gist" {
		fields = map[string]string{"title": "description", "username": "ownerLogin"}
	} else {
		fields["title"] = "title"
	}
	for option, field := range fields {
		if boolean(opt[option]) {
			value, err := transform(source[field])
			if err != nil {
				return nil, err
			}
			out[field] = value
		}
	}
	if kind == "gist" && boolean(opt["content"]) {
		files := []M{}
		for _, item := range arr(source["files"]) {
			f := obj(item)
			v := selectFields(f, "language", "size", "type")
			for _, k := range []string{"filename", "content"} {
				v[k], err = transform(f[k])
				if err != nil {
					return nil, err
				}
			}
			files = append(files, v)
		}
		out["files"] = files
	}
	if boolean(opt["comments"]) && source["comments"] != nil {
		comments := []M{}
		for _, item := range arr(source["comments"]) {
			c := obj(item)
			v := M{}
			for option, field := range map[string]string{"body": "body", "username": "author"} {
				if boolean(opt[option]) {
					v[field], err = transform(c[field])
					if err != nil {
						return nil, err
					}
				}
			}
			if boolean(opt["date"]) {
				for _, k := range []string{"updatedDate", "creationDate"} {
					if x, ok := c[k]; ok {
						v[k] = x
					}
				}
			}
			comments = append(comments, v)
		}
		out["comments"] = comments
	}
	if boolean(opt["date"]) {
		for _, k := range []string{"updatedDate", "creationDate"} {
			if x, ok := source[k]; ok {
				out[k] = x
			}
		}
	}
	if boolean(opt["origin"]) {
		if kind == "gist" {
			if x, ok := obj(r["source"])["gistId"]; ok {
				out["sourceGistId"] = x
			}
		} else {
			if x, ok := source["baseRepositoryFullName"]; ok {
				out["baseRepositoryFullName"] = x
			}
		}
	}
	return out, nil
}
