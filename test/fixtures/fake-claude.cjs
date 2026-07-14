#!/usr/bin/env node
// fake-claude — a stand-in for `claude` used by the e2e smoke test. Real Claude
// Code is not available in CI, so this stub mimics the two things claude-share's
// host brain actually depends on (spec §agent-state-detection):
//
//   1. it echoes the prompts fed to it on stdin, so guests see live output;
//   2. it fires the lifecycle hooks from its own `--settings` file — exactly the
//      commands claude-share injected — so the brain's state detection (busy /
//      idle / ask) is driven by real hook events over the real unix socket, not
//      by scraping the screen.
//
// It is deterministic and marker-driven:
//   • a prompt containing "[ask]" → UserPromptSubmit (busy), a PostToolUse, then a
//     permission_prompt Notification (arms the gate); it stays pending until a y/n
//     answer arrives, then fires Stop (idle).
//   • a lone y / n while pending  → resolves the ask → Stop (idle).
//   • any other prompt            → UserPromptSubmit (busy) → Stop (idle).
//
// Hooks are fired STRICTLY IN ORDER (each injected command runs to completion,
// delivering its payload, before the next fires) so busy can never land after the
// ask it precedes. Output is wrapped in synchronized-update frame markers
// (?2026h/?2026l) like Claude v2, exercising claude-share's frame-splitter.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// A JSONL session transcript, exactly like the one real Claude Code writes and
// hands its hooks via `transcript_path`. claude-share reads this at the Stop edge
// to pair each turn with Claude's response (never scraped from the TUI), so the
// stub must produce one for that path to be exercised end to end.
const transcriptPath = path.join(os.tmpdir(), `fake-claude-transcript-${process.pid}.jsonl`);
function tScribe(type, text) {
  try {
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ type, message: { role: type, content: [{ type: 'text', text }] } }) + '\n',
    );
  } catch {
    /* best-effort: a transcript write hiccup must never break the stub */
  }
}

// ── locate --settings and load the injected hook commands ────────────────────
const argv = process.argv.slice(2);

// Headless one-shot (`claude -p "<prompt>"`) — claude-share's /recap runs this over
// the attributed log. Print a deterministic summary and exit, so the recap path is
// exercised end to end without real Claude.
if (argv.includes('-p')) {
  process.stdout.write('session recap: the room refactored the navbar and moved the layout to tailwind.\n');
  process.exit(0);
}

let settingsPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--settings') settingsPath = argv[i + 1];
}
let hooks = {};
try {
  hooks = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks || {};
} catch {
  /* no settings / unreadable → run without firing hooks (state detection off) */
}

// Fire every command configured for a Claude hook, feeding it the payload JSON on
// stdin (exactly as Claude would). Resolves only once all have fully run, so a
// caller can `await` to guarantee ordering between hooks.
function fire(hookName, payload) {
  return new Promise((resolve) => {
    const cmds = [];
    for (const group of hooks[hookName] || []) {
      for (const h of group.hooks || []) {
        if (h.type === 'command' && h.command) cmds.push(h.command);
      }
    }
    if (cmds.length === 0) return resolve();
    let remaining = cmds.length;
    const done = () => {
      if (--remaining === 0) resolve();
    };
    for (const command of cmds) {
      const p = spawn('sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('close', done);
      p.on('error', done);
      p.stdin.on('error', () => {});
      p.stdin.end(JSON.stringify(payload || {}));
    }
  });
}

// ── output (frame-wrapped so claude-share splits on the ?2026l boundary) ──────
const FRAME_BEGIN = '\x1b[?2026h';
const FRAME_END = '\x1b[?2026l';
function say(text) {
  process.stdout.write(FRAME_BEGIN + text + '\r\n' + FRAME_END);
}

say('fake-claude ready');

// ── stdin: a TUI runs its pty in raw mode, so single bytes (a lone y) arrive
// immediately and there is no line-discipline echo. Mirror that.
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding('utf8');
process.stdin.resume();

let pendingAsk = false;
let buf = '';
let chain = Promise.resolve(); // serialize processing so hooks never interleave

process.stdin.on('data', (chunk) => {
  buf += chunk;
  // Drain every complete line (terminated by \r or \n).
  let idx;
  while ((idx = buf.search(/[\r\n]/)) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line !== '') enqueue(() => processInput(line));
  }
  // A permission answer is a lone y/n with no newline.
  if (pendingAsk && /^[yn]$/i.test(buf)) {
    const ans = buf;
    buf = '';
    enqueue(() => processAnswer(ans));
  }
});

function enqueue(step) {
  chain = chain.then(step).catch(() => {});
}

async function processInput(line) {
  if (pendingAsk && /^[yn]$/i.test(line)) return processAnswer(line);
  tScribe('user', line);
  await fire('UserPromptSubmit', { permission_mode: 'default', prompt: line });
  say(`[claude] prompt: ${line}`);
  if (line.includes('[ask]')) {
    await fire('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } });
    await fire('Notification', { notification_type: 'permission_prompt', message: 'allow Edit?' });
    say('[claude] permission needed: allow Edit? (y/n)');
    pendingAsk = true;
  } else {
    tScribe('assistant', `Done — handled: ${line}`);
    await fire('Stop', { transcript_path: transcriptPath });
    say('[claude] done');
  }
}

async function processAnswer(ans) {
  pendingAsk = false;
  const granted = /y/i.test(ans);
  say(`[claude] permission ${granted ? 'granted' : 'denied'}`);
  tScribe('assistant', granted ? 'Permission granted — change applied.' : 'Permission denied — no change made.');
  await fire('Stop', { transcript_path: transcriptPath });
  say('[claude] done');
}

// A closed stdin (parent gone) means we're done.
process.stdin.on('end', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
