package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestTypeScriptWorkerQueueCapacities(t *testing.T) {
	data, err := os.ReadFile("testdata/worker-queues.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected []struct {
		Name        string
		Concurrency int
	}
	if err := json.Unmarshal(data, &expected); err != nil {
		t.Fatal(err)
	}
	actual := map[string]int{}
	for _, q := range workerQueues {
		if actual[q.name] != 0 || len(queueActions(q.name)) == 0 {
			t.Fatal("duplicate or unknown worker queue", q)
		}
		actual[q.name] = q.concurrency
	}
	if len(expected) != len(actual) {
		t.Fatal("queue count changed", actual)
	}
	for _, q := range expected {
		if actual[q.Name] != q.Concurrency {
			t.Fatal("TypeScript capacity mismatch", q, actual)
		}
	}
}
