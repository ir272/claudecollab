import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostUrl, inviteUrl, readyToast } from './invite.js';

test('hostUrl carries the host token (auto-admit as host)', () => {
  assert.equal(
    hostUrl({ host: '127.0.0.1', port: 8787, code: 'humble-shark', token: 'deadbeef' }),
    'http://127.0.0.1:8787/humble-shark?host=deadbeef',
  );
});

test('inviteUrl is token-free — the safe link to share with a friend (finding 1)', () => {
  const url = inviteUrl({ host: '127.0.0.1', port: 8787, code: 'humble-shark' });
  assert.equal(url, 'http://127.0.0.1:8787/humble-shark');
  assert.ok(!url.includes('host='), 'the invite never leaks the host token');
});

test('the two URLs differ only by the token — pasting the invite cannot grant the host seat', () => {
  const args = { host: 'h', port: 1, code: 'c', token: 't' };
  assert.notEqual(hostUrl(args), inviteUrl(args));
  assert.ok(hostUrl(args).startsWith(inviteUrl(args)), 'invite is the host URL without ?host=');
});

test('readyToast only claims the clipboard when the copy happened (finding 5)', () => {
  assert.match(readyToast(true), /copied to clipboard/);
  assert.doesNotMatch(readyToast(false), /copied/);
  // The no-copy path still tells the host how to reach the invite (from their tab).
  assert.match(readyToast(false), /invite/);
});
