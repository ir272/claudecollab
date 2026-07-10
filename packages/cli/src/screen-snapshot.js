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

export class ScreenSnapshot {
  #buf = '';
  #cap;

  /** @param {{cap?:number}} [opts] max bytes retained (default 256 KiB) */
  constructor({ cap = 1 << 18 } = {}) {
    this.#cap = Math.max(1, cap | 0);
  }

  /** Absorb one chunk of child output (a frame or partial frame). */
  push(chunk) {
    if (!chunk) return;
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // Drop everything before the last full-screen clear / alt-screen enter: the
    // screen was wiped there, so nothing prior is visible any more.
    CLEAR_RE.lastIndex = 0;
    let last = -1;
    let m;
    while ((m = CLEAR_RE.exec(this.#buf))) last = m.index;
    if (last > 0) this.#buf = this.#buf.slice(last);

    // Bound memory: keep the most recent bytes (the freshest paint).
    if (this.#buf.length > this.#cap) this.#buf = this.#buf.slice(this.#buf.length - this.#cap);
  }

  /** The bytes to replay so an attacher sees the current screen (may be ''). */
  get() {
    return this.#buf;
  }

  /** Bytes currently retained. */
  get size() {
    return this.#buf.length;
  }
}
