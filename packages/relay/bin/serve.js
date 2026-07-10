#!/usr/bin/env node
// Production entry for a DEPLOYED relay (Fly.io, a VPS, …) — env-driven config:
//
//   WEB_PORT    browser door (http + ws)            default 8080
//   SSH_PORT    ssh door (the host CLI connects)    default 2222
//   PUBLIC_URL  public https origin for links       e.g. https://claude-share.fly.dev
//   HOST_KEY    ssh host key, PEM contents          set as a secret; see below
//   HOST_NAME   name shown in the ssh banner        default "claude-share"
//
// HOST_KEY should be a PERSISTENT ed25519 private key (e.g. `fly secrets set
// HOST_KEY="$(node packages/relay/bin/serve.js --make-key)"`). Without one we
// generate a fresh key per boot — everything works, but ssh guests see a
// "host identification changed" warning after every restart/redeploy.

import process from 'node:process';
import ssh2 from 'ssh2';
import { startRelay } from '../server.js';

const { utils } = ssh2;

// `--make-key`: print a fresh ed25519 private key and exit (for the secret).
if (process.argv.includes('--make-key')) {
  process.stdout.write(utils.generateKeyPairSync('ed25519').private + '\n');
  process.exit(0);
}

const webPort = Number(process.env.WEB_PORT || 8080);
const sshPort = Number(process.env.SSH_PORT || 2222);
const publicUrl = process.env.PUBLIC_URL || undefined;
const hostName = process.env.HOST_NAME || 'claude-share';

let hostKey = process.env.HOST_KEY;
if (!hostKey) {
  console.warn('serve: no HOST_KEY set — generating an EPHEMERAL key (ssh guests will see');
  console.warn('serve: identity warnings after a restart). Set one: serve.js --make-key');
  hostKey = utils.generateKeyPairSync('ed25519').private;
}

const relay = await startRelay({
  host: '0.0.0.0', // containers route external traffic to us; bind everything
  port: sshPort,
  webPort,
  publicUrl,
  hostKey,
  hostName,
});

console.log(`relay up: ssh :${relay.port} · web :${relay.webPort}${publicUrl ? ` · public ${publicUrl}` : ''}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    relay.close();
    process.exit(0);
  });
}
