package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
)

func (s *Server) reserveBillingExpansion(ctx context.Context, repoID, key string, bytes int64) error {
	if !s.Config.Billing.Enabled || bytes <= 0 || repoID == "" {
		return nil
	}
	repo, err := s.Store.one(ctx, collection("repo"), M{"repoId": repoID})
	if err != nil {
		return err
	}
	if !boolean(repo["billingManaged"]) {
		return nil
	}
	digest := sha256.Sum256([]byte(key))
	key = hex.EncodeToString(digest[:])
	return s.reserveBillingRepository(ctx, str(repo["owner"]), str(repo["repoId"]), 0, str(repo["conference"]), key, bytes)
}

type billingContentReader struct {
	io.ReadCloser
	s                       *Server
	ctx                     context.Context
	repoID, key             string
	expected, read, charged int64
	failed                  error
}

func (r *billingContentReader) Read(p []byte) (int, error) {
	if r.failed != nil {
		return 0, r.failed
	}
	n, err := r.ReadCloser.Read(p)
	r.read += int64(n)
	if extra := r.read - r.expected; extra > 0 && (extra > r.charged || err == io.EOF) {
		reserve := extra

		if e := r.s.reserveBillingExpansion(r.ctx, r.repoID, r.key, reserve); e != nil {
			r.failed = e
			return 0, e
		}
		r.charged = reserve
	}
	return n, err
}
