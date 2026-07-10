// A rolling snapshot of the child's current screen, so a guest admitted mid-session
// sees the LIVE screen immediately — not blank space until the next frame (spec
// §renderer: "there is exactly one live screen, mirrored to everyone"; dogfood
// finding: a guest admitted while Claude was idle saw the context card, then nothing).
//
// We deliberately don't emulate a terminal (deps are ssh2 + node-pty only). Instead
// we retain the bytes the child has emitted SINCE it last cleared the screen:
//
//   • an alternate-screen TUI (Claude v2) enters `?1049h`, then repaints with
//     absolute cursor positioning — replaying the bytes since that enter/last clear
//     reconstructs the current screen for a fresh attacher;
//   • a line app (`cat`) never clears, so the buffer is simply the echoed content.
//
// A byte cap bounds memory; on overflow we keep the tail (the most recent, most
// relevant paint). The host replays get() to a joiner right after the context card.

// Sequences that wipe the whole screen (so earlier bytes no longer matter):
//   \x1b[2J  clear entire screen      \x1b[3J  clear screen + scrollback
//   \x1bc    full reset (RIS)         \x1b[?1049h  enter alternate screen
const CLEAR_RE = /\x1b\[2J|\x1b\[3J|\x1bc|\x1b\[\?1049h/g;

// A synchronized-update frame ends here (Claude v2). We trim the memory cap at a
// frame boundary when we can, so a joiner's replay never starts mid-repaint.
const SU_END = '\x1b[?2026l';

// Cursor visibility (DECTCEM) is a STICKY mode set once on a state change, not
// re-asserted per frame — so the establishing ?25h often lives in a frame the
// clear-reset or cap-trim has already dropped, and a joiner replaying the window
// resolves to cursor-hidden while everyone who watched live shows it. We track the
// effective state across ALL pushed bytes and re-assert it at the end of get().
const CURSOR_SHOW = '\x1b[?25h';
const CURSOR_HIDE = '\x1b[?25l';

// A COMPLETE escape sequence: CSI (ESC [ … final), OSC (ESC ] … BEL/ST), or a
// 2-byte ESC form (ESC 7 / ESC 8). Used to find spans so a cut never lands in the
// middle of one, and to decide whether a trailing ESC… is finished (finding 2).
const ESC_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[78]/g;
const ESC_SEQ_AT_START = /^(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[78])/;

// The smallest index >= min at which slicing leaves a CLEAN start — never inside an
// escape sequence, so a joiner's terminal never renders a fragment (";246m…") as
// literal text. If min sits inside a sequence we jump to that sequence's end; in
// plain text any index is safe, so min itself is returned.
function safeStart(buf, min) {
  if (min <= 0) return 0;
  ESC_SEQ.lastIndex = 0;
  let m;
  while ((m = ESC_SEQ.exec(buf)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (end <= min) continue; // span entirely before min → irrelevant
    if (start >= min) return min; // min is in clean text before the next span
    return end; // min is inside this span → jump past it
  }
  return min; // no span covers min → plain text
}

// Drop a DANGLING trailing escape (a "\x1b[38;5" with no final byte, or a bare ESC)
// so the replay never ends mid-sequence and eat the live frames that follow it. A
// completed sequence — even with trailing text — is kept whole.
function dropTrailingPartial(s) {
  const esc = s.lastIndexOf('\x1b');
  if (esc === -1) return s; // no escape at all
  if (ESC_SEQ_AT_START.test(s.slice(esc))) return s; // last ESC starts a complete seq
  return s.slice(0, esc); // dangling partial → cut it off
}

export class ScreenSnapshot {
  #buf = '';
  #cap;
  #cursorShown = true; // terminals start with a visible cursor

  /** @param {{cap?:number}} [opts] max bytes retained (default 256 KiB) */
  constructor({ cap = 1 << 18 } = {}) {
    this.#cap = Math.max(1, cap | 0);
  }

  /** Absorb one chunk of child output (a frame or partial frame). */
  push(chunk) {
    if (!chunk) return;
    const prevLen = this.#buf.length;
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // Track effective cursor visibility over the appended bytes. Scan a window
    // reaching a few bytes back so a sequence split across chunks still counts.
    const win = this.#buf.slice(Math.max(0, prevLen - 8));
    const show = win.lastIndexOf(CURSOR_SHOW);
    const hide = win.lastIndexOf(CURSOR_HIDE);
    if (show !== -1 || hide !== -1) this.#cursorShown = show > hide;

    // Drop everything before the last full-screen clear / alt-screen enter: the
    // screen was wiped there, so nothing prior is visible any more. The cut lands ON
    // the clear escape, so the retained buffer starts at a clean boundary.
    CLEAR_RE.lastIndex = 0;
    let last = -1;
    let m;
    while ((m = CLEAR_RE.exec(this.#buf))) last = m.index;
    if (last > 0) this.#buf = this.#buf.slice(last);

    this.#trim();
  }

  // Bound memory to the cap, cutting only at a CLEAN boundary — never mid escape
  // sequence (finding 2). Prefer a frame boundary (right after an SU_END): the
  // smallest such cut whose tail fits the cap, dropping whole older frames. When no
  // frame boundary fits (a line app with no markers), fall back to the smallest
  // escape-safe index so the retained tail can never begin inside a sequence.
  #trim() {
    if (this.#buf.length <= this.#cap) return;
    const target = this.#buf.length - this.#cap;
    let cut = -1;
    let idx = this.#buf.indexOf(SU_END);
    while (idx !== -1) {
      const after = idx + SU_END.length;
      if (this.#buf.length - after <= this.#cap) {
        cut = after;
        break;
      }
      idx = this.#buf.indexOf(SU_END, after);
    }
    if (cut === -1) cut = safeStart(this.#buf, target);
    this.#buf = this.#buf.slice(cut);
  }

  /** The bytes to replay so an attacher sees the current screen (may be ''). */
  get() {
    const out = dropTrailingPartial(this.#buf);
    if (!out) return out;
    // Re-assert the effective cursor visibility: the sticky ?25h/?25l that set it
    // may have been trimmed out of the window above (a joiner during a busy spell
    // otherwise lands cursor-hidden while the host's terminal shows it).
    return out + (this.#cursorShown ? CURSOR_SHOW : CURSOR_HIDE);
  }

  /** Bytes currently retained. */
  get size() {
    return this.#buf.length;
  }
}
