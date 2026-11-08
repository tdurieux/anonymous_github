package server

import (
	"context"
	"errors"
	"time"
)

// A provider quota delay is not a failed attempt. Unknown or expired reset
// times use the TypeScript worker's one-minute fallback to avoid a busy loop.
func jobRateLimit(job M, err error, now time.Time) (time.Time, bool) {
	var api *APIError
	if str(job["action"]) != "prepare" || !errors.As(providerFailure(err), &api) || api.Status != 429 {
		return time.Time{}, false
	}
	reset := time.UnixMilli(api.ResetAt)
	if api.ResetAt <= 0 || !reset.After(now) {
		reset = now.Add(time.Minute)
	}
	return reset, true
}

func (s *Server) finishJob(ctx context.Context, job M, jobErr error, now time.Time) error {
	set := M{"state": "completed", "finishedAt": now}
	unset := M{"lease": "", "leaseUntil": "", "error": ""}
	if reset, limited := jobRateLimit(job, jobErr, now); limited {
		attempts := number(job["attempts"]) - 1
		if attempts < 0 {
			attempts = 0
		}
		set = M{"state": "delayed", "availableAt": reset, "attempts": attempts}
		unset["finishedAt"] = ""
	} else if jobErr != nil {
		delete(unset, "error")
		set = M{"state": "failed", "finishedAt": now, "error": "job_failed"}
		var api *APIError
		if errors.As(providerFailure(jobErr), &api) {
			set["error"] = api.Code
		}
		if number(job["attempts"]) < jobMaxAttempts(job) {
			set["state"] = "waiting"
			set["availableAt"] = now.Add(jobBackoff(job))
		}
	}
	_, err := s.Store.update(ctx, "gojobs", M{"_id": job["_id"], "state": "active", "lease": job["lease"]}, M{"$set": set, "$unset": unset})
	return err
}

// Imported jobs retain BullMQ retry policies; ordinary Go jobs keep the
// existing three-attempt policy. Migration validates the stored values.
func jobMaxAttempts(job M) int64 {
	if n := number(job["maxAttempts"]); n > 0 {
		return n
	}
	return 3
}
func jobBackoff(job M) time.Duration {
	if job["maxAttempts"] == nil {
		return time.Duration(number(job["attempts"])) * time.Second
	}
	delay := number(job["backoffDelay"])
	if delay <= 0 {
		return 0
	}
	const maxMillis = int64((1<<63 - 1) / time.Millisecond)
	if delay > maxMillis {
		delay = maxMillis
	}
	if str(job["backoffType"]) == "exponential" {
		for i := int64(1); i < number(job["attempts"]) && delay < maxMillis; i++ {
			if delay > maxMillis/2 {
				delay = maxMillis
				break
			}
			delay *= 2
		}
	}
	return time.Duration(delay) * time.Millisecond
}
