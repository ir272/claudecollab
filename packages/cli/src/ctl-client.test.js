// `collab go|off|status` client — driven against a real stub control socket in a
// tmpdir, via the testable runCtl core (returns an exit code, writes to injected
// out/err — no process.exit). Proves the flag mapping, the human-readable output,
// the failure/exit-code contract, and the "not inside a collab session" guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCtl } from './ctl.js';
import { runCtl } from './ctl-client.js';

// Start a stub ctl server; resolve once a probe connects (listen callback ran).
function serve(t, handlers) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-ctlc-'));
  const sockPath = join(dir, 'ctl.sock');
  const ctl = startCtl({ path: sockPath, handlers });
  t.after(() => {
    ctl.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return new Promise((resolve) => {
    const probe = () => {
      const c = net.connect(sockPath);
      c.on('connect', () => {
        c.end();
        resolve(sockPath);
      });
      c.on('error', () => setTimeout(probe, 10));
    };
    probe();
  });
}

// Run runCtl with string collectors for out/err.
async function run(sub, { args = [], env } = {}) {
  let out = '';
  let err = '';
  const code = await runCtl({ sub, args, env, out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

test('go prints room + invite and exits 0', async (t) => {
  const sock = await serve(t, {
    go: async () => ({ ok: true, room: 'brave-otter', inviteUrl: 'https://claudecollab.org/brave-otter' }),
  });
  const r = await run('go', { env: { CLAUDE_SHARE_CTL: sock } });
  assert.equal(r.code, 0);
  assert.match(r.out, /live — room brave-otter/);
  assert.match(r.out, /invite: https:\/\/claudecollab\.org\/brave-otter/);
  assert.equal(r.err, '');
});

test('go maps --guests / --max-guests / --room-password to the request', async (t) => {
  let seen = null;
  const sock = await serve(t, {
    go: async (req) => {
      seen = req;
      return { ok: true, room: 'x', inviteUrl: 'https://x/x' };
    },
  });
  const r = await run('go', {
    args: ['--guests', 'viewer', '--max-guests', '3', '--room-password', 'sekret'],
    env: { CLAUDE_SHARE_CTL: sock },
  });
  assert.equal(r.code, 0);
  assert.equal(seen.v, 1, 'the request is versioned');
  assert.equal(seen.guests, 'viewer');
  assert.equal(seen.max, 3);
  assert.equal(seen.pass, 'sekret');
});

test('a handler error goes to stderr and exits 1', async (t) => {
  const sock = await serve(t, { go: async () => ({ ok: false, error: 'relay timeout' }) });
  const r = await run('go', { env: { CLAUDE_SHARE_CTL: sock } });
  assert.equal(r.code, 1);
  assert.match(r.err, /relay timeout/);
  assert.equal(r.out, '');
});

test('no CLAUDE_SHARE_CTL → friendly hint, exit 2', async () => {
  const r = await run('status', { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.err, /not inside a collab session/);
  assert.equal(r.out, '');
});

test('off prints a stop line and exits 0', async (t) => {
  const sock = await serve(t, { off: async () => ({ ok: true }) });
  const r = await run('off', { env: { CLAUDE_SHARE_CTL: sock } });
  assert.equal(r.code, 0);
  assert.match(r.out, /sharing stopped/);
});

test('status reports not-live plainly', async (t) => {
  const sock = await serve(t, { status: async () => ({ ok: true, live: false }) });
  const r = await run('status', { env: { CLAUDE_SHARE_CTL: sock } });
  assert.equal(r.code, 0);
  assert.match(r.out, /not live/);
});

test('status reports the live room + invite', async (t) => {
  const sock = await serve(t, {
    status: async () => ({ ok: true, live: true, room: 'keen-fox', inviteUrl: 'https://claudecollab.org/keen-fox' }),
  });
  const r = await run('status', { env: { CLAUDE_SHARE_CTL: sock } });
  assert.equal(r.code, 0);
  assert.match(r.out, /live — room keen-fox/);
  assert.match(r.out, /invite: https:\/\/claudecollab\.org\/keen-fox/);
});
