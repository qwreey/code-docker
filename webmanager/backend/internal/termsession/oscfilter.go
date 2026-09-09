package termsession

import "bytes"

// clipboardFilter strips OSC 52 (set/query the system clipboard) out of the
// PTY byte stream on its way into the scrollback ringBuffer, leaving the
// live stream every attached sink gets untouched.
//
// It exists because the ring holds raw bytes, so a sequence whose effect is
// an *action* rather than drawing gets performed again every time a client
// attaches and writeScrollback replays that window. OSC 52 is the one with
// a user-visible side effect outside the terminal: copy something in tab A
// (tmux/vim with set-clipboard, `claude`, the xclip/wl-copy shims), copy
// something else in tab B, come back to A, and A's replay silently puts its
// old text back on the system clipboard — measured, and the clipboard keeps
// getting clobbered on every tab switch for as long as that copy stays
// inside the 256KiB window. Nothing is lost by dropping it from the ring:
// OSC 52 draws no cells, so the replayed screen is byte-identical without
// it.
//
// Filtering on the way *in* rather than at replay time is what makes this
// exact. The ring evicts from the head, so a snapshot can begin in the
// middle of a sequence — a filter reading the snapshot would see a headless
// OSC 52 tail (or, worse, mistake the tail of a discarded payload for the
// start of one). Here the parser sees the same unbroken stream modeTracker
// does, carrying its state across Feed-sized chunk boundaries, so a
// sequence split over two PTY reads is still recognized as one.
//
// Deliberately narrow: only OSC 52 is removed. Other replay-with-a-side-
// effect sequences exist (a device-status query like "\x1b[6n" replays into
// a client that dutifully answers it, injecting a stray report into the
// shell's stdin), but those are bounded, self-inflicted noise inside the
// terminal, whereas this one reaches out and overwrites state the user owns
// elsewhere. Kept as a plain byte filter rather than a second job for
// modeTracker: that one tracks state to *re-emit*, this one only ever
// deletes, and mixing the two would put a rewriting parser on the path of
// every byte the tracker cares about.
type clipboardFilter struct {
	state filterState
	// prefix holds the digits of an OSC's numeric identifier while it is
	// still undecided ("52" or not), i.e. the only bytes this filter ever
	// buffers. Never more than maxOSCPrefix of them.
	prefix []byte
}

type filterState int

const (
	filterGround filterState = iota
	// filterEscape: an ESC was seen; only "]" (OSC) is of interest, every
	// other introducer falls through untouched.
	filterEscape
	// filterPrefix: collecting the OSC identifier, holding those bytes back
	// until it is known whether the sequence is a 52.
	filterPrefix
	// filterDrop/filterPass: inside a string whose fate is settled -
	// discard it or copy it through until its terminator.
	filterDrop
	filterPass
	// ...Esc variants: an ESC inside such a string, which ends it when
	// followed by "\" (ST) and is part of the payload otherwise.
	filterDropEsc
	filterPassEsc
)

// maxOSCPrefix bounds the identifier bytes held back before the sequence is
// treated as malformed and passed through verbatim. Real identifiers are
// four digits at most; this only stops binary garbage cat'd to the terminal
// from buffering without bound.
const maxOSCPrefix = 8

func newClipboardFilter() *clipboardFilter {
	return &clipboardFilter{}
}

// Filter returns p with any OSC 52 removed. The returned slice is either p
// itself (nothing to strip, the overwhelmingly common case) or a fresh
// buffer - p is never modified in place, since pump forwards that same
// chunk on to every live sink.
func (f *clipboardFilter) Filter(p []byte) []byte {
	// Nothing can start, continue or end a sequence in a chunk with no ESC
	// in it while the parser sits at ground.
	if f.state == filterGround && bytes.IndexByte(p, 0x1b) < 0 {
		return p
	}

	out := make([]byte, 0, len(p))
	for _, b := range p {
		switch f.state {
		case filterGround:
			out = append(out, b)
			if b == 0x1b {
				f.state = filterEscape
			}
		case filterEscape:
			switch b {
			case ']':
				// Hold the "\x1b]" back too: emitting it now would leave an
				// orphaned introducer behind if this turns out to be a 52.
				out = out[:len(out)-1]
				f.prefix = f.prefix[:0]
				f.state = filterPrefix
			case 0x1b:
				// A second ESC restarts the sequence.
				out = append(out, b)
			case 'P', '^', '_', 'X':
				// DCS/PM/APC/SOS: arbitrary payloads, so skip to the
				// terminator rather than scanning them for an OSC that isn't
				// really there.
				out = append(out, b)
				f.state = filterPass
			default:
				out = append(out, b)
				f.state = filterGround
			}
		case filterPrefix:
			switch {
			case b == ';':
				if f.isClipboard() {
					f.state = filterDrop
					break
				}
				out = f.flushPrefix(out)
				out = append(out, b)
				f.state = filterPass
			case b == 0x07: // BEL, an empty OSC
				if f.isClipboard() {
					f.state = filterGround
					break
				}
				out = f.flushPrefix(out)
				out = append(out, b)
				f.state = filterGround
			case b == 0x1b:
				if f.isClipboard() {
					f.state = filterDropEsc
					break
				}
				out = f.flushPrefix(out)
				out = append(out, b)
				f.state = filterPassEsc
			case b >= '0' && b <= '9' && len(f.prefix) < maxOSCPrefix:
				f.prefix = append(f.prefix, b)
			default:
				// Not a numeric identifier: malformed, or an OSC spelling
				// this filter has no business rewriting. Let it through.
				out = f.flushPrefix(out)
				out = append(out, b)
				f.state = filterPass
			}
		case filterDrop:
			switch b {
			case 0x07:
				f.state = filterGround
			case 0x1b:
				f.state = filterDropEsc
			}
		case filterDropEsc:
			if b == '\\' {
				f.state = filterGround
			} else {
				f.state = filterDrop
			}
		case filterPass:
			out = append(out, b)
			switch b {
			case 0x07:
				f.state = filterGround
			case 0x1b:
				f.state = filterPassEsc
			}
		case filterPassEsc:
			out = append(out, b)
			if b == '\\' {
				f.state = filterGround
			} else {
				f.state = filterPass
			}
		}
	}
	return out
}

// isClipboard reports whether the identifier collected so far is OSC 52.
func (f *clipboardFilter) isClipboard() bool {
	return string(f.prefix) == "52"
}

// flushPrefix emits the introducer and identifier bytes held back while the
// sequence was undecided, for an OSC that turned out not to be a 52.
func (f *clipboardFilter) flushPrefix(out []byte) []byte {
	out = append(out, 0x1b, ']')
	return append(out, f.prefix...)
}
