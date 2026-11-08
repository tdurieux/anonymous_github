package server

import (
	"net/http"
	"time"
)

// responseState sits below compression and tracks irreversible writes, including
// responses on routes that do not use compression.
type responseState struct {
	http.ResponseWriter
	committed   bool
	status      int
	bytes       int64
	firstWrite  time.Time
	writeFailed bool
}

func (w *responseState) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseState) WriteHeader(status int) {
	if w.committed {
		return
	}
	w.ResponseWriter.WriteHeader(status)
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.committed = true
		w.status = status
		w.firstWrite = time.Now()
	}
}

func (w *responseState) Write(p []byte) (int, error) {
	if !w.committed {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	w.writeFailed = w.writeFailed || err != nil
	return n, err
}

func (w *responseState) FlushError() error {
	if !w.committed {
		w.WriteHeader(http.StatusOK)
	}
	err := http.NewResponseController(w.ResponseWriter).Flush()
	w.writeFailed = w.writeFailed || err != nil
	return err
}

func (w *responseState) Flush() { _ = w.FlushError() }

func responseCommitted(w http.ResponseWriter) bool {
	for depth := 0; depth < 16; depth++ {
		switch v := w.(type) {
		case *responseState:
			return v.committed
		case *compressionWriter:
			if v.started {
				return true
			}
		}
		wrapped, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return false
		}
		w = wrapped.Unwrap()
	}
	return false
}
