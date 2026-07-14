import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRoomFile, clearRoomFile } from './room-file.js';

test('writeRoomFile writes only the whitelisted fields, mode 0600', () => {
  const f = path.join(os.tmpdir(), `rf-test-${process.pid}.json`);
  const ok = writeRoomFile(f, { room: 'brave-otter', inviteUrl: 'https://x/brave-otter', webUrl: 'https://x', hostUrl: 'https://x/?host=SECRET', token: 'SECRET' });
  assert.ok(ok);
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(data, { room: 'brave-otter', inviteUrl: 'https://x/brave-otter', webUrl: 'https://x' });
  assert.ok(!fs.readFileSync(f, 'utf8').includes('SECRET'), 'no secret field survives the whitelist');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  clearRoomFile(f);
  assert.ok(!fs.existsSync(f));
});
test('clearRoomFile on a missing file does not throw', () => {
  clearRoomFile(path.join(os.tmpdir(), 'rf-never-existed.json'));
});
test('writeRoomFile returns false instead of throwing on an unwritable path', () => {
  assert.equal(writeRoomFile('/nonexistent-dir-xyz/rf.json', { room: 'x' }), false);
});
