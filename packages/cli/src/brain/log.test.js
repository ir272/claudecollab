import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Log } from './log.js';

// A controllable clock so relative-time assertions are deterministic.
function fixedClock(start = 0) {
  let t = start;
  return { now: () => t, set: (v) => (t = v), advance: (ms) => (t += ms) };
}

test('records attributed prompts in order', () => {
  const clk = fixedClock(1000);
  const log = new Log({ now: clk.now });
  log.prompt('ian', 'refactor the navbar');
  clk.advance(60000);
  log.prompt('james', 'fix the failing auth test');
  const ps = log.prompts();
  assert.equal(ps.length, 2);
  assert.deepEqual(ps.map((p) => [p.author, p.text]), [
    ['ian', 'refactor the navbar'],
    ['james', 'fix the failing auth test'],
  ]);
  assert.equal(log.lastPromptAuthor(), 'james');
});

test('recentPrompts returns the tail, newest last', () => {
  const log = new Log();
  for (let i = 0; i < 5; i++) log.prompt('ian', `p${i}`);
  assert.deepEqual(log.recentPrompts(3).map((p) => p.text), ['p2', 'p3', 'p4']);
});

test('tool entries accumulate a de-duplicated, ordered file list', () => {
  const log = new Log();
  log.tool('Edit', ['src/Nav.tsx']);
  log.tool('Write', ['src/auth.test.ts', 'src/Nav.tsx']); // Nav repeats
  log.tool('Bash', []);
  assert.deepEqual(log.files, ['src/Nav.tsx', 'src/auth.test.ts']);
});

test('events are recorded and interleaved by time', () => {
  const log = new Log();
  log.prompt('ian', 'hi');
  log.event('siddh joined as prompter');
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[1].kind, 'event');
  assert.equal(log.entries[1].text, 'siddh joined as prompter');
});

test('entries are copies — the log cannot be mutated through a read', () => {
  const log = new Log();
  log.prompt('ian', 'x');
  log.entries[0].text = 'nope';
  assert.equal(log.entries[0].text, 'x');
});

test('toText renders the attributed transcript for /recap input', () => {
  const log = new Log();
  log.prompt('ian', 'refactor the navbar');
  log.event('siddh joined');
  log.tool('Edit', ['src/Nav.tsx']);
  const text = log.toText();
  assert.match(text, /ian: refactor the navbar/);
  assert.match(text, /siddh joined/);
  assert.match(text, /src\/Nav\.tsx/);
});

test('toMarkdown produces an attributed who-typed-what document', () => {
  const log = new Log();
  log.prompt('ian', 'refactor the navbar');
  log.prompt('james', 'fix the failing auth test');
  const md = log.toMarkdown();
  assert.match(md, /^#/m, 'has a heading');
  assert.match(md, /ian/);
  assert.match(md, /refactor the navbar/);
  assert.match(md, /james/);
  assert.match(md, /fix the failing auth test/);
});

test('write emits session.md to disk', () => {
  const log = new Log();
  log.prompt('ian', 'hello world prompt');
  const file = path.join(os.tmpdir(), `claude-share-log-test-${process.pid}.md`);
  try {
    log.write(file);
    const contents = fs.readFileSync(file, 'utf8');
    assert.match(contents, /hello world prompt/);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
});

test('prompt text is sanitized — pasted terminal escapes never land in the log', () => {
  const log = new Log();
  log.prompt('ian', 'hello\x1b[31mred\x1b[0m\x07world');
  assert.equal(log.prompts()[0].text, 'helloredworld');
  const md = log.toMarkdown();
  assert.doesNotMatch(md, /\x1b/);
  assert.match(md, /helloredworld/);
});
