package termsession

import "sync"

// ringBuffer is a fixed-capacity byte ring buffer holding the most recent N
// bytes written to it (older bytes are silently overwritten once full) —
// the scrollback a reattaching client gets replayed before switching to the
// live stream. Not exported: only used internally by Session.
type ringBuffer struct {
	mu       sync.Mutex
	buf      []byte
	writePos int
	filled   int // bytes currently held, caps at len(buf)
}

func newRingBuffer(capacity int) *ringBuffer {
	return &ringBuffer{buf: make([]byte, capacity)}
}

func (r *ringBuffer) Write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	n := len(r.buf)
	if n == 0 {
		return
	}
	// A write larger than the whole buffer: only its tail (the most recent
	// `n` bytes) can possibly still be present afterward, so skip straight
	// to that instead of writing byte-by-byte around the ring needlessly.
	if len(p) >= n {
		copy(r.buf, p[len(p)-n:])
		r.writePos = 0
		r.filled = n
		return
	}

	copied := copy(r.buf[r.writePos:], p)
	if copied < len(p) {
		copy(r.buf, p[copied:])
	}
	r.writePos = (r.writePos + len(p)) % n
	r.filled = min(r.filled+len(p), n)
}

// Snapshot returns the buffered bytes in oldest-to-newest order.
func (r *ringBuffer) Snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.filled == 0 {
		return nil
	}
	n := len(r.buf)
	out := make([]byte, r.filled)
	if r.filled < n {
		// Never wrapped yet: oldest-to-newest is just buf[0:filled].
		copy(out, r.buf[:r.filled])
		return out
	}
	// Wrapped: oldest byte is the one about to be overwritten next.
	start := r.writePos
	k := copy(out, r.buf[start:])
	copy(out[k:], r.buf[:start])
	return out
}
