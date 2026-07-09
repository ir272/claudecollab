// The band renderer — the bottom N rows painted *under* Claude's full-screen TUI.
//
// Claude runs in a PTY that is `bandRows` shorter than the real terminal (see
// pty.js), so its absolute cursor addressing can never touch the reserved rows.
// paint() draws only those rows: it saves the cursor (DECSC), positions to each
// band row, clears it, writes content, and restores the cursor (DECRC) — exactly
// the tmux-status-bar technique proven in spike/wrap.py.
//
// paint() is a pure function of state: same state in, same ANSI string out. That
// keeps it golden-file testable and lets the caller redraw on Claude's own
// ?2026l frame boundaries without any hidden state. For v1 (Task 3) the dynamic
// region is a placeholder; Task 7 swaps in real draft boxes / queue / prompts.

// ── ANSI vocabulary ───────────────────────────────────────────────────────────
const SAVE = '\x1b7'; // DECSC — save cursor position
const RESTORE = '\x1b8'; // DECRC — restore cursor position
const CLEAR_LINE = '\x1b[2K'; // erase entire line
const RESET = '\x1b[0m';
const ORANGE = '\x1b[38;5;214m'; // status line (matches spike band)
const DIM = '\x1b[38;5;245m'; // placeholder / secondary text
const posLine = (row) => `\x1b[${row};1H`; // move to column 1 of `row`

// Role → status-line glyph (spec §roles: viewer 👁, prompter ✎, driver ⚑, host ★).
export const ROLE_GLYPH = Object.freeze({
  host: '★',
  driver: '⚑',
  prompter: '✎',
  viewer: '👁',
});

// ── display-width helpers ─────────────────────────────────────────────────────
// A terminal cannot count JS UTF-16 code units; it counts cells. These helpers
// let us truncate band content so it can never wrap into Claude's rows. Width
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

// ── band lines ─────────────────────────────────────────────────────────────────

const color = (sgr, plain, width) =>
  width <= 0 ? '' : sgr + truncateToWidth(plain, width) + RESET;

/**
 * The room status line: `─ <room|claude-share> · <participants|solo> · mode: <mode> ─`.
 * @param {object} state
 * @param {number} width  column budget (real terminal cols)
 * @returns {string} colored, width-clamped line
 */
export function statusLine(state = {}, width = 80) {
  const room = state.room || 'claude-share';
  const parts = state.participants ?? [];
  const who = parts.length
    ? parts.map((p) => `${p.name}${ROLE_GLYPH[p.role] ?? ''}`).join(' ')
    : 'solo';
  const mode = state.mode ?? 'default';
  const plain = `─ ${room} · ${who} · mode: ${mode} ─`;
  return color(ORANGE, plain, width);
}

// The dynamic region below the status line. Placeholder for v1; Task 7 replaces
// this with draft boxes / queue / knock+admit prompts.
function placeholderLine(state = {}, width = 80) {
  const plain = state.status ?? 'drafts · queue · prompts render here';
  return color(DIM, plain, width);
}

/**
 * Build exactly `bandRows` content strings (top = status line, then the dynamic
 * region, then blanks). Each is already width-clamped to `cols`.
 */
function bandLines(state, cols, bandRows) {
  const lines = [statusLine(state, cols)];
  for (let i = 1; i < bandRows; i++) {
    lines.push(i === 1 ? placeholderLine(state, cols) : '');
  }
  return lines;
}

/**
 * Render the band region as a single ANSI string, positioned at the bottom
 * `bandRows` rows of a `cols`×`rows` terminal. Cursor is saved before and
 * restored after so Claude's own cursor is never disturbed.
 *
 * @param {object} state
 * @param {number} [state.cols=80]      real terminal columns
 * @param {number} [state.rows=24]      real terminal rows
 * @param {number} [state.bandRows=2]   reserved bottom rows
 * @param {string|null} [state.room]    room code (null = solo / not yet assigned)
 * @param {{name:string,role:string}[]} [state.participants]
 * @param {string} [state.mode]         Claude permission mode
 * @param {string} [state.status]       placeholder text for the dynamic region
 * @returns {string} ANSI for the band only (empty string if bandRows <= 0)
 */
export function paint(state = {}) {
  const cols = state.cols ?? 80;
  const rows = state.rows ?? 24;
  const bandRows = state.bandRows ?? 2;
  if (bandRows <= 0) return '';

  const top = Math.max(1, rows - bandRows + 1);
  const lines = bandLines(state, cols, bandRows);

  let out = SAVE;
  for (let i = 0; i < bandRows; i++) {
    out += posLine(top + i) + CLEAR_LINE + (lines[i] ?? '');
  }
  out += RESTORE;
  return out;
}
