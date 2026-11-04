package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"
)

var errListen = errors.New("listener_start_failed")
var errServe = errors.New("http_server_failed")
var errShutdownTimeout = errors.New("shutdown_grace_period_exceeded")

// The caller may close shared dependencies only when drained is true. On a
// timeout it must terminate the process: a handler or worker may still use them.
func serveAndDrain(ctx context.Context, server *http.Server, jobs func(context.Context), grace time.Duration) (drained bool, result error) {
	if ctx.Err() != nil {
		return true, nil
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return true, errListen
	}
	slog.Info("Go backend listening", "address", listener.Addr().String())
	workers, cancelWorkers := context.WithCancel(ctx)
	defer cancelWorkers()
	jobsDone := make(chan struct{})
	go func() { defer close(jobsDone); jobs(workers) }()
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
	case err := <-serveDone:
		if ctx.Err() == nil || !errors.Is(err, http.ErrServerClosed) {
			result = errServe
		}
		serveDone = nil
	}
	cancelWorkers()
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), grace)
	defer cancelShutdown()
	httpDone := make(chan error, 1)
	go func() { httpDone <- server.Shutdown(shutdown) }()
	for jobsDone != nil || httpDone != nil || serveDone != nil {
		select {
		case <-jobsDone:
			jobsDone = nil
		case err := <-httpDone:
			if err != nil {
				server.Close()
				return false, errShutdownTimeout
			}
			httpDone = nil
		case err := <-serveDone:
			if !errors.Is(err, http.ErrServerClosed) {
				result = errServe
			}
			serveDone = nil
		case <-shutdown.Done():
			server.Close()
			return false, errShutdownTimeout
		}
	}
	return true, result
}
