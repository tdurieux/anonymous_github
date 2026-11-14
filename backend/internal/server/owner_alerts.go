package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const recipientAlerts = "owner_access_alert_recipients"

func alertRecipientKey(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])
}
func ownerAccessFailure(err error) bool {
	var api *APIError
	if !errors.As(err, &api) || api.Status == 429 || api.Status >= 500 {
		return false
	}
	switch api.Code {
	case "token_expired", "github_oauth_required", "github_app_reconnect_required", "github_app_access_required", "repo_not_found", "repository_not_found", "file_not_accessible", "file_not_found", "pull_request_not_found", "gist_not_found", "repo_not_accessible", "repo_access_limited", "repo_saml_enforcement":
		return true
	}
	return false
}
func alertResourceKind(kind string) string {
	switch kind {
	case "repo":
		return "repository"
	case "pr":
		return "pull-request"
	}
	return kind
}

// Preserve recipient guards across the Node/Go cutover, including delivery
// evidence whose original account or repository has since been deleted.
func (s *Server) initializeOwnerAlerts(ctx context.Context) error {
	if s.Config.EmailAPIKey == "" || s.Config.EmailFrom == "" {
		return nil
	}
	if err := s.recoverUnsentOwnerAlerts(ctx, ""); err != nil {
		return err
	}
	events, err := s.Store.DB.Collection("owner_access_alert_events").Find(ctx, M{"state": M{"$in": []string{"accepted", "failed"}}, "completedAt": M{"$exists": true}})
	if err != nil {
		return err
	}
	defer events.Close(ctx)
	for events.Next(ctx) {
		var event M
		if err = events.Decode(&event); err != nil {
			return err
		}
		key := str(event["recipientKey"])
		if len(key) != 64 {
			continue
		}
		if err = s.billingUpsert(ctx, recipientAlerts, M{"_id": key}, M{"$setOnInsert": M{"state": "recipient_notified", "attemptId": event["attemptId"], "claimedAt": event["completedAt"], "completedAt": event["completedAt"]}}); err != nil {
			return err
		}
	}
	if err = events.Err(); err != nil {
		return err
	}
	for _, kind := range []string{"repo", "pr", "gist"} {
		cursor, err := s.Store.DB.Collection(collection(kind)).Find(ctx, M{"accessAlertClaimedAt": M{"$exists": true}})
		if err != nil {
			return err
		}
		for cursor.Next(ctx) {
			var row M
			if err = cursor.Decode(&row); err != nil {
				cursor.Close(ctx)
				return err
			}
			owner, err := s.Store.one(ctx, "users", M{"_id": row["owner"]})
			if err != nil {
				cursor.Close(ctx)
				return err
			}
			email := accountNotificationEmail(owner)
			if email == "" || !identity(owner).Active() {
				continue
			}
			claim := M{"owner": row["owner"], "resourceKind": alertResourceKind(kind), "resourceId": row["_id"], "generation": row["accessAlertGeneration"], "recovered": false}
			err = s.billingUpsert(ctx, recipientAlerts, M{"_id": alertRecipientKey(email)}, M{"$setOnInsert": M{"state": "legacy", "owner": row["owner"], "resourceKind": alertResourceKind(kind), "resourceId": row["_id"], "generation": row["accessAlertGeneration"], "attemptId": uuid.NewString(), "claimedAt": row["accessAlertClaimedAt"]}, "$addToSet": M{"legacyClaims": claim}})
			if err != nil {
				cursor.Close(ctx)
				return err
			}
		}
		err = cursor.Err()
		cursor.Close(ctx)
		if err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) resetOwnerAlerts(ctx context.Context, owner any, kind string, id any) error {
	// Every dispatch commits against this revision on the owner document.
	if _, err := s.Store.update(ctx, "users", M{"_id": owner}, M{"$inc": M{"accessAlertResetRevision": 1}}); err != nil {
		return err
	}
	kinds := []string{kind}
	if kind == "" {
		kinds = []string{"repo", "pr", "gist"}
	}
	for _, k := range kinds {
		filter := M{"owner": owner}
		if id != nil {
			filter["_id"] = id
		}
		if _, err := s.Store.DB.Collection(collection(k)).UpdateMany(ctx, filter, M{"$set": M{"accessAlertGeneration": uuid.NewString()}, "$unset": M{"accessAlertClaimedAt": 1, "accessAlertAttemptId": 1}}); err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) scheduleOwnerAlert(owner, repoID string, err error) {
	if s.Config.EmailAPIKey == "" || s.Config.EmailFrom == "" || !ownerAccessFailure(err) || repoID == "" || s.ownerAlertSlots == nil {
		return
	}
	select {
	case s.ownerAlertSlots <- struct{}{}:
	default:
		return
	}
	go func() {
		defer func() { <-s.ownerAlertSlots }()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		ownerID, e := oid(owner)
		if e != nil {
			return
		}
		repo, e := s.Store.one(ctx, collection("repo"), M{"repoId": repoID, "owner": ownerID})
		if e == nil && repo != nil {
			_ = s.notifyOwnerAccessProblem(ctx, "repo", repo, err)
		}
	}()
}
func (s *Server) notifyOwnerAccessProblem(ctx context.Context, kind string, resource M, cause error) error {
	if s.Config.EmailAPIKey == "" || s.Config.EmailFrom == "" || !ownerAccessFailure(cause) {
		return nil
	}
	owner, err := s.Store.one(ctx, "users", M{"_id": resource["owner"], "status": M{"$nin": []string{"removed", "banned"}}})
	if err != nil || owner == nil {
		return err
	}
	if len(arr(owner["accessAlertDeactivations"])) > 0 || date(owner["accessAlertResetUntil"]).After(time.Now()) {
		return nil
	}
	email := accountNotificationEmail(owner)
	if email == "" {
		return nil
	}
	identity := M{"_id": resource["_id"], "owner": resource["owner"], "status": M{"$nin": []string{"archived", "expired", "expiring", "removed", "removing"}}}
	snapshot, err := s.Store.one(ctx, collection(kind), identity)
	if err != nil || snapshot == nil {
		return err
	}
	now := time.Now()
	attempt := uuid.NewString()
	key := alertRecipientKey(email)
	if err := s.recoverUnsentOwnerAlerts(ctx, key); err != nil {
		return err
	}
	dispatch := "accessAlertDispatches." + attempt
	ownerFilter := M{"_id": owner["_id"], "status": M{"$nin": []string{"removed", "banned"}}, "accessAlertResetRevision": owner["accessAlertResetRevision"], "accessAlertDeactivations.0": M{"$exists": false}, "$or": []M{{"accessAlertResetUntil": M{"$exists": false}}, {"accessAlertResetUntil": M{"$lte": now}}}}
	ok, err := s.Store.update(ctx, "users", ownerFilter, M{"$set": M{dispatch: M{"state": "prepared", "claimedAt": now}}})
	if err != nil || !ok {
		return err
	}
	started := false
	claimed := false
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if !started {
			_, _ = s.Store.update(cleanup, "users", M{"_id": owner["_id"], dispatch + ".state": "prepared"}, M{"$set": M{dispatch + ".state": "cancelled"}})
			if claimed {
				_, _ = s.Store.update(cleanup, collection(kind), M{"_id": resource["_id"], "owner": owner["_id"], "accessAlertAttemptId": attempt}, M{"$unset": M{"accessAlertClaimedAt": 1, "accessAlertAttemptId": 1}, "$inc": M{"accessAlertClaimRevision": 1}})
				_, _ = s.Store.DB.Collection(recipientAlerts).DeleteOne(cleanup, M{"_id": key, "attemptId": attempt, "state": M{"$in": []string{"pending", "sending"}}})
			}
		}
		if !started {
			_, _ = s.Store.update(cleanup, "users", M{"_id": owner["_id"]}, M{"$unset": M{dispatch: 1}})
		}
	}()
	record := M{"_id": key, "owner": owner["_id"], "resourceKind": alertResourceKind(kind), "resourceId": resource["_id"], "generation": snapshot["accessAlertGeneration"], "resourceRevision": number(snapshot["accessAlertClaimRevision"]), "attemptId": attempt, "claimedAt": now, "state": "pending", "dispatchPrepared": true}
	if _, err = s.Store.DB.Collection(recipientAlerts).InsertOne(ctx, record); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil
		}
		return err
	}
	claimed = true
	identity["accessAlertGeneration"] = snapshot["accessAlertGeneration"]
	identity["accessAlertClaimRevision"] = snapshot["accessAlertClaimRevision"]
	ok, err = s.Store.update(ctx, collection(kind), identity, M{"$set": M{"accessAlertClaimedAt": now, "accessAlertAttemptId": attempt}, "$inc": M{"accessAlertClaimRevision": 1}})
	if err != nil || !ok {
		return err
	}
	code := cause.Error()
	_, err = s.Store.DB.Collection("owner_access_alert_events").InsertOne(ctx, M{"_id": attempt, "attemptId": attempt, "recipientKey": key, "owner": owner["_id"], "resourceKind": alertResourceKind(kind), "resourceId": resource["_id"], "generation": snapshot["accessAlertGeneration"], "state": "prepared", "startedAt": now, "failureCode": code})
	if err != nil {
		return err
	}
	ok, err = s.Store.update(ctx, recipientAlerts, M{"_id": key, "attemptId": attempt, "state": "pending"}, M{"$set": M{"state": "sending"}})
	if err != nil || !ok {
		return err
	}
	base := s.Config.Hostname
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}
	address, err := url.Parse(base)
	if err != nil || address.Host == "" {
		return errors.New("invalid_email_origin")
	}
	address.Path = "/connections"
	address.RawQuery = ""
	address.Fragment = ""
	payload, _ := json.Marshal(M{"from": s.Config.EmailFrom, "to": []string{email}, "subject": "Your Anonymous GitHub connection needs attention", "text": "Anonymous GitHub could not access GitHub using your connection, or could not read a repository.\n\nOpen your connections page to reconnect your account or restore repository access:\n" + address.String() + "\n\nYou are receiving this email because you own content on Anonymous GitHub. You can change your alert address on the connections page.\n"})
	work, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(work, "POST", "https://api.resend.com/emails", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+s.Config.EmailAPIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "owner-access-alert/"+attempt)
	ownerFilter[dispatch+".state"] = "prepared"
	ok, err = s.Store.update(ctx, "users", ownerFilter, M{"$set": M{dispatch + ".state": "committed"}})
	if err != nil || !ok {
		return err
	}
	started = true
	client := *s.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, sendErr := client.Do(request)
	state, status := "failed", 0
	if sendErr == nil {
		status = response.StatusCode
		if status >= 200 && status < 300 {
			state = "accepted"
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
	}
	completion := M{"attemptId": attempt, "recipientKey": key, "owner": owner["_id"], "resourceKind": alertResourceKind(kind), "resourceId": resource["_id"], "generation": snapshot["accessAlertGeneration"], "state": state, "httpStatus": status, "completedAt": time.Now()}
	completion["_id"] = attempt + "/completion"
	cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stop()
	_, _ = s.Store.DB.Collection("owner_access_alert_events").InsertOne(cleanup, completion)
	_, err = s.Store.update(cleanup, recipientAlerts, M{"_id": key, "attemptId": attempt, "state": "sending"}, M{"$set": M{"state": state, "httpStatus": status, "completedAt": completion["completedAt"]}})
	if err == nil {
		_, _ = s.Store.update(cleanup, "users", M{"_id": owner["_id"], dispatch + ".state": "committed"}, M{"$unset": M{dispatch: 1}})
	}
	return err
}

func (s *Server) beginAlertDeactivation(ctx context.Context, owner any) (func(), error) {
	token := uuid.NewString()
	_, err := s.Store.update(ctx, "users", M{"_id": owner}, M{"$addToSet": M{"accessAlertDeactivations": token}, "$inc": M{"accessAlertResetRevision": 1}})
	if err != nil {
		return nil, err
	}
	return func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, _ = s.Store.update(cleanup, "users", M{"_id": owner}, M{"$pull": M{"accessAlertDeactivations": token}})
	}, nil
}

// Cancel expired preparation against the same owner document used by the
// sender's final commit. A committed/ambiguous delivery is never retried.
func (s *Server) recoverUnsentOwnerAlerts(ctx context.Context, key string) error {
	filter := M{"dispatchPrepared": true, "state": M{"$in": []string{"pending", "sending", "cancelled"}}, "claimedAt": M{"$lte": time.Now().Add(-time.Minute)}}
	if key != "" {
		filter["_id"] = key
	}
	cursor, err := s.Store.DB.Collection(recipientAlerts).Find(ctx, filter)
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var record M
		if err := cursor.Decode(&record); err != nil {
			return err
		}
		attempt := str(record["attemptId"])
		if _, err := uuid.Parse(attempt); err != nil {
			continue
		}
		dispatch := "accessAlertDispatches." + attempt
		cancelled, err := s.Store.update(ctx, "users", M{"_id": record["owner"], dispatch + ".state": "prepared"}, M{"$set": M{dispatch + ".state": "cancelled"}})
		if err != nil {
			return err
		}
		if !cancelled {
			owner, err := s.Store.one(ctx, "users", M{"_id": record["owner"]})
			if err != nil {
				return err
			}
			if owner == nil || str(obj(obj(owner["accessAlertDispatches"])[attempt])["state"]) == "committed" {
				continue
			}
		}
		matched, err := s.Store.update(ctx, recipientAlerts, M{"_id": record["_id"], "attemptId": attempt, "state": record["state"]}, M{"$set": M{"state": "cancelled"}})
		if err != nil {
			return err
		}
		if !matched {
			continue
		}
		kind := map[string]string{"repository": "repo", "pull-request": "pr", "gist": "gist"}[str(record["resourceKind"])]
		if kind != "" {
			_, err = s.Store.update(ctx, collection(kind), M{"_id": record["resourceId"], "owner": record["owner"], "accessAlertAttemptId": attempt}, M{"$unset": M{"accessAlertClaimedAt": 1, "accessAlertAttemptId": 1}, "$inc": M{"accessAlertClaimRevision": 1}})
			if err != nil {
				return err
			}
		}
		if _, err = s.Store.DB.Collection(recipientAlerts).DeleteOne(ctx, M{"_id": record["_id"], "attemptId": attempt, "state": "cancelled"}); err != nil {
			return err
		}
		if _, err = s.Store.update(ctx, "users", M{"_id": record["owner"], dispatch + ".state": "cancelled"}, M{"$unset": M{dispatch: 1}}); err != nil {
			return err
		}
	}
	return cursor.Err()
}
