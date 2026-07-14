// Control-socket transport tests — a real unix socket in a tmpdir, driven by a
// net client exactly as the wrapped Claude's `collab go` will. Proves the version
// gate, go/off/status round-trips against stub handlers, malformed-line recovery,
// and the 0600 lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCtl } from './ctl.js';

// Open one connection, write raw bytes, resolve with the first reply line parsed.
function ask(sockPath, raw) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath, () => conn.write(raw));
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('ctl: no reply'));
    }, 3000);
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        conn.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (err) {
          reject(err);
        }
      }
    });
    conn.on('error', reject);
  });
}

// A persistent connection that can send several lines and collect replies in order.
function openConn(sockPath) {
  const conn = net.connect(sockPath);
  const replies = [];
  const waiters = [];
  let buf = '';
  conn.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      replies.push(msg);
      const w = waiters.shift();
      if (w) w(msg);
    }
  });
  return {
    conn,
    send: (raw) => conn.write(raw),
    next: (ms = 3000) =>
      replies.length
        ? Promise.resolve(replies.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ctl: no reply')), ms);
            waiters.push((m) => {
              clearTimeout(timer);
              resolve(m);
            });
          }),
    close: () => conn.end(),
  };
}

function tmpSock(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-ctl-'));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return join(dir, 'ctl.sock');
}

// Small helper: start a ctl server with the given handlers, tear it down after.
// Resolves only once a probe connection SUCCEEDS — which means the 'listening'
// callback (where chmod 0600 happens) has already run, so mode checks are race-free.
function serve(t, handlers) {
  const sockPath = tmpSock(t);
  const ctl = startCtl({ path: sockPath, handlers });
  t.after(() => ctl.close());
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

test('version gate: v:2 is refused', async (t) => {
  const sock = await serve(t, { status: async () => ({ ok: true, live: false }) });
  const res = await ask(sock, JSON.stringify({ v: 2, t: 'status' }) + '\n');
  assert.deepEqual(res, { ok: false, error: 'version' });
});

test('version gate: a missing v is refused', async (t) => {
  const sock = await serve(t, { status: async () => ({ ok: true, live: false }) });
  const res = await ask(sock, JSON.stringify({ t: 'status' }) + '\n');
  assert.deepEqual(res, { ok: false, error: 'version' });
});

test('go/off/status round-trip against stub handlers', async (t) => {
  const sock = await serve(t, {
    go: async (req) => ({ ok: true, room: 'brave-otter', inviteUrl: 'https://x/brave-otter', echo: req.guests }),
    off: async () => ({ ok: true }),
    status: async () => ({ ok: true, live: true, room: 'brave-otter' }),
  });
  const go = await ask(sock, JSON.stringify({ v: 1, t: 'go', guests: 'prompter' }) + '\n');
  assert.equal(go.ok, true);
  assert.equal(go.room, 'brave-otter');
  assert.equal(go.inviteUrl, 'https://x/brave-otter');
  assert.equal(go.echo, 'prompter', 'the handler receives the full request');

  const off = await ask(sock, JSON.stringify({ v: 1, t: 'off' }) + '\n');
  assert.deepEqual(off, { ok: true });

  const status = await ask(sock, JSON.stringify({ v: 1, t: 'status' }) + '\n');
  assert.deepEqual(status, { ok: true, live: true, room: 'brave-otter' });
});

test('a failing handler surfaces {ok:false,error}', async (t) => {
  const sock = await serve(t, { go: async () => ({ ok: false, error: 'relay timeout' }) });
  const res = await ask(sock, JSON.stringify({ v: 1, t: 'go' }) + '\n');
  assert.deepEqual(res, { ok: false, error: 'relay timeout' });
});

test('a malformed line is dropped; a valid line after it is still answered', async (t) => {
  const sock = await serve(t, { status: async () => ({ ok: true, live: false }) });
  const c = openConn(sock);
  t.after(() => c.close());
  c.send('this is not json\n');
  c.send(JSON.stringify({ v: 1, t: 'status' }) + '\n');
  const res = await c.next();
  assert.deepEqual(res, { ok: true, live: false }, 'the valid request after garbage still gets its reply');
});

test('the socket file is chmod 0600', async (t) => {
  const sock = await serve(t, {});
  const mode = fs.statSync(sock).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0o${mode.toString(8)}`);
});
