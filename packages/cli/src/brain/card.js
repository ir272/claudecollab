// The join context card — a joiner's private preamble, printed once into their
// own scrollback before they attach to the live mirror (spec §join context card).
// It is assembled instantly from structured brain state (participants, mode) and
// the attributed log (recent prompts, files touched, Claude's state) — no AI, no
// latency. The wiring sends it with relay.sendTo(id, card) on admit.
//
// Layout (spec frame):
//   ┌ session so far ── 42 min ─────────────────────┐
//   │ people   ian★ james✎ · you join as siddh✎     │
//   │ mode     accept-edits                         │
//   │ recent prompts                                │
//   │   ian   → "refactor the navbar"       (32m)   │
//   │ files    src/Nav.tsx · src/auth.test.ts · +3  │
//   │ claude   ✻ brewing — on ian's last prompt     │
//   └───────────────────────────────────────────────┘
//   ── you're live ──

import { ROLE_GLYPH, stringWidth, truncateToWidth } from '../renderer.js';

// Keep the box comfortably inside an 80-col floor: content ≤ 74 ⇒ box ≤ 78.
const MAX_INNER = 74;

const CLAUDE_DESC = Object.freeze({
  busy: '✻ brewing',
  idle: '● idle',
  ask: '⚠ permission ask pending',
});

// Relative minutes, coarsened to hours past 60m ("32m", "2h").
function relAgo(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

const glyph = (role) => ROLE_GLYPH[role] ?? '';

// Pad a plain string to a visible width (truncating first if it's too wide).
function padTo(str, width) {
  const t = truncateToWidth(str, width);
  return t + ' '.repeat(Math.max(0, width - stringWidth(t)));
}

/**
 * Build the join context card as a multi-line string.
 * @param {import('./state.js').RoomState} state
 * @param {import('./log.js').Log} log
 * @param {object} opts
 * @param {string} opts.joinerId          the arriving participant's id
 * @param {() => number} [opts.now]       clock (defaults to Date.now)
 * @param {'busy'|'idle'|'ask'} [opts.claudeState]  Claude's current state
 * @param {number} [opts.maxPrompts=3]    recent prompts to show
 * @param {number} [opts.maxFiles=3]      files to show before "+N"
 * @returns {string}
 */
export function build(state, log, {
  joinerId,
  now = () => Date.now(),
  claudeState = 'idle',
  maxPrompts = 3,
  maxFiles = 3,
} = {}) {
  const ageMin = Math.round((now() - state.startedAt) / 60000);
  const joiner = state.get(joinerId);
  const others = state.list().filter((p) => p.id !== joinerId);

  const peopleStr = others.map((p) => `${p.name}${glyph(p.role)}`).join(' ');
  const joinStr = joiner ? `you join as ${joiner.name}${glyph(joiner.role)}` : '';

  const rows = [];
  rows.push(`people   ${peopleStr}${joinStr ? ` · ${joinStr}` : ''}`);
  rows.push(`mode     ${state.mode}`);
  rows.push('recent prompts');
  const recent = log.recentPrompts(maxPrompts);
  if (recent.length === 0) {
    rows.push('  (none yet)');
  } else {
    for (const p of recent) rows.push(`  ${p.author} → "${p.text}" (${relAgo(now() - p.at)})`);
  }
  const files = log.files;
  const shown = files.slice(0, maxFiles);
  const overflow = files.length - shown.length;
  const filesStr = files.length
    ? shown.join(' · ') + (overflow > 0 ? ` · +${overflow}` : '')
    : '(none)';
  rows.push(`files    ${filesStr}`);
  const lastAuthor = log.lastPromptAuthor();
  const cdesc = CLAUDE_DESC[claudeState] ?? claudeState;
  rows.push(`claude   ${cdesc}${lastAuthor ? ` — on ${lastAuthor}'s last prompt` : ''}`);

  const title = `session so far ── ${ageMin} min`;
  const innerWidth = Math.min(MAX_INNER, Math.max(stringWidth(title) + 2, ...rows.map(stringWidth)));

  const titleTrunc = truncateToWidth(title, innerWidth);
  const dashes = Math.max(0, innerWidth - stringWidth(titleTrunc));

  const out = [];
  out.push(`┌ ${titleTrunc} ${'─'.repeat(dashes)}┐`);
  for (const r of rows) out.push(`│ ${padTo(r, innerWidth)} │`);
  out.push(`└${'─'.repeat(innerWidth + 2)}┘`);
  out.push("── you're live ──");
  return out.join('\n');
}
