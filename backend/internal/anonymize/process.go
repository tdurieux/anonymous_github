package anonymize

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sync/semaphore"
	"io"
	"os"
	"os/exec"
	"runtime/debug"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

type ProcessRequest struct {
	Options   Options `json:"options"`
	Context   Context `json:"context"`
	MaxOutput int     `json:"maxOutput"`
	// CacheScope is a server-owned repository revision, never a client key.
	CacheScope string                             `json:"cacheScope,omitempty"`
	CacheOwner string                             `json:"cacheOwner,omitempty"`
	CacheEvent func(bool)                         `json:"-"`
	StageEvent func(string, time.Duration, error) `json:"-"`
}
type ProcessResult struct {
	Changed bool   `json:"changed"`
	Error   string `json:"error,omitempty"`
}
type Pool struct {
	slots   chan struct{}
	waiting atomic.Int64
	starts  atomic.Uint64
	binary  string
	memory  *semaphore.Weighted
	budget  int64
	results resultCache
}

func NewPool(binary string, concurrency int) *Pool {
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 4 {
		concurrency = 4
	}
	mb, err := strconv.ParseInt(os.Getenv("ANONYMIZATION_MEMORY_MB"), 10, 64)
	if err != nil || mb < 128 {
		mb = 512
	}
	mb = min(mb, 16384)
	return &Pool{slots: make(chan struct{}, concurrency), binary: binary, memory: semaphore.NewWeighted(mb * 1024 * 1024), budget: mb * 1024 * 1024}
}
func (p *Pool) Stats() map[string]any {
	return map[string]any{"running": len(p.slots), "waiting": p.waiting.Load(), "maxWorkers": cap(p.slots), "maxWaiting": 16, "workerStarts": p.starts.Load()}
}

// Process confines each transform to a killable child with no inherited
// credentials. Only already-open input/output descriptors cross the boundary.
// GOMEMLIMIT is a GC target, not a hard limit; deploy workers within the
// documented container memory cap in addition to these admission limits.
func (p *Pool) Process(ctx context.Context, input io.Reader, request ProcessRequest) (resultFile *os.File, changed bool, resultCleanup func(), resultErr error) {
	if err := ctx.Err(); err != nil {
		return nil, false, nil, err
	}
	if p.waiting.Add(1) > 16 {
		p.waiting.Add(-1)
		return nil, false, nil, errors.New("anonymization_queue_full")
	}
	waitStarted := time.Now()
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	select {
	case p.slots <- struct{}{}:
		p.waiting.Add(-1)
		cancel()
		request.observeStage("worker_wait", waitStarted, nil)
	case <-wait.Done():
		p.waiting.Add(-1)
		request.observeStage("worker_wait", waitStarted, wait.Err())
		cancel()
		return nil, false, nil, errors.New("anonymization_cancelled")
	}
	var once sync.Once
	var weight int64
	release := func() {
		once.Do(func() {
			if weight > 0 {
				p.memory.Release(weight)
			}
			<-p.slots
		})
	}
	directory, err := os.MkdirTemp("", "anonymous-go-text-")
	if err != nil {
		release()
		return nil, false, nil, err
	}
	cleanup := func() { os.RemoveAll(directory) }
	in, err := os.OpenFile(directory+"/input", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		cleanup()
		release()
		return nil, false, nil, err
	}
	defer in.Close()
	digest := sha256.New()
	count, err := io.Copy(io.MultiWriter(in, digest), contextReader{ctx, io.LimitReader(inputReader{input}, MaxInput+1)})
	if ctx.Err() != nil {
		cleanup()
		release()
		return nil, false, nil, ctx.Err()
	}
	if err != nil {
		cleanup()
		release()
		return nil, false, nil, err
	}
	if count > MaxInput {
		cleanup()
		release()
		return nil, false, nil, errors.New("anonymization_input_too_large")
	}
	if err := ctx.Err(); err != nil {
		cleanup()
		release()
		return nil, false, nil, err
	}
	cacheKey := ""
	if request.CacheScope != "" {
		settings, marshalErr := json.Marshal([]any{"go-matcher-result-v1", hex.EncodeToString(digest.Sum(nil)), request})
		if marshalErr != nil {
			cleanup()
			release()
			return nil, false, nil, marshalErr
		}
		keyDigest := sha256.Sum256(settings)
		cacheKey = hex.EncodeToString(keyDigest[:])
		if out, changed, hit := p.results.copy(ctx, cacheKey, directory+"/output"); hit {
			if request.CacheEvent != nil {
				request.CacheEvent(true)
			}
			release()
			return out, changed, func() { out.Close(); cleanup() }, nil
		}
		if request.CacheEvent != nil {
			request.CacheEvent(false)
		}
		done, waitErr := p.results.begin(ctx, cacheKey)
		if waitErr != nil {
			cleanup()
			release()
			return nil, false, nil, waitErr
		}
		defer done()
		if out, changed, hit := p.results.copy(ctx, cacheKey, directory+"/output"); hit {
			release()
			return out, changed, func() { out.Close(); cleanup() }, nil
		}
	}
	required := int64(64*1024*1024) + 4*count
	if required > p.budget {
		cleanup()
		release()
		return nil, false, nil, errors.New("anonymization_memory_budget_exceeded")
	}
	memoryStarted := time.Now()
	memoryWait, memoryCancel := context.WithTimeout(ctx, 30*time.Second)
	err = p.memory.Acquire(memoryWait, required)
	request.observeStage("worker_wait", memoryStarted, err)
	memoryCancel()
	if err != nil {
		cleanup()
		release()
		return nil, false, nil, errors.New("anonymization_cancelled")
	}
	weight = required
	if _, err = in.Seek(0, io.SeekStart); err != nil {
		cleanup()
		release()
		return nil, false, nil, err
	}
	out, err := os.OpenFile(directory+"/output", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		cleanup()
		release()
		return nil, false, nil, err
	}
	work, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	data, err := json.Marshal(request)
	if err != nil {
		out.Close()
		cleanup()
		release()
		return nil, false, nil, err
	}
	cmd := exec.CommandContext(work, p.binary, "anonymization-worker")
	cmd.Stdin = bytes.NewReader(data)
	cmd.ExtraFiles = []*os.File{in, out}
	cmd.Dir = directory
	cmd.Env = []string{"GOMEMLIMIT=384MiB", "GOMAXPROCS=1"}
	var response cappedBuffer
	cmd.Stdout = &response
	cmd.Stderr = io.Discard
	p.starts.Add(1)
	workStarted := time.Now()
	err = cmd.Run()
	workElapsed := time.Since(workStarted)
	defer func() {
		if request.StageEvent != nil {
			request.StageEvent("anonymize", workElapsed, resultErr)
		}
	}()
	if work.Err() != nil {
		release()
		out.Close()
		cleanup()
		return nil, false, nil, errors.New("anonymization_deadline_exceeded")
	}
	var result ProcessResult
	if err != nil || json.Unmarshal(response.Bytes(), &result) != nil {
		release()
		out.Close()
		cleanup()
		return nil, false, nil, errors.New("anonymization_worker_failed")
	}
	if result.Error != "" {
		release()
		out.Close()
		cleanup()
		return nil, false, nil, errors.New(result.Error)
	}
	if _, err = out.Seek(0, io.SeekStart); err != nil {
		release()
		out.Close()
		cleanup()
		return nil, false, nil, err
	}
	if cacheKey != "" {
		p.results.put(ctx, cacheKey, request.CacheOwner, out, result.Changed)
	}
	if err := ctx.Err(); err != nil {
		out.Close()
		cleanup()
		release()
		return nil, false, nil, err
	}
	// The worker has exited and its result is on disk. A slow output reader
	// must not retain worker/memory admission and time out unrelated work.
	release()
	return out, result.Changed, func() { out.Close(); cleanup() }, nil
}

type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 4096 {
		return 0, errors.New("worker_response_too_large")
	}
	return b.Buffer.Write(p)
}

func RunProcess() int {
	debug.SetMemoryLimit(384 * 1024 * 1024)
	var request ProcessRequest
	if json.NewDecoder(io.LimitReader(os.Stdin, 1024*1024)).Decode(&request) != nil {
		fmt.Println(`{"error":"invalid_worker_request"}`)
		return 1
	}
	in, out := os.NewFile(3, "input"), os.NewFile(4, "output")
	if in == nil || out == nil {
		return 1
	}
	defer in.Close()
	defer out.Close()
	body, err := io.ReadAll(io.LimitReader(in, MaxInput+1))
	if err != nil || len(body) > MaxInput {
		fmt.Println(`{"error":"anonymization_input_too_large"}`)
		return 1
	}
	engine, err := New(request.Options, request.Context)
	if err != nil {
		json.NewEncoder(os.Stdout).Encode(ProcessResult{Error: err.Error()})
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	limit := request.MaxOutput
	if limit <= 0 || limit > MaxOutput {
		limit = MaxOutput
	}
	output, changed, err := engine.Bytes(ctx, body, limit)
	if err != nil {
		json.NewEncoder(os.Stdout).Encode(ProcessResult{Error: err.Error()})
		return 0
	}
	if _, err = out.Write(output); err != nil {
		fmt.Println(`{"error":"anonymization_output_failed"}`)
		return 1
	}
	json.NewEncoder(os.Stdout).Encode(ProcessResult{Changed: changed})
	return 0
}

func (r ProcessRequest) observeStage(name string, started time.Time, err error) {
	if r.StageEvent != nil {
		r.StageEvent(name, time.Since(started), err)
	}
}
