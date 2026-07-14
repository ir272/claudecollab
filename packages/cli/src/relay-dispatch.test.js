// The single `collab` bin doubles as the relay: `collab relay [args]` must
// behave exactly as the old `collab-relay [args]` did (serve.js). Collapsing to
// one bin is what lets `npx @claudecollab/cli` resolve a single entry point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/claude-share.js', import.meta.url));

test('collab relay --make-key dispatches to the relay and prints a host key', () => {
  const r = spawnSync(process.execPath, [bin, 'relay', '--make-key'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BEGIN|PRIVATE KEY/);
});
