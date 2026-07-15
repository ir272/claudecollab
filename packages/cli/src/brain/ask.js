// What Claude is asking permission for — the context the browser's ask card shows.
//
// The permission gate arms on a `Notification` hook (notification_type ===
// 'permission_prompt'); that payload carries only a human `message` string (real
// Claude: "Claude needs your permission to use Bash"), never the tool's structured
// input. The concrete input (a command, a file path) is only known if a `tool`
// (PostToolUse) hook fired earlier in the SAME turn — the fake-claude fixture fires
// one, real Claude may not (there is no PreToolUse hook injected). So we take the
// best available: the last tool's name + input summary when we have it, otherwise
// the Notification message.
//
// Whatever we surface leaks no more than the host's own log already shows: it is
// stripControls'd and clamped, so a crafted tool input can never smuggle escape
// sequences or a wall of text into every guest's screen.

import { stripControls } from './log.js';

/** Max length of the ask summary shown on the card (spec: a short input summary). */
export const ASK_SUMMARY_MAX = 120;
const TOOL_MAX = 40;

// Input fields worth showing, most-useful first. A tool's summary is the first of
// these that is a non-empty string (a command, an edited file, a search pattern…).
const SUMMARY_FIELDS = ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'prompt', 'url', 'description'];

/**
 * Pull a short, safe summary string out of a tool's input object.
 * @param {object} [toolInput]
 * @returns {string}
 */
export function summarizeToolInput(toolInput) {
  const inp = toolInput && typeof toolInput === 'object' ? toolInput : {};
  for (const key of SUMMARY_FIELDS) {
    if (typeof inp[key] === 'string' && inp[key].trim() !== '') return inp[key];
  }
  return '';
}

// Collapse whitespace runs (newlines/tabs survive stripControls) to single spaces so
// the summary is one clean line, then strip controls and clamp.
function clean(s, max) {
  return stripControls(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Best-effort tool name out of a permission message: "…use Bash", "allow Edit?".
function toolFromMessage(msg) {
  const m = /\b(?:use|allow|run|permission (?:to use|for))\s+([A-Za-z][A-Za-z0-9_]*)/i.exec(String(msg ?? ''));
  return m ? m[1] : '';
}

/**
 * Build the ask context for the state snapshot from the arming Notification payload
 * and the last tool seen this turn (either may be absent).
 * @param {object} [payload]  the 'ask' (Notification) hook payload
 * @param {{name?:string, summary?:string}|null} [lastTool]  last PostToolUse this turn
 * @returns {{tool:string, summary:string}}
 */
export function askContext(payload, lastTool) {
  const msg = payload && typeof payload.message === 'string' ? payload.message : '';
  const tool = (lastTool && lastTool.name) || toolFromMessage(msg) || 'tool';
  // Prefer the concrete tool input we saw; else the Notification's human message.
  const rawSummary = (lastTool && lastTool.summary) || msg || '';
  return { tool: clean(tool, TOOL_MAX), summary: clean(rawSummary, ASK_SUMMARY_MAX) };
}
