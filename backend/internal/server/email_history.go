package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const emailDeliveryHistory = "email_delivery_history"

// Auditing runs alongside dispatch, after the caller's lifecycle commitment.
// History contains delivery metadata only. A history outage cannot prevent mail.
func (s *Server) sendTrackedEmail(request *http.Request, metadata M) (*http.Response, error) {
	id := uuid.NewString()
	record := selectFields(metadata, "kind", "recipient", "ownerId", "resourceId", "resourceKind")
	record["_id"], record["state"], record["createdAt"] = id, "sending", time.Now()
	recorded := make(chan bool, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 5*time.Second)
		defer cancel()
		_, err := s.Store.DB.Collection(emailDeliveryHistory).InsertOne(ctx, record)
		recorded <- err == nil
	}()
	client := *s.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	completed := time.Now()
	if <-recorded {
		state := "unknown"
		fields := M{"completedAt": completed}
		if err == nil {
			state = "rejected"
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				state = "accepted"
			}
			fields["httpStatus"] = response.StatusCode
		}
		fields["state"] = state
		ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 5*time.Second)
		_, _ = s.Store.update(ctx, emailDeliveryHistory, M{"_id": id}, M{"$set": fields})
		cancel()
	}
	return response, err
}

// Keep the claim after an ambiguous response: Resend may have accepted mail.
// Delivery is once per expiration date, including after reactivation and expiry.
func (s *Server) notifyRepositoryExpired(ctx context.Context, id any) {
	if s.Config.EmailAPIKey == "" || s.Config.EmailFrom == "" {
		return
	}
	repo, err := s.Store.one(ctx, collection("repo"), M{"_id": id, "status": "expired"})
	if err != nil || repo == nil {
		return
	}
	opt := obj(repo["options"])
	expiration, valid := storedDate(opt["expirationDate"])
	if !valid || opt["expirationMode"] == "never" || expiration.After(time.Now()) {
		return
	}
	owner, err := s.Store.one(ctx, "users", M{"_id": repo["owner"], "status": M{"$nin": []string{"removed", "banned"}}})
	if err != nil || owner == nil {
		return
	}
	recipient := accountNotificationEmail(owner)
	if recipient == "" {
		return
	}
	base := s.Config.Hostname
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}
	address, err := url.Parse(base)
	if err != nil || address.Host == "" {
		return
	}
	address.Path, address.RawQuery, address.Fragment = "/dashboard", "", ""
	claim := M{"_id": id, "owner": repo["owner"], "status": "expired", "statusDate": repo["statusDate"], "options.expirationMode": opt["expirationMode"], "options.expirationDate": opt["expirationDate"], "expirationEmailClaimedFor": M{"$ne": opt["expirationDate"]}}
	matched, err := s.Store.update(ctx, collection("repo"), claim, M{"$set": M{"expirationEmailClaimedFor": opt["expirationDate"]}})
	if err != nil || !matched {
		return
	}
	redirect := ""
	if opt["expirationMode"] == "redirect" {
		redirect = " Its link now redirects to the original repository."
	}
	body, _ := json.Marshal(M{"from": s.Config.EmailFrom, "to": []string{recipient}, "subject": "Your Anonymous GitHub repository has expired", "text": fmt.Sprintf("Your anonymized repository %q expired on %s (UTC).\n\nIts anonymized content is no longer available.%s\n\nOpen your dashboard to manage your repositories:\n%s\n\nYou are receiving this email because you own this repository on Anonymous GitHub. You can change your alert address on the connections page.\n", str(repo["repoId"]), expiration.UTC().Format("2006-01-02"), redirect, address.String())})
	work, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(work, "POST", "https://api.resend.com/emails", bytes.NewReader(body))
	if err != nil {
		return
	}
	request.Header.Set("Authorization", "Bearer "+s.Config.EmailAPIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", fmt.Sprintf("repository-expired/%s/%d", str(id), expiration.UnixMilli()))
	response, err := s.sendTrackedEmail(request, M{"kind": "repository-expiration", "recipient": recipient, "ownerId": str(repo["owner"]), "resourceId": str(id), "resourceKind": "repository"})
	if err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
	}
}
