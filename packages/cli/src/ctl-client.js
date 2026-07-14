// `collab go|off|status` — the subcommands the wrapped Claude runs INSIDE a session
// to drive it (spec phase 5a: the plugin's hands). Each reads CLAUDE_SHARE_CTL from
// the environment, sends one JSON-line request to the control socket, and prints the
// single reply as human-readable lines Claude can quote straight back to the user.
//
//   live — room brave-otter
//   invite: https://claudecollab.org/brave-otter
//
// No --json flag: the text IS the interface. Not inside a collab session (no
// CLAUDE_SHARE_CTL) → a friendly stderr hint + exit 2. A relay/handler failure →
// stderr the error + exit 1. Success → the lines above + exit 0.

import net from 'node:net';

/** Map `collab go` flags to request overrides the host validates. */
function parseGoArgs(args) {
  const req = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--guests') req.guests = args[++i];
    else if (a === '--max-guests') req.max = Number(args[++i]);
    else if (a === '--room-password') req.pass = args[++i];
  }
  return req;
}

/**
 * Send one request line to the control socket and resolve with the parsed reply
 * line. Rejects on connect error, malformed reply, or timeout.
 * @param {string} sockPath  the CLAUDE_SHARE_CTL unix socket
 * @param {object} req       the request object (must carry v:1)
 * @param {number} ms        reply timeout
 */
export function sendCtl(sockPath, req, ms = 5000) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath, () => conn.write(JSON.stringify(req) + '\n'));
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('control socket timed out'));
    }, ms);
    timer.unref?.();
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      conn.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reject(err);
      }
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Human-readable rendering of a successful reply, per subcommand. */
export function formatReply(sub, reply) {
  if (sub === 'off') return 'sharing stopped';
  if (reply.room) {
    const lines = [`live — room ${reply.room}`];
    if (reply.inviteUrl) lines.push(`invite: ${reply.inviteUrl}`);
    return lines.join('\n');
  }
  return 'not live — run `collab go` to share this session';
}

/**
 * The testable core: returns an exit code and writes via injected out/err so tests
 * never call process.exit. `ctlMain` is the thin process wrapper below.
 * @param {object} opts
 * @param {'go'|'off'|'status'} opts.sub
 * @param {string[]} [opts.args]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(s:string)=>void} opts.out
 * @param {(s:string)=>void} opts.err
 * @returns {Promise<number>} exit code
 */
export async function runCtl({ sub, args = [], env = process.env, out, err }) {
  const sockPath = env.CLAUDE_SHARE_CTL;
  if (!sockPath) {
    err('not inside a collab session — start one with: collab\n');
    return 2;
  }
  const req = { v: 1, t: sub, ...(sub === 'go' ? parseGoArgs(args) : {}) };
  // `go` may dial the relay, which the host bounds at 15s — wait past that for the
  // authoritative verdict; the instant ops (off/status) keep the short timeout.
  const timeout = sub === 'go' ? 20000 : 5000;
  let reply;
  try {
    reply = await sendCtl(sockPath, req, timeout);
  } catch (e) {
    err(`collab: ${e.message}\n`);
    return 1;
  }
  if (!reply || reply.ok !== true) {
    err(`collab: ${reply?.error || 'request failed'}\n`);
    return 1;
  }
  out(formatReply(sub, reply) + '\n');
  return 0;
}

/** The process entry point the `collab` bin dispatches `go|off|status` to. */
export async function ctlMain(sub, args) {
  const code = await runCtl({
    sub,
    args,
    env: process.env,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
