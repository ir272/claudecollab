// Hook injection + event listener — how claude-share learns Claude's state.
//
// We never scrape the repainting TUI for state (spec §agent state detection).
// Instead claude-share launches Claude with a `--settings` file whose four hooks
// each POST their stdin JSON to a private unix socket, and this module serves that
// socket and maps every hook to one internal event:
//
//   Claude hook        internal event   why
//   ────────────────   ──────────────   ─────────────────────────────────────────
//   UserPromptSubmit  → 'busy'          turn started; payload carries permission_mode
//   Stop              → 'idle'          turn finished; queue may drain (fail-closed)
//   Notification      → 'ask'           ONLY when notification_type=permission_prompt
//   PostToolUse       → 'tool'          a tool ran; feeds the join context card
//
// Gate on events, not predictions (spec): Claude auto-approves harmless read-only
// bash via its own heuristics, so which command will prompt is not predictable. The
// permission gate therefore arms ONLY on the permission_prompt Notification — any
// other Notification is dropped here so it can never arm the gate.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import process from 'node:process';

/** The Claude Code hooks we inject, in the order they appear in the settings file. */
export const HOOK_EVENTS = Object.freeze(['UserPromptSubmit', 'Stop', 'Notification', 'PostToolUse']);

// Hooks with a one-to-one internal event. Notification and UserPromptSubmit are
// special-cased below.
const SIMPLE = Object.freeze({
  Stop: 'idle',
  PostToolUse: 'tool',
});

/**
 * Map a Claude hook name + its parsed payload to an internal event, or null to
 * drop it. Pure, so the whole routing table is unit-testable without a socket.
 * @param {string} hook   Claude hook name (e.g. 'UserPromptSubmit')
 * @param {object} payload parsed hook JSON (may be null)
 * @returns {'busy'|'idle'|'ask'|'tool'|null}
 */
export function mapHookEvent(hook, payload) {
  if (hook === 'Notification') {
    return payload && payload.notification_type === 'permission_prompt' ? 'ask' : null;
  }
  // A slash command (/model) or ! bash line fires UserPromptSubmit on submission
  // but resolves client-side: no turn runs, so no Stop hook ever follows. Flipping
  // busy on that edge wedges the room "brewing" forever (dogfood: /model from a
  // draft froze the queue). Drop the busy edge for those — a slash command that
  // DOES run a real turn (a skill) still flips busy at its first PostToolUse.
  // No prompt text in the payload → fail toward busy (a real turn may be starting).
  if (hook === 'UserPromptSubmit') {
    const p = payload && typeof payload.prompt === 'string' ? payload.prompt.trimStart() : '';
    return p.startsWith('/') || p.startsWith('!') ? null : 'busy';
  }
  return SIMPLE[hook] ?? null;
}

// The body of the injected `node -e` poster. It reads Claude's hook JSON from
// stdin, connects to our unix socket, and writes one line: {hook, payload} where
// payload is the raw JSON string (the listener parses it). It fails silently on
// any socket error so a relay/listener hiccup can never break a Claude hook.
//
// Constraints that keep this shell-safe:
//   • NO single quotes inside — the whole body is wrapped in single quotes for sh.
//   • argv[1] = hook name, argv[2] = socket path (passed as command args).
const POSTER = [
  'const net=require("net");',
  'let d="";',
  'process.stdin.on("data",c=>d+=c);',
  'process.stdin.on("end",()=>{',
  'const s=net.connect(process.argv[2]);',
  's.on("connect",()=>s.end(JSON.stringify({hook:process.argv[1],payload:d})+"\\n"));',
  's.on("error",()=>process.exit(0));',
  '});',
].join('');

/**
 * Build the shell command string for one injected hook. Uses `node -e` (per plan,
 * not `nc`), the current node binary (robust vs. PATH), and double-quotes the
 * node path + socket path so spaces survive the shell.
 * @param {string} hook       Claude hook name
 * @param {string} socketPath unix socket the listener serves
 * @returns {string}
 */
export function buildHookCommand(hook, socketPath) {
  return `"${process.execPath}" -e '${POSTER}' ${hook} "${socketPath}"`;
}

/**
 * Build the Claude Code `--settings` object: one command hook per event, in the
 * shape Claude expects (`{ hooks: { <Event>: [{ hooks: [{type,command}] }] } }`).
 * @param {string} socketPath
 * @returns {object}
 */
export function buildHookSettings(socketPath) {
  const hooks = {};
  for (const hook of HOOK_EVENTS) {
    hooks[hook] = [{ hooks: [{ type: 'command', command: buildHookCommand(hook, socketPath) }] }];
  }
  return { hooks };
}

/**
 * Write the settings file to a temp path and return it — pass this to Claude as
 * `--settings <file>`. Caller deletes it on teardown.
 * @param {string} socketPath
 * @returns {string} absolute path to the settings file
 */
export function installHooks(socketPath) {
  const rand = Math.random().toString(36).slice(2, 8);
  const file = path.join(os.tmpdir(), `claude-share-settings-${process.pid}-${rand}.json`);
  fs.writeFileSync(file, JSON.stringify(buildHookSettings(socketPath), null, 2));
  return file;
}

/**
 * Serves the unix socket the injected hooks post to, turning each post into an
 * internal event. Extends EventEmitter, so consumers do `.on('busy'|'idle'|'ask'|'tool', payload)`.
 * Also emits `'mode'` when the tracked permission_mode changes, and `'error'` for
 * post-listen server errors.
 */
export class HookListener extends EventEmitter {
  #server;
  #socketPath;
  #mode = null;

  /** @param {string} socketPath path to bind the unix socket at */
  constructor(socketPath) {
    super();
    this.#socketPath = socketPath;
    // A stale socket file from a crashed run would make listen() throw EADDRINUSE.
    try {
      fs.unlinkSync(socketPath);
    } catch {}

    this.#server = net.createServer((conn) => this.#onConnection(conn));

    /** Resolves once the socket is accepting connections; rejects if it can't bind. */
    this.ready = new Promise((resolve, reject) => {
      const onErr = (err) => reject(err);
      this.#server.once('error', onErr);
      this.#server.listen(socketPath, () => {
        this.#server.removeListener('error', onErr);
        this.#server.on('error', (err) => this.emit('error', err));
        resolve();
      });
    });
    // Don't crash the process if nobody awaits ready and the bind fails.
    this.ready.catch(() => {});
    // The socket must not keep the event loop alive on its own.
    if (typeof this.#server.unref === 'function') this.#server.unref();
  }

  /** The last permission_mode seen on any hook payload (null until the first hook). */
  get mode() {
    return this.#mode;
  }

  #onConnection(conn) {
    let buf = '';
    let done = false;
    conn.setEncoding('utf8');
    const finish = () => {
      if (done) return;
      done = true;
      this.#ingest(buf);
    };
    conn.on('data', (c) => {
      buf += c;
    });
    conn.on('end', finish);
    conn.on('close', finish);
    conn.on('error', () => {}); // a dropped hook connection is not our problem
  }

  #ingest(buf) {
    for (const line of buf.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // malformed line: drop it, keep serving
      }
      this.#handle(msg);
    }
  }

  #handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const hook = msg.hook;
    let payload = msg.payload;
    // The injected poster sends payload as a raw JSON string; parse it back.
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    if (!payload || typeof payload !== 'object') payload = {};

    const event = mapHookEvent(hook, payload);
    // permission_mode rides on EVERY hook payload (spec: mode tracking for free), so
    // track it from any hook — not only UserPromptSubmit. A mode flip (Shift+Tab)
    // then surfaces the moment the next hook of any kind fires (Stop, PostToolUse, a
    // permission Notification, or the next prompt), so the room's mode-change warning
    // banner is raised on the mode-change signal itself rather than waiting for the
    // next UserPromptSubmit. Update before emitting so an event handler reading .mode
    // sees the fresh value.
    if (typeof payload.permission_mode === 'string' && payload.permission_mode !== this.#mode) {
      this.#mode = payload.permission_mode;
      this.emit('mode', this.#mode);
    }
    if (event) this.emit(event, payload);
  }

  /** Stop serving and remove the socket file. */
  close() {
    return new Promise((resolve) => {
      this.#server.close(() => {
        try {
          fs.unlinkSync(this.#socketPath);
        } catch {}
        resolve();
      });
    });
  }
}

/**
 * Start serving the hook socket. `listenHooks(path).on('busy'|'idle'|'ask'|'tool', payload)`.
 * Await the returned listener's `.ready` before expecting events.
 * @param {string} socketPath
 * @returns {HookListener}
 */
export function listenHooks(socketPath) {
  return new HookListener(socketPath);
}
