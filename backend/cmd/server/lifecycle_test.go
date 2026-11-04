package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

type drainResult struct {
	drained bool
	err     error
}

func TestServeDrainsRequestsAndWorkers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	requestDone := make(chan struct{})
	workersCancelled := make(chan struct{})
	releaseWorkers := make(chan struct{})
	address := make(chan string, 1)
	server := &http.Server{Addr: "127.0.0.1:0", BaseContext: func(l net.Listener) context.Context { address <- l.Addr().String(); return context.Background() }, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(requestDone)
		close(requestStarted)
		select {
		case <-releaseRequest:
			io.WriteString(w, "complete")
		case <-r.Context().Done():
			t.Error("request cancelled before graceful drain")
		}
	})}
	result := make(chan drainResult, 1)
	go func() {
		drained, err := serveAndDrain(ctx, server, func(ctx context.Context) { <-ctx.Done(); close(workersCancelled); <-releaseWorkers }, 3*time.Second)
		result <- drainResult{drained, err}
	}()
	defer server.Close()
	url := "http://" + waitValue(t, address)
	response := make(chan string, 1)
	go func() {
		client := http.Client{Timeout: 4 * time.Second}
		r, err := client.Get(url)
		if err != nil {
			response <- err.Error()
			return
		}
		defer r.Body.Close()
		b, err := io.ReadAll(r.Body)
		if err != nil {
			response <- err.Error()
			return
		}
		response <- string(b)
	}()
	waitValue(t, requestStarted)
	cancel()
	waitValue(t, workersCancelled)
	select {
	case got := <-result:
		t.Fatal("returned with live request and worker", got)
	case <-time.After(30 * time.Millisecond):
	}
	close(releaseRequest)
	waitValue(t, requestDone)
	if got := waitValue(t, response); got != "complete" {
		t.Fatal(got)
	}
	select {
	case got := <-result:
		t.Fatal("returned before worker stopped", got)
	case <-time.After(30 * time.Millisecond):
	}
	close(releaseWorkers)
	got := waitValue(t, result)
	if !got.drained || got.err != nil {
		t.Fatal(got)
	}
}

func TestServeTimeoutDoesNotPermitDependencyClose(t *testing.T) {
	for _, blocked := range []string{"request", "worker"} {
		t.Run(blocked, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			address := make(chan string, 1)
			entered := make(chan struct{})
			workerExited := make(chan struct{})
			releaseWorker := make(chan struct{})
			defer close(releaseWorker)
			requestCancelled := make(chan struct{})
			server := &http.Server{Addr: "127.0.0.1:0", BaseContext: func(l net.Listener) context.Context { address <- l.Addr().String(); return context.Background() }, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				<-r.Context().Done()
				close(requestCancelled)
			})}
			result := make(chan drainResult, 1)
			go func() {
				drained, err := serveAndDrain(ctx, server, func(ctx context.Context) {
					defer close(workerExited)
					<-ctx.Done()
					if blocked == "worker" {
						<-releaseWorker
					}
				}, 80*time.Millisecond)
				result <- drainResult{drained, err}
			}()
			defer server.Close()
			url := "http://" + waitValue(t, address)
			if blocked == "request" {
				go func() {
					client := http.Client{Timeout: 2 * time.Second}
					r, err := client.Get(url)
					if err == nil {
						r.Body.Close()
					}
				}()
				waitValue(t, entered)
			}
			cancel()
			got := waitValue(t, result)
			if got.drained || !errors.Is(got.err, errShutdownTimeout) {
				t.Fatal(got)
			}
			if blocked == "request" {
				waitValue(t, requestCancelled)
				waitValue(t, workerExited)
			}
		})
	}
}

func TestServeBindFailureStartsNoWorkers(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	called := false
	drained, err := serveAndDrain(context.Background(), &http.Server{Addr: listener.Addr().String()}, func(context.Context) { called = true }, time.Second)
	if !drained || !errors.Is(err, errListen) || called {
		t.Fatal(drained, err, called)
	}
}

func TestServeCancelledBeforeStartup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	drained, err := serveAndDrain(ctx, &http.Server{Addr: "invalid"}, func(context.Context) { t.Error("worker started after cancellation") }, time.Second)
	if !drained || err != nil {
		t.Fatal(drained, err)
	}
}

func waitValue[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for lifecycle event")
		var zero T
		return zero
	}
}

func TestServeUnexpectedCloseStopsWorkers(t *testing.T) {
	address := make(chan string, 1)
	server := &http.Server{Addr: "127.0.0.1:0", BaseContext: func(l net.Listener) context.Context { address <- l.Addr().String(); return context.Background() }}
	defer server.Close()
	stopped := make(chan struct{})
	result := make(chan drainResult, 1)
	go func() {
		drained, err := serveAndDrain(context.Background(), server, func(ctx context.Context) { <-ctx.Done(); close(stopped) }, time.Second)
		result <- drainResult{drained, err}
	}()
	waitValue(t, address)
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	got := waitValue(t, result)
	if !got.drained || !errors.Is(got.err, errServe) {
		t.Fatal(got)
	}
	waitValue(t, stopped)
}
