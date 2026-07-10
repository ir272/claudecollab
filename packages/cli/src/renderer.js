// The band renderer — the SINGLE status line painted under Claude's full-screen TUI.
//
// Post-dogfood verdict (design v2): the host terminal is the engine room — plain,
// native Claude, exactly as solo. The multiplayer band is dead; the browser is the
// one multiplayer surface for everyone, host included. All the terminal shows is one
// status line, pinned to the very bottom row:
//
//   ─ <room> · <n> people · <claude-state> · <room URL> ─
//
// Claude runs in a PTY one row shorter than the real terminal (see pty.js), so its
// absolute cursor addressing can never touch that bottom row. paint() draws only the
// band row(s): it saves the cursor (DECSC), positions + clears each row, writes the
// status line on the last one, and restores the cursor (DECRC) — the tmux status-bar
// technique. paint() is a pure function of state (same state in, same ANSI out), so
// it stays golden-file testable.

// ── ANSI vocabulary ───────────────────────────────────────────────────────────
const SAVE = '\x1b7'; // DECSC — save cursor position
const RESTORE = '\x1b8'; // DECRC — restore cursor position
const CLEAR_LINE = '\x1b[2K'; // erase entire line
const RESET = '\x1b[0m';
const ORANGE = '\x1b[38;5;214m'; // status line (matches spike band)
const posLine = (row) => `\x1b[${row};1H`; // move to column 1 of `row`

// Role → status-line glyph (spec §roles: viewer 👁, prompter ✎, driver ⚑, host ★).
// Still exported for the join context card (brain/card.js) and event toasts.
export const ROLE_GLYPH = Object.freeze({
  host: '★',
  driver: '⚑',
  prompter: '✎',
  viewer: '👁',
});

// ── display-width helpers ─────────────────────────────────────────────────────
// A terminal cannot count JS UTF-16 code units; it counts cells. These helpers
// let us truncate the status line so it can never wrap into Claude's rows. Width
// follows the wcwidth convention: combining marks 0, East-Asian-wide + emoji 2,
// ambiguous 1. Load-bearing for the "no overflow" invariant, not cosmetics.

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[78]/g;

/** Remove CSI/OSC/DECSC-DECRC escape sequences (they occupy zero cells). */
export function stripAnsi(str) {
  return String(str).replace(ANSI_RE, '');
}

const inRanges = (cp, ranges) => {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
};

const ZERO_WIDTH = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x200b, 0x200f], // zero-width space/joiner + bidi marks
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
];

const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a],
  [0x2e80, 0x303e], // CJK radicals … punctuation
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff], // emoji & pictographs
  [0x20000, 0x3fffd], // CJK extension planes
];

function cellWidth(cp) {
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** Visible column width of a string, ignoring ANSI escapes. */
export function stringWidth(str) {
  let w = 0;
  for (const ch of stripAnsi(str)) w += cellWidth(ch.codePointAt(0));
  return w;
}

/**
 * Truncate PLAIN text (no embedded ANSI) to at most `max` visible cells, never
 * splitting a wide character across the boundary.
 */
export function truncateToWidth(str, max) {
  if (max <= 0) return '';
  let w = 0;
  let out = '';
  for (const ch of String(str)) {
    const cw = cellWidth(ch.codePointAt(0));
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out;
}

// ── the status line ─────────────────────────────────────────────────────────────

const color = (sgr, plain, width) => (width <= 0 ? '' : sgr + truncateToWidth(plain, width) + RESET);

/**
 * The one and only band line: `─ <room> · <n> people · <claude-state> · <room URL> ─`.
 * Missing pieces are simply dropped (no room URL when solo, no count when unknown);
 * the whole line is width-clamped so it can never wrap into Claude's rows. Transient
 * messages (toasts, pause, event notices) are folded into the claude-state slot by
 * the caller — the band is one line and never grows.
 *
 * @param {object} state
 * @param {string|null} [state.room]        room code (null ⇒ "claude-share")
 * @param {number} [state.people]           participant count
 * @param {string} [state.claudeState]      Claude's state / a folded-in toast
 * @param {string|null} [state.url]         the room URL to print (null when solo)
 * @param {number} [width=80]               column budget
 * @returns {string} colored, width-clamped line
 */
export function statusLine(state = {}, width = 80) {
  const room = state.room || 'claude-share';
  const parts = [room];
  const n = state.people;
  if (Number.isFinite(n)) parts.push(`${n} ${n === 1 ? 'person' : 'people'}`);
  if (state.claudeState) parts.push(String(state.claudeState));
  if (state.url) parts.push(String(state.url));
  return color(ORANGE, `─ ${parts.join(' · ')} ─`, width);
}

/**
 * Render the band as a single ANSI string, positioned at the bottom `bandRows` rows
 * of a `cols`×`rows` terminal. The status line sits on the band's LAST row (the
 * terminal's very bottom); any rows above it in the band are cleared blank. The
 * cursor is saved before and restored after so Claude's own cursor is never
 * disturbed. In practice bandRows is 1 (the band is permanently one line).
 *
 * @param {object} state       see {@link statusLine} plus:
 * @param {number} [state.cols=80]     real (clamped) terminal columns
 * @param {number} [state.rows=24]     real (clamped) terminal rows
 * @param {number} [state.bandRows=1]  reserved bottom rows
 * @returns {string} ANSI for the band only (empty string if bandRows <= 0)
 */
export function paint(state = {}) {
  const cols = state.cols ?? 80;
  const rows = state.rows ?? 24;
  const bandRows = state.bandRows ?? 1;
  if (bandRows <= 0) return '';

  const top = Math.max(1, rows - bandRows + 1);
  let out = SAVE;
  for (let i = 0; i < bandRows; i++) {
    const content = i === bandRows - 1 ? statusLine(state, cols) : '';
    out += posLine(top + i) + CLEAR_LINE + content;
  }
  out += RESTORE;
  return out;
}
