package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"mime"
	"net/http"
	"time"
)

func (s *Server) webhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, fail("not_found", 404))
		return
	}
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		writeError(w, fail("invalid_webhook_signature", 401))
		return
	}
	body, err := readWebhookBody(w, r)
	if err != nil {
		var api *APIError
		if errors.As(err, &api) {
			writeError(w, api)
			return
		}
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			writeError(w, fail("invalid_webhook_request", 413))
			return
		}
		writeError(w, fail("invalid_webhook_request", 400))
		return
	}
	if !s.Config.AppEnabled || !security.VerifyWebhook(body, r.Header.Get("X-Hub-Signature-256"), s.Config.AppWebhookSecret) {
		writeError(w, fail("invalid_webhook_signature", 401))
		return
	}
	var decoded any
	if json.Unmarshal(body, &decoded) != nil {
		writeError(w, fail("webhook_processing_failed", 503))
		return
	}
	eventName := r.Header.Get("X-GitHub-Event")
	if decoded == nil && (eventName == "installation" || eventName == "installation_repositories" || eventName == "github_app_authorization") {
		writeError(w, fail("webhook_processing_failed", 503))
		return
	}
	event := obj(decoded)
	installation := obj(event["installation"])
	if (eventName == "installation" || eventName == "installation_repositories") && jsonSafeInteger(installation["id"]) && str(installation["app_id"]) == s.Config.AppID {
		revision, err := security.RandomToken()
		if err != nil {
			writeError(w, fail("webhook_processing_failed", 503))
			return
		}
		filter := M{"appId": s.Config.AppID, "installationId": installation["id"]}
		_, err = s.Store.DB.Collection("githubinstallations").UpdateOne(r.Context(), filter, M{"$set": M{"blocked": true, "revision": revision, "reconciliationPending": str(event["action"]) != "deleted"}}, options.UpdateOne().SetUpsert(true))
		if err != nil {
			writeError(w, fail("webhook_processing_failed", 503))
			return
		}
		if str(event["action"]) != "deleted" {
			jwt, err := s.appJWT()
			if err != nil {
				writeError(w, fail("webhook_processing_failed", 503))
				return
			}
			err = s.reconcileInstallation(r.Context(), number(installation["id"]), revision, jwt)
			if err != nil {
				writeError(w, fail("webhook_processing_failed", 503))
				return
			}
		}
	}
	if eventName == "github_app_authorization" && str(event["action"]) == "revoked" && inputTruthy(obj(event["sender"])["id"]) {
		users, err := s.Store.list(r.Context(), "users", M{"externalIDs.github": str(obj(event["sender"])["id"])}, 0, nil)
		if err != nil {
			writeError(w, fail("webhook_processing_failed", 503))
			return
		}
		for _, u := range users {
			row, err := s.Store.one(r.Context(), "credentials", M{"ownerId": u["_id"], "provider": "github-app-user"})
			if err != nil {
				writeError(w, fail("webhook_processing_failed", 503))
				return
			}
			if row == nil || boolean(row["revoked"]) {
				continue
			}
			ok, err := s.Store.update(r.Context(), "credentials", M{"_id": row["_id"], "revision": row["revision"]}, M{"$set": M{"reconciliationPending": true}})
			if err != nil {
				writeError(w, fail("webhook_processing_failed", 503))
				return
			}
			if ok {
				if err = s.reconcileGrant(r.Context(), row); err != nil {
					writeError(w, fail("webhook_processing_failed", 503))
					return
				}
			}

		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) reconcileInstallations(ctx context.Context) {
	if !s.Config.AppEnabled {
		return
	}
	rows, e := s.Store.list(ctx, "githubinstallations", M{"appId": s.Config.AppID, "reconciliationPending": true}, 100, nil)
	if e != nil || len(rows) == 0 {
		return
	}
	jwt, e := s.appJWT()
	if e != nil {
		return
	}
	for _, row := range rows {
		s.reconcileInstallation(ctx, number(row["installationId"]), str(row["revision"]), jwt)
	}
}

// A completed reconciliation consumes its revision. Replayed or in-flight
// responses cannot overwrite a newer webhook or another completed response.
func (s *Server) reconcileInstallation(ctx context.Context, id int64, revision, jwt string) error {
	current, err := s.githubObject(ctx, "GET", fmt.Sprintf("/app/installations/%d", id), jwt, nil)
	if err != nil {
		return err
	}
	if str(current["app_id"]) != s.Config.AppID {
		return fail("invalid_installation", 502)
	}
	account := obj(current["account"])
	if current["account"] == nil {
		return fail("invalid_installation", 502)
	}
	nextRevision, err := security.RandomToken()
	if err != nil {
		return err
	}
	fields := M{"blocked": inputTruthy(current["suspended_at"]), "reconciliationPending": false,
		"checkedAt": time.Now(), "revision": nextRevision}
	// Mongoose ignores undefined values but preserves explicit nulls.
	for source, target := range map[string]string{"id": "accountId", "login": "accountLogin", "type": "accountType"} {
		if value, exists := account[source]; exists {
			fields[target] = value
		}
	}
	_, err = s.Store.update(ctx, "githubinstallations", M{"appId": s.Config.AppID, "installationId": id, "revision": revision}, M{"$set": fields})
	return err
}

func (s *Server) reconcileGrant(ctx context.Context, row M) error {
	if row == nil || boolean(row["revoked"]) {
		return nil
	}
	checkedRevision := row["revision"]
	token, e := s.credentialForReconciliation(ctx, row["ownerId"], "github-app-user", true)
	if e == nil {
		// Refresh can replace the revision while retaining the pending flag.
		// Only clear that flag for the exact token checked below; a concurrent
		// login or revocation must retain its own state.
		current, err := s.Store.one(ctx, "credentials", M{"_id": row["_id"]})
		if err != nil {
			return err
		}
		if current != nil && !boolean(current["revoked"]) {
			if encrypted, err := envelope(current["encryptedToken"]); err == nil {
				if stored, err := s.Config.Cipher.Decrypt(encrypted, str(row["ownerId"]), "github-app-user", ""); err == nil && stored == token {
					checkedRevision = current["revision"]
				}
			}
		}
		_, e = s.githubObject(ctx, "GET", "/user", token, nil)
	}
	if e != nil && e.Error() != "github_app_reconnect_required" {
		return e
	}
	filter := M{"_id": row["_id"], "revision": checkedRevision, "revoked": M{"$ne": true}}
	fields := M{"reconciliationPending": false}
	if e != nil {
		revision, err := security.RandomToken()
		if err != nil {
			return err
		}
		// Match TypeScript's original-grant guard on revocation.
		filter["revision"] = row["revision"]
		fields["revoked"] = true
		fields["revision"] = revision
	}
	_, err := s.Store.update(ctx, "credentials", filter, M{"$set": fields})
	return err
}
func (s *Server) reconcileGrants(ctx context.Context) {
	if !s.Config.AppEnabled {
		return
	}
	rows, e := s.Store.list(ctx, "credentials", M{"provider": "github-app-user", "reconciliationPending": true}, 100, nil)
	if e != nil {
		return
	}
	for _, row := range rows {
		s.reconcileGrant(ctx, row)
	}
}
