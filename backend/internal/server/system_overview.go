package server

import (
	"runtime"
	"time"
)

func systemOverview(started time.Time) M {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	out := M{"platform": runtime.GOOS, "arch": runtime.GOARCH, "nodeVersion": runtime.Version(), "runtime": "go", "uptime": time.Since(started).Seconds(), "cpuCount": runtime.NumCPU(), "processHeapUsed": memory.HeapAlloc, "processHeapTotal": memory.HeapSys}
	// Unsupported measurements are null rather than invented zero utilization.
	for _, field := range []string{"cpuPercent", "loadAvg", "memTotal", "memFree", "memUsed", "memPercent", "processRss", "diskTotal", "diskUsed", "diskFree", "diskPercent"} {
		out[field] = nil
	}
	out["diskMount"] = "/"
	platformSystemOverview(out)
	return out
}
