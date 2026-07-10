// The per-role input gate — the security boundary for guest keystrokes (spec
// §per-role input table). Every byte a guest sends over the relay is dispatched
// here; the host's own stdin is dispatched too (as role 'host') so one table
// governs everyone. gate.js decides WHERE a keystroke goes; it never performs the
// action — the wiring executes the returned effect.
//
// Two concerns live here:
//   1. dispatch(userId, role, bytes, ctx) — byte-level routing of a keypress.
//   2. classifySend / sendAllowed          — once a draft is SENT, what is it
//      (prompt vs Claude slash vs bash vs claude-share command) and may this role
//      send it? (Composing is prompter+, but only driver+ may fire /clear or !ls.)
//
// Fail closed: a y/n routes to Claude ONLY when ctx.armed is true (an 'ask'
// Notification is pending) AND the sender is driver or host. If we are not certain
// an ask is up, a lone "y"/"n" is just a character typed into a draft — even from
// the host — so a bare keystroke can never leak to Claude by accident. The host
// typing "yes, ship it" while composing must land in the draft, not answer a
// non-existent ask (spec §fail-closed: y/n is a permission answer, never a stray
// draft char).

import { atLeast } from './state.js';
import { COMMAND_NAMES } from './commands.js';

const CTRL_C = '\x03';
const ESC = '\x1b';
const SHIFT_TAB = '\x1b[Z'; // Claude cycles permission mode on Shift+Tab

/** One-time toast a viewer sees the first time their keys are swallowed. */
export const VIEWER_TOAST = "you're a viewer — ask the host for a role";

/**
 * Route one input event from a participant.
 *
 * @param {string} userId
 * @param {string} role   viewer | prompter | driver | host
 * @param {string|Buffer} bytes  raw terminal bytes for this keypress
 * @param {object} [ctx]
 * @param {boolean} [ctx.armed]      true iff a permission ask is pending (hook-armed)
 * @param {boolean} [ctx.composing]  true iff this user's caret is in a draft box
 * @param {Set<string>} [ctx.toasted] userIds already shown the viewer toast (mutated)
 * @returns {{kind:'draft', bytes:string}
 *          |{kind:'pty', data:string}
 *          |{kind:'detach'}
 *          |{kind:'toast', target:string, message:string}
 *          |{kind:'drop'}}
 */
export function dispatch(userId, role, bytes, ctx = {}) {
  const s = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const armed = !!ctx.armed;
  const toasted = ctx.toasted;

  // Ctrl+C — a guest detaches themselves; the host's is normal terminal input.
  if (s === CTRL_C) {
    return role === 'host' ? { kind: 'pty', data: s } : { kind: 'detach' };
  }

  // Mode flip (Shift+Tab) — driver and up only; silently dropped otherwise. A
  // viewer never even reaches the toast path here (mode flips aren't "typing").
  if (s === SHIFT_TAB) {
    return atLeast(role, 'driver') ? { kind: 'pty', data: s } : { kind: 'drop' };
  }

  // A lone Escape: composing → step out of the draft (window-like, handled by the
  // editor); not composing → interrupt Claude's current turn, prompter and up
  // (spec: anyone who can prompt can interrupt — now one extra Esc away while
  // composing). A longer escape sequence (arrow keys, etc.) is never an interrupt.
  if (s === ESC) {
    if (ctx.composing) return { kind: 'draft', bytes: s };
    return atLeast(role, 'prompter') ? { kind: 'pty', data: s } : viewerBlock(userId, toasted);
  }

  // y/n answering a permission ask — driver and up, and ONLY while a permission ask
  // is armed (an 'ask' Notification is pending). Fail closed: when we are not certain
  // an ask is up, a lone y/n is ordinary draft input for everyone — the host too — so
  // "yes, ship it" typed while composing is never leaked to Claude as a bare
  // keystroke (spec §fail-closed: y/n is a permission answer, not a stray draft char).
  if (/^[yn]$/i.test(s) && armed && atLeast(role, 'driver') && !ctx.composing) {
    return { kind: 'pty', data: s };
  }

  // Everything else is composing in the shared draft pad — prompter and up.
  if (atLeast(role, 'prompter')) return { kind: 'draft', bytes: s };

  // Viewer (or an unknown role): blocked, with a one-time explanatory toast.
  return viewerBlock(userId, toasted);
}

// A viewer's swallowed keystroke: toast once (if we can track it), then drop.
function viewerBlock(userId, toasted) {
  if (toasted && !toasted.has(userId)) {
    toasted.add(userId);
    return { kind: 'toast', target: userId, message: VIEWER_TOAST };
  }
  return { kind: 'drop' };
}

/**
 * Classify a SENT draft's text (spec input table rows: Claude slash-commands, the
 * `!` bash prefix, /recap & the other claude-share commands, plain prompts).
 * @param {string} text
 * @returns {{kind:'command', name:string} | {kind:'claude-slash'} | {kind:'bash'} | {kind:'prompt'}}
 */
export function classifySend(text) {
  const t = String(text);
  if (t.startsWith('/')) {
    const name = t.slice(1).split(/\s+/)[0].toLowerCase();
    if (COMMAND_NAMES.has(name)) return { kind: 'command', name };
    return { kind: 'claude-slash' };
  }
  if (t.startsWith('!')) return { kind: 'bash' };
  return { kind: 'prompt' };
}

/**
 * May `role` send a draft of this kind? Prompts are prompter+; Claude slash
 * commands and `!` bash are driver+. Command role-gating is per-command and lives
 * in commands.permitted(), so 'command' defers (returns true) here.
 * @param {'command'|'claude-slash'|'bash'|'prompt'} kind
 * @param {string} role
 * @returns {boolean}
 */
export function sendAllowed(kind, role) {
  switch (kind) {
    case 'prompt':
      return atLeast(role, 'prompter');
    case 'claude-slash':
    case 'bash':
      return atLeast(role, 'driver');
    case 'command':
      return true;
    default:
      return false;
  }
}
