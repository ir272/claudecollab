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
  assert.deepEqual([...COMMAND_NAMES].sort(), ['end', 'kick', 'pause', 'queue', 'recap', 'resume', 'role'].sort());
});

test('parse /role reads the @mention and target role', () => {
  assert.deepEqual(parse('/role @siddh prompter'), { name: 'role', mention: 'siddh', role: 'prompter' });
  assert.deepEqual(parse('/role @james viewer'), { name: 'role', mention: 'james', role: 'viewer' });
  // bare name (no @) is tolerated; role is case-insensitive
  assert.deepEqual(parse('/role siddh PROMPTER'), { name: 'role', mention: 'siddh', role: 'prompter' });
});

test('parse /role reports a usage error on a bad or missing role', () => {
  assert.equal(parse('/role @siddh king').error, 'usage: /role @name prompter|viewer');
  assert.equal(parse('/role @siddh host').error, 'usage: /role @name prompter|viewer', 'cannot set host via /role');
  assert.equal(parse('/role @siddh').error, 'usage: /role @name prompter|viewer');
  assert.ok(parse('/role').error);
});

test('parse /kick reads the @mention', () => {
  assert.deepEqual(parse('/kick @james'), { name: 'kick', mention: 'james' });
  assert.deepEqual(parse('/kick bob'), { name: 'kick', mention: 'bob' });
  assert.ok(parse('/kick').error, 'kick needs a target');
});

test('parse /queue reads del/edit with a 1-based index', () => {
  assert.deepEqual(parse('/queue del 2'), { name: 'queue', sub: 'del', index: 2 });
  assert.deepEqual(parse('/queue rm 1'), { name: 'queue', sub: 'del', index: 1 }, 'rm aliases del');
  assert.deepEqual(parse('/queue delete 3'), { name: 'queue', sub: 'del', index: 3 });
  assert.deepEqual(parse('/queue edit 2 use tailwind instead'), {
    name: 'queue',
    sub: 'edit',
    index: 2,
    text: 'use tailwind instead',
  });
});

test('parse /queue reports usage on a bad subcommand or index', () => {
  assert.equal(parse('/queue').error, 'usage: /queue del <n> | /queue edit <n> <text>');
  assert.equal(parse('/queue del').error, 'usage: /queue del <n> | /queue edit <n> <text>');
  assert.equal(parse('/queue del 0').error, 'usage: /queue del <n> | /queue edit <n> <text>', 'index is 1-based');
  assert.equal(parse('/queue del x').error, 'usage: /queue del <n> | /queue edit <n> <text>');
  assert.equal(parse('/queue edit 1').error, 'usage: /queue del <n> | /queue edit <n> <text>', 'edit needs text');
  assert.equal(parse('/queue frobnicate 1').error, 'usage: /queue del <n> | /queue edit <n> <text>');
});

test('parse handles the argless commands', () => {
  assert.deepEqual(parse('/pause'), { name: 'pause' });
  assert.deepEqual(parse('/resume'), { name: 'resume' });
  assert.deepEqual(parse('/recap'), { name: 'recap' });
});

test('parse threads the /end save flag', () => {
  assert.deepEqual(parse('/end'), { name: 'end', save: true });
  assert.deepEqual(parse('/end nosave'), { name: 'end', save: false });
  assert.deepEqual(parse('  /END  NOSAVE '), { name: 'end', save: false }, 'trimmed + case-insensitive');
});

// ── permitted (spec input table) ────────────────────────────────────────────────

test('recap and queue are prompter and up', () => {
  for (const cmd of ['recap', 'queue']) {
    assert.equal(permitted(cmd, 'viewer'), false, cmd);
    assert.equal(permitted(cmd, 'prompter'), true, cmd);
    assert.equal(permitted(cmd, 'prompter'), true, cmd);
    assert.equal(permitted(cmd, 'host'), true, cmd);
  }
});

test('role/kick/pause/resume/end are host only', () => {
  for (const cmd of ['role', 'kick', 'pause', 'resume', 'end']) {
    assert.equal(permitted(cmd, 'viewer'), false, cmd);
    assert.equal(permitted(cmd, 'prompter'), false, cmd);
    assert.equal(permitted(cmd, 'prompter'), false, `${cmd} is not a prompter power`);
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
