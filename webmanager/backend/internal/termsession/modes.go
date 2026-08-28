package termsession

import (
	"sort"
	"strconv"
	"strings"
)

// modeTracker watches the PTY output stream go by and remembers the sticky
// terminal state a full-screen application set up, so a client attaching
// later can be put back into it.
//
// It exists because the scrollback ringBuffer holds raw bytes with a fixed
// byte budget (WEBMANAGER_TERMINAL_SESSION_SCROLLBACK_BYTES, 256KiB by
// default), so the one-off sequences an application writes when it starts
// ("\x1b[?1049h" to switch to the alternate screen, "\x1b[1;24r" to set a
// scroll region, the mouse and bracketed-paste enables, ...) scroll out of
// that window within seconds of a busy TUI redrawing itself. Everything the
// replay then contains is *drawing*, and the application never re-emits its
// setup on SIGWINCH — it just redraws — so nudgeRepaint can't recover this
// either. The visible result was a client that renders the application
// correctly while being in the wrong state: every redraw piled into the
// normal buffer's scrollback (so touch/wheel scrolling wandered through
// hundreds of stale frames instead of reaching the application), and
// bracketed paste / mouse reporting / cursor visibility were silently off
// for the rest of that connection's life.
//
// Tracking is incremental over the live stream rather than derived from the
// ring, so it's exact regardless of how much output has been discarded.
// It is deliberately not a terminal emulator: only the state below is
// tracked, and screen *content* is still left to the raw replay plus
// nudgeRepaint. What earns a place here is state an application sets once
// and never re-emits; anything a redraw rewrites on its own (SGR attributes,
// cursor position, erase/insert operations) is intentionally absent.
//
// Deliberately not tracked, having weighed each one:
//   - DEC private mode 2026 (synchronized output). It is toggled per frame,
//     not once, and restoring it *on* would leave a client that never
//     receives the matching reset frozen on a blank screen — strictly worse
//     than letting it default off.
//   - The saved cursor (DECSC "\x1b7" / mode 1048) and the XTWINOPS title
//     stack. Both are stacks/snapshots whose contents can't be reconstructed
//     from the value alone, and nothing malfunctions when they start empty.
//   - Colors and title: OSC 4 (palette), OSC 10/11/12 (default fg/bg/cursor)
//     and OSC 0/2 (window title). These are the one sticky class that is
//     purely cosmetic — nothing misbehaves, it just looks different — and
//     restoring them is actively worse for `webmanager --attach`, which
//     writes into a terminal it does not own: there is no way to put the
//     user's own palette back on detach, whereas every mode below has a
//     well-defined default that ResetModesSequence can return to. The
//     browser client, meanwhile, already has its own theme, which is the
//     appearance the user actually chose.
//   - DECSLRM left/right margins, "\x1b[>Ps u" (kitty keyboard) and DEC
//     private mode 5 (DECSCNM reverse video): not implemented by the
//     xterm.js version the frontend uses, so there is no state to restore
//     there for the browser client.
type modeTracker struct {
	// dec holds the DEC private modes in decModeDefault whose value
	// currently differs from that mode's terminal default; a mode set back
	// to its default is deleted, so an empty map means "nothing to restore".
	// ansi is the same for the two non-private modes worth tracking.
	dec  map[int]bool
	ansi map[int]bool
	// keypadApplication tracks DECKPAM/DECKPNM ("\x1b=" / "\x1b>"), which
	// are plain ESC sequences rather than CSI ones (DEC private mode 66 is
	// the equivalent spelling and is tracked in dec).
	keypadApplication bool
	// charsets holds the full designation sequence last seen for each of
	// G0..G3 (e.g. "(0" for "designate G0 as DEC line drawing"), and
	// charsetLevel the GL invocation SI/SO/locking shifts last selected.
	// This is the state behind box-drawing UIs: an application that
	// designates G1 once at startup and then flips between them with bare
	// SI/SO bytes renders its borders as ASCII letters on a client that
	// missed the designation.
	charsets     [4]string
	charsetLevel int
	// scrollRegion is the parameter string of the last DECSTBM ("\x1b[1;24r"
	// → "1;24"), empty once reset to the full screen. vim sets one on every
	// start and never repeats it. It is restored verbatim even when the
	// attaching client is a different size: that is the region the running
	// application still believes in, and the SIGWINCH nudgeRepaint sends
	// right after the replay is what makes the application re-issue one for
	// the new size — guessing a resized region here would just fight it.
	scrollRegion string
	// cursorStyle is the parameter of the last DECSCUSR ("\x1b[2 q" → "2"),
	// empty for the terminal default.
	cursorStyle string
	// modifyOtherKeys holds the xterm key-modifier resources set via
	// "\x1b[>Ps;Ps m" (vim sets ">4;2m"). xterm.js ignores these, but a real
	// terminal on the other end of `webmanager --attach` does not, and
	// getting them wrong changes how every keystroke is encoded.
	modifyOtherKeys map[int]string

	// Parser state, carried across Feed calls so a sequence split over two
	// PTY reads (a real occurrence — pump reads fixed-size chunks with no
	// regard for sequence boundaries) is still parsed as one.
	state       parseState
	params      []byte
	charsetSlot int
}

type parseState int

const (
	stateGround parseState = iota
	stateEscape
	stateCSI
	// stateCharset collects the intermediates and final byte of a charset
	// designation ("\x1b(0", "\x1b(%5", ...) after its designator byte.
	stateCharset
	// stateString covers OSC/DCS/APC/PM/SOS payloads, which can contain
	// arbitrary bytes: they must be skipped wholesale rather than scanned
	// for CSI sequences that aren't really there (a window title of
	// "\x1b[?1049h", say).
	stateString
	stateStringEsc
)

// maxParams bounds the CSI parameter bytes buffered before a sequence is
// abandoned. Nothing real comes close; this only stops a stream of garbage
// (a binary file cat'd to the terminal) from growing the buffer without
// bound.
const maxParams = 64

// decModeDefault gives the power-on value of every DEC private mode this
// tracks. Restoring means emitting only the modes that currently differ.
//
// A few of these (1005, 1007, 1015) are no-ops in the xterm.js build the
// browser frontend uses, but are kept because `webmanager --attach` relays
// the same stream into a real terminal, which does implement them.
var decModeDefault = map[int]bool{
	1:    false, // DECCKM, application cursor keys (arrow keys send ESC O A)
	6:    false, // DECOM, origin mode (cursor addressing relative to the scroll region)
	7:    true,  // DECAWM, autowrap
	9:    false, // X10 mouse reporting
	12:   false, // cursor blink
	25:   true,  // DECTCEM, cursor visible
	45:   false, // reverse wraparound
	47:   false, // legacy alternate screen buffer
	66:   false, // DECNKM, application keypad
	1000: false, // X11 mouse: button press/release
	1002: false, // ... plus drag
	1003: false, // ... plus any motion
	1004: false, // focus in/out reporting
	1005: false, // UTF-8 mouse coordinates
	1006: false, // SGR mouse coordinates
	1007: false, // alternate scroll (wheel becomes arrow keys in alt screen)
	1015: false, // urxvt mouse coordinates
	1016: false, // SGR pixel mouse coordinates
	1047: false, // alternate screen buffer
	1049: false, // alternate screen buffer + saved cursor
	2004: false, // bracketed paste
}

// ansiModeDefault is the same table for the non-private modes ("\x1b[4h").
// Only these two exist in practice; everything else in that space is either
// unimplemented or not sticky.
var ansiModeDefault = map[int]bool{
	4:  false, // IRM, insert mode
	20: false, // LNM, automatic newline
}

// altScreenModes are the alternate-screen-switching modes, in the order
// Preamble emits them: entering the alt buffer clears it and (for 1049)
// saves the cursor, so it has to happen before any other state is restored
// and before the scrollback replay draws into it.
var altScreenModes = []int{1049, 1047, 47}

// charsetDesignators maps the byte after ESC that starts a charset
// designation to the G0..G3 slot it designates.
var charsetDesignators = map[byte]int{
	'(': 0, ')': 1, '*': 2, '+': 3,
	'-': 1, '.': 2, '/': 3,
}

// lockingShifts maps the byte after ESC that invokes a G-set into GL to its
// level. SI/SO (0x0F/0x0E) are the single-byte spellings of levels 0 and 1.
var lockingShifts = map[byte]int{'n': 2, 'o': 3, '~': 1, '}': 2, '|': 3}

func newModeTracker() *modeTracker {
	return &modeTracker{
		dec:             make(map[int]bool),
		ansi:            make(map[int]bool),
		modifyOtherKeys: make(map[int]string),
	}
}

// Feed advances the parser over one chunk of PTY output. Callers hold the
// session lock (see pump), which is also what makes Preamble consistent
// with the ring snapshot taken in the same critical section.
func (m *modeTracker) Feed(p []byte) {
	for _, b := range p {
		switch m.state {
		case stateGround:
			switch b {
			case 0x1b:
				m.state = stateEscape
			case 0x0e: // SO, invoke G1 into GL
				m.charsetLevel = 1
			case 0x0f: // SI, invoke G0 into GL
				m.charsetLevel = 0
			}
		case stateEscape:
			switch {
			case b == '[':
				m.state = stateCSI
				m.params = m.params[:0]
			case b == ']' || b == 'P' || b == '^' || b == '_' || b == 'X':
				m.state = stateString
			case b == '=':
				m.keypadApplication = true
				m.state = stateGround
			case b == '>':
				m.keypadApplication = false
				m.state = stateGround
			case b == 0x1b:
				// Stay in stateEscape: a second ESC restarts the sequence.
			default:
				if slot, ok := charsetDesignators[b]; ok {
					m.charsetSlot = slot
					m.params = append(m.params[:0], b)
					m.state = stateCharset
					break
				}
				if level, ok := lockingShifts[b]; ok {
					m.charsetLevel = level
				}
				m.state = stateGround
			}
		case stateCharset:
			// Intermediates (0x20-0x2f) precede the final byte that names
			// the character set; keep the whole thing so it can be re-emitted
			// verbatim rather than reconstructed.
			m.params = append(m.params, b)
			if b >= 0x30 && b <= 0x7e {
				m.charsets[m.charsetSlot] = string(m.params)
				m.state = stateGround
			} else if len(m.params) >= maxParams {
				m.state = stateGround
			}
		case stateCSI:
			switch {
			case b >= 0x40 && b <= 0x7e:
				m.finishCSI(b)
				m.state = stateGround
			case len(m.params) >= maxParams:
				m.state = stateGround
			default:
				m.params = append(m.params, b)
			}
		case stateString:
			switch b {
			case 0x07: // BEL terminates an OSC string
				m.state = stateGround
			case 0x1b:
				m.state = stateStringEsc
			}
		case stateStringEsc:
			// ESC \ (ST) ends the string; anything else was an ESC inside
			// it, so keep skipping.
			if b == '\\' {
				m.state = stateGround
			} else {
				m.state = stateString
			}
		}
	}
}

// finishCSI applies a completed CSI sequence, splitting the raw parameter
// bytes into the private-marker prefix ("?" for DEC modes, ">" for the
// key-modifier resources), the numeric parameters, and any intermediate
// bytes (DECSCUSR's space) that qualify the final byte.
func (m *modeTracker) finishCSI(final byte) {
	body := m.params
	var prefix byte
	if len(body) > 0 && body[0] >= 0x3c && body[0] <= 0x3f {
		prefix = body[0]
		body = body[1:]
	}
	var intermediates string
	for len(body) > 0 && body[len(body)-1] >= 0x20 && body[len(body)-1] <= 0x2f {
		intermediates = string(body[len(body)-1]) + intermediates
		body = body[:len(body)-1]
	}
	params := string(body)

	switch {
	case (final == 'h' || final == 'l') && intermediates == "":
		table, store := ansiModeDefault, m.ansi
		if prefix == '?' {
			table, store = decModeDefault, m.dec
		} else if prefix != 0 {
			return
		}
		m.applyModes(table, store, params, final == 'h')
	case final == 'r' && prefix == 0 && intermediates == "":
		// DECSTBM. No parameters means "reset to the full screen", which is
		// the default and so needs nothing restored.
		m.scrollRegion = params
	case final == 'q' && prefix == 0 && intermediates == " ":
		// DECSCUSR. "0" and "" both mean the terminal default.
		if params == "0" {
			params = ""
		}
		m.cursorStyle = params
	case final == 'm' && prefix == '>':
		// Key-modifier resources: "\x1b[>4;2m" sets resource 4 to 2,
		// "\x1b[>4;m" (vim's own teardown) puts it back to the default.
		resource, value, _ := strings.Cut(params, ";")
		n, err := strconv.Atoi(resource)
		if err != nil {
			return
		}
		if value == "" {
			delete(m.modifyOtherKeys, n)
		} else {
			m.modifyOtherKeys[n] = value
		}
	}
}

// applyModes records one "\x1b[...h"/"l" against the given table, keeping
// only values that differ from the terminal default.
func (m *modeTracker) applyModes(defaults map[int]bool, store map[int]bool, params string, on bool) {
	for _, field := range strings.Split(params, ";") {
		// A sub-parameter (":") never applies to these modes; take the
		// leading number and ignore the rest rather than the whole field,
		// matching how a real parser reads it.
		if i := strings.IndexByte(field, ':'); i >= 0 {
			field = field[:i]
		}
		if field == "" {
			continue
		}
		n, err := strconv.Atoi(field)
		if err != nil {
			continue
		}
		def, tracked := defaults[n]
		if !tracked {
			continue
		}
		if on == def {
			delete(store, n)
		} else {
			store[n] = on
		}
	}
}

// Preamble returns the escape sequences that put a freshly-attaching client
// into the state the session is currently in, or nil when everything is at
// its default. Written before the clear+scrollback replay (see
// writeScrollback) so the replayed drawing lands in the right buffer, with
// the right charsets, inside the right scroll region.
func (m *modeTracker) Preamble() []byte {
	var b strings.Builder

	// Alt screen first: entering it clears that buffer and saves the cursor,
	// so anything written before would be thrown away.
	written := make(map[int]bool, len(m.dec))
	for _, mode := range altScreenModes {
		if on, ok := m.dec[mode]; ok {
			writeDECMode(&b, mode, on)
			written[mode] = true
		}
	}
	// Sorted purely so the output is deterministic (tests, and a log/hex
	// dump that reads the same twice); no mode here depends on the others.
	for _, mode := range sortedKeys(m.dec) {
		if !written[mode] {
			writeDECMode(&b, mode, m.dec[mode])
		}
	}
	for _, mode := range sortedKeys(m.ansi) {
		writeMode(&b, "", mode, m.ansi[mode])
	}
	if m.keypadApplication {
		b.WriteString("\x1b=")
	}
	for _, designation := range m.charsets {
		if designation != "" {
			b.WriteString("\x1b" + designation)
		}
	}
	if m.charsetLevel != 0 {
		b.WriteString(lockingShiftSequence(m.charsetLevel))
	}
	for _, resource := range sortedKeys(m.modifyOtherKeys) {
		b.WriteString("\x1b[>" + strconv.Itoa(resource) + ";" + m.modifyOtherKeys[resource] + "m")
	}
	// The scroll region comes last of the state that affects drawing: it
	// homes the cursor as a side effect, and the clear+replay that follows
	// re-homes anyway.
	if m.scrollRegion != "" {
		b.WriteString("\x1b[" + m.scrollRegion + "r")
	}
	if m.cursorStyle != "" {
		b.WriteString("\x1b[" + m.cursorStyle + " q")
	}

	if b.Len() == 0 {
		return nil
	}
	return []byte(b.String())
}

// ResetModesSequence returns the sequences that put a terminal back to the
// default of every piece of state Preamble can restore. A client that hands
// the stream to a *real* terminal it doesn't own — `webmanager --attach`,
// whose caller is left looking at their own shell afterwards — must write
// this when it detaches, or an attach to a session running a full-screen app
// leaves that terminal in the alternate screen with mouse reporting on, a
// scroll region clamped to someone else's window size, and its box-drawing
// charset still selected. (A browser client doesn't need it: its xterm.js
// instance is torn down or term.reset() anyway.)
//
// Everything here has a well-defined terminal default to return to, which is
// why the cosmetic OSC state discussed on modeTracker is deliberately out of
// scope: there would be no correct value to restore it to.
func ResetModesSequence() []byte {
	var b strings.Builder
	// Leaving the alt screen last keeps the rest of the restore on the
	// normal screen the user is actually returned to, rather than painting
	// it into a buffer that is about to be discarded.
	for _, mode := range sortedKeys(decModeDefault) {
		if !isAltScreenMode(mode) {
			writeDECMode(&b, mode, decModeDefault[mode])
		}
	}
	for _, mode := range sortedKeys(ansiModeDefault) {
		writeMode(&b, "", mode, ansiModeDefault[mode])
	}
	b.WriteString("\x1b>")     // DECKPNM, numeric keypad
	b.WriteString("\x1b[>4;m") // key-modifier resources back to the default
	for _, designator := range []string{"(", ")", "*", "+"} {
		b.WriteString("\x1b" + designator + "B") // designate ASCII
	}
	b.WriteString("\x0f")     // SI, invoke G0 into GL
	b.WriteString("\x1b[r")   // DECSTBM, full-screen scroll region
	b.WriteString("\x1b[0 q") // DECSCUSR, terminal default cursor
	for _, mode := range altScreenModes {
		writeDECMode(&b, mode, decModeDefault[mode])
	}
	return []byte(b.String())
}

func writeDECMode(b *strings.Builder, mode int, on bool) {
	writeMode(b, "?", mode, on)
}

func writeMode(b *strings.Builder, prefix string, mode int, on bool) {
	b.WriteString("\x1b[")
	b.WriteString(prefix)
	b.WriteString(strconv.Itoa(mode))
	if on {
		b.WriteString("h")
	} else {
		b.WriteString("l")
	}
}

func lockingShiftSequence(level int) string {
	switch level {
	case 1:
		return "\x0e" // SO
	case 2:
		return "\x1bn" // LS2
	case 3:
		return "\x1bo" // LS3
	}
	return "\x0f" // SI
}

func isAltScreenMode(mode int) bool {
	for _, m := range altScreenModes {
		if m == mode {
			return true
		}
	}
	return false
}

func sortedKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}
