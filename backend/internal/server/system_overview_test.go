package server

import (
	"encoding/json"
	"math"
	"runtime"
	"testing"
	"time"
)

func TestSystemOverviewBrowserContract(t *testing.T) {
	raw, err := json.Marshal(systemOverview(time.Now().Add(-time.Minute)))
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	// Fields consumed by the unchanged TypeScript admin overview template.
	for _, key := range []string{"cpuCount", "cpuPercent", "loadAvg", "memTotal", "memFree", "memUsed", "memPercent", "processRss", "diskTotal", "diskUsed", "diskFree", "diskPercent", "diskMount"} {
		if _, exists := data[key]; !exists {
			t.Fatalf("missing browser field %s", key)
		}
	}
	if runtime.GOOS != "linux" {
		return
	}
	for _, key := range []string{"memTotal", "processRss", "diskTotal"} {
		if n, ok := data[key].(float64); !ok || n <= 0 {
			t.Fatalf("missing live measurement %s", key)
		}
	}
	for _, prefix := range []string{"mem", "disk"} {
		total, used, free := data[prefix+"Total"].(float64), data[prefix+"Used"].(float64), data[prefix+"Free"].(float64)
		if used < 0 || free < 0 || used > total || free > total {
			t.Fatalf("invalid %s byte measurements", prefix)
		}
		if data[prefix+"Percent"] != math.Round(used/total*100) {
			t.Fatalf("invalid %s percent", prefix)
		}
	}
	loads := data["loadAvg"].([]any)
	if len(loads) != 3 || data["cpuPercent"] != math.Round(loads[0].(float64)/data["cpuCount"].(float64)*100) {
		t.Fatal("CPU load contract mismatch")
	}
}
