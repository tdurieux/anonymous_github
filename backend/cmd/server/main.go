package main

import (
	"context"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/server"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "anonymization-worker" {
		os.Exit(anonymize.RunProcess())
	}
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := http.Client{Timeout: 3 * time.Second}
		port := os.Getenv("PORT")
		if port == "" {
			port = "5000"
		}
		response, e := client.Get("http://127.0.0.1:" + port + "/healthcheck")
		if e != nil {
			os.Exit(1)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	os.Exit(run())
}

func configureLogging() {
	level := slog.LevelInfo
	if os.Getenv("NODE_ENV") != "production" {
		level = slog.LevelDebug
	}
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
}
func run() int {
	configureLogging()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	config, err := server.LoadConfig()
	if err != nil {
		slog.Error("configuration rejected", "error", err.Error())
		return 1
	}
	store, err := server.Connect(ctx, config)
	if err != nil {
		slog.Error("startup failed", "error", err.Error())
		return 1
	}
	drained := true
	defer func() {
		if drained {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			store.Close(cleanup)
		}
	}()
	app, err := server.New(config, store)
	if err != nil {
		slog.Error("startup failed", "error", err.Error())
		return 1
	}
	defer func() {
		if drained {
			app.Close()
		}
	}()
	httpServer := &http.Server{Addr: config.Address, Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 2 * time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	drained, err = serveAndDrain(ctx, httpServer, app.RunJobs, 30*time.Second)
	if err != nil {
		slog.Error("server stopped", "error", err.Error())
		return 1
	}
	return 0
}
