// claude-share commands — the `/…` verbs the host (and, for /recap, prompters)
// type into a draft and send (spec §host controls, §per-role input table). This
// module is pure: it PARSES a sent draft into a command descriptor and answers
// "is this role allowed to run it?". The wiring in bin/claude-share.js performs
// the side effects (mutating RoomState, telling the relay to drop/ban a guest,
// spawning `claude -p` for /recap, running the two-step /end confirmation).
//
// It deliberately does NOT own Claude's own slash commands (/clear, /model, …)
// or the `!` bash prefix — those are Claude's, gated by gate.js and forwarded to
// the PTY. COMMAND_NAMES is the single list gate.classifySend consults to tell a
// claude-share command apart from a Claude slash command.

import { atLeast } from './state.js';

/** The claude-share command verbs (without the leading slash). */
export const COMMAND_NAMES = new Set(['role', 'kick', 'pause', 'resume', 'recap', 'end']);

/** Roles /role can assign (never host — the host seat is fixed). */
const ASSIGNABLE_ROLES = new Set(['driver', 'prompter', 'viewer']);
const ROLE_USAGE = 'usage: /role @name driver|prompter|viewer';
const KICK_USAGE = 'usage: /kick @name';

// Pull the bare name out of an @mention token (`@siddh` → `siddh`). A leading @
// is optional so `/kick bob` also works. Returns null for anything unnameable.
function parseMention(token) {
  if (!token) return null;
  const m = String(token).match(/^@?([\p{L}\p{N}_-]+)$/u);
  return m ? m[1] : null;
}

/**
 * Parse a sent draft into a claude-share command descriptor.
 * @param {string} text the sent draft text
 * @returns {null | {name:string, mention?:string, role?:string, error?:string}}
 *   null if it is not one of our commands; otherwise `{name, …args}` or
 *   `{name, error}` when the arguments don't parse.
 */
export function parse(text) {
  const t = String(text).trim();
  if (!t.startsWith('/')) return null;
  const parts = t.slice(1).split(/\s+/).filter(Boolean);
  const name = (parts[0] ?? '').toLowerCase();
  if (!COMMAND_NAMES.has(name)) return null;

  switch (name) {
    case 'role': {
      const mention = parseMention(parts[1]);
      const role = (parts[2] ?? '').toLowerCase();
      if (!mention || !ASSIGNABLE_ROLES.has(role)) return { name, error: ROLE_USAGE };
      return { name, mention, role };
    }
    case 'kick': {
      const mention = parseMention(parts[1]);
      if (!mention) return { name, error: KICK_USAGE };
      return { name, mention };
    }
    default:
      // pause | resume | recap | end — no arguments
      return { name };
  }
}

/**
 * Is `role` allowed to run command `name`? (spec §per-role input table)
 *   • /recap                              → prompter and up
 *   • /role /kick /pause /resume /end      → host only
 * @param {string} name
 * @param {string} role
 * @returns {boolean}
 */
export function permitted(name, role) {
  switch (name) {
    case 'recap':
      return atLeast(role, 'prompter');
    case 'role':
    case 'kick':
    case 'pause':
    case 'resume':
    case 'end':
      return atLeast(role, 'host');
    default:
      return false;
  }
}

/**
 * Resolve an @mention to a participant id via room state (case-insensitive name
 * match). The @-autocomplete makes typos unlikely, but names are still claimed by
 * guests, so a miss returns null and the wiring reports "no one called <name>".
 * @param {import('./state.js').RoomState} state
 * @param {string} mention  bare name (no @)
 * @returns {string|null} participant id
 */
export function resolveMention(state, mention) {
  if (!mention) return null;
  const want = String(mention).toLowerCase();
  for (const p of state.list()) {
    if (p.name && p.name.toLowerCase() === want) return p.id;
  }
  return null;
}
