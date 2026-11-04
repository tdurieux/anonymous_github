package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/server"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestExecutableSignalsIntegration(t *testing.T) {
	binary, uri, address := os.Getenv("GO_TEST_SERVER_BINARY"), os.Getenv("GO_TEST_MONGODB_URI"), os.Getenv("GO_TEST_REDIS_ADDR")
	if binary == "" || uri == "" || address == "" {
		t.Skip("requires built server and disposable MongoDB/Redis")
	}
	if !strings.HasPrefix(uri, "mongodb://127.0.0.1:") || !strings.HasPrefix(address, "127.0.0.1:") {
		t.Fatal("requires local disposable services")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	for _, signal := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM} {
		t.Run(signal.String(), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			database := "signal_test_" + bson.NewObjectID().Hex()
			store, err := server.Connect(ctx, server.Config{MongoURI: uri, Database: database, RedisAddress: address})
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close(context.Background())
			defer store.DB.Drop(context.Background())
			key := base64.StdEncoding.EncodeToString(make([]byte, 32))
			command := exec.CommandContext(ctx, binary)
			command.Env = []string{"PORT=0", "MONGODB_URI=" + uri, "MONGODB_DATABASE=" + database, "REDIS_HOSTNAME=" + host, "REDIS_PORT=" + port, "SESSION_SECRET=synthetic-signal-test", "CREDENTIAL_KEYS={\"test\":\"" + key + "\"}", "CREDENTIAL_ACTIVE_KEY_ID=test", "FOLDER=" + t.TempDir(), "PUBLIC_DIR=" + t.TempDir(), "CACHE_MONITORING_ENABLED=false", "STORAGE=filesystem"}
			stderr, err := command.StderrPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			ready := make(chan string, 1)
			go func() {
				scanner := bufio.NewScanner(stderr)
				for scanner.Scan() {
					_, suffix, ok := strings.Cut(scanner.Text(), "address=")
					if ok {
						select {
						case ready <- strings.Trim(suffix, "\""):
						default:
						}
					}
				}
			}()
			exited := make(chan error, 1)
			go func() { exited <- command.Wait(); close(exited) }()
			defer func() {
				command.Process.Kill()
				select {
				case <-exited:
				case <-time.After(5 * time.Second):
					t.Error("server process did not exit")
				}
			}()
			var bound string
			select {
			case bound = <-ready:
			case err := <-exited:
				t.Fatal("startup failed", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			_, httpPort, err := net.SplitHostPort(bound)
			if err != nil {
				t.Fatal(bound, err)
			}
			client := http.Client{Timeout: time.Second}
			response, err := client.Get("http://127.0.0.1:" + httpPort + "/healthcheck")
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatal(response.StatusCode)
			}
			if err := command.Process.Signal(signal); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-exited:
				if err != nil {
					t.Fatal("signal did not exit cleanly", err)
				}
			case <-ctx.Done():
				t.Fatal("signal shutdown stalled")
			}
		})
	}
}
