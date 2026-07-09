import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

import {
  HOOK_EVENTS,
  mapHookEvent,
  buildHookCommand,
  buildHookSettings,
  installHooks,
  listenHooks,
} from './hooks.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task 4 — hook injection + event listener.
//
// claude-share learns Claude's state from injected hooks, never by scraping the
// TUI (spec §agent state detection). installHooks() writes a --settings file whose
// four hooks each post their stdin JSON to a unix socket; listenHooks() serves that
// socket and maps each hook to an internal event:
//   UserPromptSubmit → busy (payload carries permission_mode)
//   Stop             → idle
//   Notification     → ask   ONLY when notification_type === 'permission_prompt'
//   PostToolUse      → tool
// ─────────────────────────────────────────────────────────────────────────────

// A short socket path under tmpdir (unix sockets have a ~104-char limit).
function tmpSock() {
  return path.join(os.tmpdir(), `csh-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

// Post one JSON message to the socket exactly the way the injected command does:
// {hook, payload} where payload is the raw JSON string Claude fed on stdin.
function post(socketPath, hook, payloadObj) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.on('connect', () => s.end(JSON.stringify({ hook, payload: JSON.stringify(payloadObj) }) + '\n'));
    s.on('error', reject);
    s.on('close', () => resolve());
  });
}

// Resolve with the payload of the next `event`, or reject on timeout.
function nextEvent(emitter, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), ms);
    emitter.once(event, (p) => {
      clearTimeout(timer);
      resolve(p);
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pure mapping ────────────────────────────────────────────────────────────

test('mapHookEvent maps the four Claude hooks to internal events', () => {
  assert.equal(mapHookEvent('UserPromptSubmit', {}), 'busy');
  assert.equal(mapHookEvent('Stop', {}), 'idle');
  assert.equal(mapHookEvent('PostToolUse', {}), 'tool');
});

test('Notification maps to "ask" ONLY for notification_type permission_prompt', () => {
  assert.equal(mapHookEvent('Notification', { notification_type: 'permission_prompt' }), 'ask');
  // Any other notification is not a permission ask — must NOT arm the gate.
  assert.equal(mapHookEvent('Notification', { notification_type: 'idle_reminder' }), null);
  assert.equal(mapHookEvent('Notification', {}), null);
  assert.equal(mapHookEvent('Notification', null), null);
});

test('unknown hooks map to null', () => {
  assert.equal(mapHookEvent('PreToolUse', {}), null);
  assert.equal(mapHookEvent('SessionStart', {}), null);
  assert.equal(mapHookEvent('', {}), null);
});

// ── settings injection ────────────────────────────────────────────────────────

test('HOOK_EVENTS lists exactly the four hooks we inject', () => {
  assert.deepEqual([...HOOK_EVENTS].sort(), ['Notification', 'PostToolUse', 'Stop', 'UserPromptSubmit']);
});

test('buildHookCommand uses node -e (not nc) and embeds the socket path', () => {
  const cmd = buildHookCommand('UserPromptSubmit', '/tmp/foo.sock');
  assert.match(cmd, /-e /);
  assert.doesNotMatch(cmd, /\bnc\b/);
  assert.ok(cmd.includes('/tmp/foo.sock'), 'command should reference the socket path');
  assert.ok(cmd.includes('UserPromptSubmit'), 'command should tag itself with the hook name');
});

test('buildHookSettings produces one command hook per event in Claude settings shape', () => {
  const s = buildHookSettings('/tmp/foo.sock');
  assert.ok(s.hooks, 'has a hooks object');
  for (const evt of HOOK_EVENTS) {
    const entry = s.hooks[evt];
    assert.ok(Array.isArray(entry) && entry.length === 1, `${evt} is a single-entry array`);
    const inner = entry[0].hooks;
    assert.ok(Array.isArray(inner) && inner.length === 1, `${evt} has one inner hook`);
    assert.equal(inner[0].type, 'command');
    assert.ok(inner[0].command.includes('/tmp/foo.sock'));
  }
});

test('installHooks writes a JSON settings file that round-trips to buildHookSettings', () => {
  const sock = '/tmp/bar.sock';
  const file = installHooks(sock);
  try {
    assert.ok(fs.existsSync(file), 'settings file exists on disk');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, buildHookSettings(sock));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// ── listener over a real socket ─────────────────────────────────────────────

test('listener emits busy on UserPromptSubmit and tracks permission_mode', async () => {
  const sock = tmpSock();
  const hooks = listenHooks(sock);
  await hooks.ready;
  try {
    const busy = nextEvent(hooks, 'busy');
    await post(sock, 'UserPromptSubmit', { permission_mode: 'acceptEdits', prompt: 'hi' });
    const payload = await busy;
    assert.equal(payload.permission_mode, 'acceptEdits');
    assert.equal(hooks.mode, 'acceptEdits');
  } finally {
    await hooks.close();
  }
});

test('mode updates as later UserPromptSubmit payloads change it', async () => {
  const sock = tmpSock();
  const hooks = listenHooks(sock);
  await hooks.ready;
  try {
    let p = nextEvent(hooks, 'busy');
    await post(sock, 'UserPromptSubmit', { permission_mode: 'default' });
    await p;
    assert.equal(hooks.mode, 'default');

    p = nextEvent(hooks, 'busy');
    await post(sock, 'UserPromptSubmit', { permission_mode: 'bypassPermissions' });
    await p;
    assert.equal(hooks.mode, 'bypassPermissions');
  } finally {
    await hooks.close();
  }
});

test('listener emits idle on Stop and tool on PostToolUse', async () => {
  const sock = tmpSock();
  const hooks = listenHooks(sock);
  await hooks.ready;
  try {
    const idle = nextEvent(hooks, 'idle');
    await post(sock, 'Stop', { session_id: 'abc' });
    await idle;

    const tool = nextEvent(hooks, 'tool');
    await post(sock, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x' } });
    const payload = await tool;
    assert.equal(payload.tool_name, 'Edit');
  } finally {
    await hooks.close();
  }
});

test('permission_prompt Notification emits ask; other notifications do not', async () => {
  const sock = tmpSock();
  const hooks = listenHooks(sock);
  await hooks.ready;
  try {
    const ask = nextEvent(hooks, 'ask');
    await post(sock, 'Notification', { notification_type: 'permission_prompt', message: 'allow?' });
    const payload = await ask;
    assert.equal(payload.notification_type, 'permission_prompt');

    // A non-permission Notification must NOT emit 'ask' (fail-closed gate).
    let fired = false;
    hooks.on('ask', () => {
      fired = true;
    });
    await post(sock, 'Notification', { notification_type: 'idle_reminder' });
    await delay(80);
    assert.equal(fired, false, 'non-permission Notification must not arm the gate');
  } finally {
    await hooks.close();
  }
});

test('malformed socket input is ignored and does not break later valid events', async () => {
  const sock = tmpSock();
  const hooks = listenHooks(sock);
  await hooks.ready;
  try {
    // Garbage line, then a valid one on a fresh connection.
    await new Promise((resolve, reject) => {
      const s = net.connect(sock);
      s.on('connect', () => s.end('this is not json\n'));
      s.on('error', reject);
      s.on('close', resolve);
    });
    const idle = nextEvent(hooks, 'idle');
    await post(sock, 'Stop', {});
    await idle; // still works
  } finally {
    await hooks.close();
  }
});

// ── the injected command really posts to the socket (end-to-end) ────────────

test('the injected node -e command posts a real hook payload to the listener', async () => {
  const sock = tmpSock();
  const hooks = listenHooks(sock);
  await hooks.ready;
  try {
    const cmd = buildHookCommand('UserPromptSubmit', sock);
    const busy = nextEvent(hooks, 'busy');
    // Run the exact command Claude would run: shell interprets it, JSON on stdin.
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(JSON.stringify({ permission_mode: 'plan', prompt: 'ship it' }));
    const payload = await busy;
    assert.equal(payload.permission_mode, 'plan');
    assert.equal(payload.prompt, 'ship it');
    assert.equal(hooks.mode, 'plan');
  } finally {
    await hooks.close();
  }
});
