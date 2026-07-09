import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, permitted, resolveMention, COMMAND_NAMES } from './commands.js';
import { RoomState } from './state.js';

// ── parse ─────────────────────────────────────────────────────────────────────

test('parse returns null for non-slash text and unknown slash commands', () => {
  assert.equal(parse('make the hero full-bleed'), null);
  assert.equal(parse('!ls -la'), null);
  assert.equal(parse('/clear'), null, 'Claude slash command, not ours');
  assert.equal(parse('/model opus'), null);
  assert.equal(parse(''), null);
});

test('COMMAND_NAMES lists exactly the claude-share commands', () => {
  assert.deepEqual([...COMMAND_NAMES].sort(), ['end', 'kick', 'pause', 'recap', 'resume', 'role'].sort());
});

test('parse /role reads the @mention and target role', () => {
  assert.deepEqual(parse('/role @siddh driver'), { name: 'role', mention: 'siddh', role: 'driver' });
  assert.deepEqual(parse('/role @james viewer'), { name: 'role', mention: 'james', role: 'viewer' });
  // bare name (no @) is tolerated; role is case-insensitive
  assert.deepEqual(parse('/role siddh PROMPTER'), { name: 'role', mention: 'siddh', role: 'prompter' });
});

test('parse /role reports a usage error on a bad or missing role', () => {
  assert.equal(parse('/role @siddh king').error, 'usage: /role @name driver|prompter|viewer');
  assert.equal(parse('/role @siddh host').error, 'usage: /role @name driver|prompter|viewer', 'cannot set host via /role');
  assert.equal(parse('/role @siddh').error, 'usage: /role @name driver|prompter|viewer');
  assert.ok(parse('/role').error);
});

test('parse /kick reads the @mention', () => {
  assert.deepEqual(parse('/kick @james'), { name: 'kick', mention: 'james' });
  assert.deepEqual(parse('/kick bob'), { name: 'kick', mention: 'bob' });
  assert.ok(parse('/kick').error, 'kick needs a target');
});

test('parse handles the argless commands', () => {
  assert.deepEqual(parse('/pause'), { name: 'pause' });
  assert.deepEqual(parse('/resume'), { name: 'resume' });
  assert.deepEqual(parse('/recap'), { name: 'recap' });
  assert.deepEqual(parse('/end'), { name: 'end' });
  assert.deepEqual(parse('  /END  '), { name: 'end' }, 'trimmed + case-insensitive');
});

// ── permitted (spec input table) ────────────────────────────────────────────────

test('recap is prompter and up', () => {
  assert.equal(permitted('recap', 'viewer'), false);
  assert.equal(permitted('recap', 'prompter'), true);
  assert.equal(permitted('recap', 'driver'), true);
  assert.equal(permitted('recap', 'host'), true);
});

test('role/kick/pause/resume/end are host only', () => {
  for (const cmd of ['role', 'kick', 'pause', 'resume', 'end']) {
    assert.equal(permitted(cmd, 'viewer'), false, cmd);
    assert.equal(permitted(cmd, 'prompter'), false, cmd);
    assert.equal(permitted(cmd, 'driver'), false, `${cmd} is not a driver power`);
    assert.equal(permitted(cmd, 'host'), true, cmd);
  }
});

// ── resolveMention ──────────────────────────────────────────────────────────────

test('resolveMention maps a name to a participant id, case-insensitively', () => {
  const s = new RoomState({ hostName: 'ian' });
  s.addGuest('g1', { name: 'Siddh' });
  s.addGuest('g2', { name: 'james' });
  assert.equal(resolveMention(s, 'siddh'), 'g1');
  assert.equal(resolveMention(s, 'JAMES'), 'g2');
  assert.equal(resolveMention(s, 'ian'), 'host');
  assert.equal(resolveMention(s, 'nobody'), null);
  assert.equal(resolveMention(s, ''), null);
});
