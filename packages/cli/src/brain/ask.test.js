import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askContext, summarizeToolInput, ASK_SUMMARY_MAX } from './ask.js';

// ── summarizeToolInput: the first useful field, in priority order ───────────────

test('summarizeToolInput prefers command, then a file path, then other fields', () => {
  assert.equal(summarizeToolInput({ command: 'rm -rf /tmp/x', file_path: 'a.js' }), 'rm -rf /tmp/x');
  assert.equal(summarizeToolInput({ file_path: 'src/app.js' }), 'src/app.js');
  assert.equal(summarizeToolInput({ pattern: 'TODO' }), 'TODO');
  assert.equal(summarizeToolInput({}), '');
  assert.equal(summarizeToolInput(null), '');
  assert.equal(summarizeToolInput({ command: '   ' }), '', 'a blank field is skipped');
});

// ── askContext: tool + summary while asking (the money path) ────────────────────

test('askContext uses the last tool name + its input summary when a tool ran this turn', () => {
  const ctx = askContext(
    { notification_type: 'permission_prompt', message: 'allow Edit?' },
    { name: 'Edit', summary: 'src/app.js' },
  );
  assert.deepEqual(ctx, { tool: 'Edit', summary: 'src/app.js' });
});

test('askContext falls back to the Notification message when no tool ran (real-Claude ask)', () => {
  const ctx = askContext({ message: 'Claude needs your permission to use Bash' }, null);
  assert.equal(ctx.tool, 'Bash', 'the tool name is parsed out of the message');
  assert.equal(ctx.summary, 'Claude needs your permission to use Bash');
});

test('askContext degrades to a generic tool when nothing identifies it', () => {
  assert.deepEqual(askContext({}, null), { tool: 'tool', summary: '' });
  assert.deepEqual(askContext(null, null), { tool: 'tool', summary: '' });
});

test('askContext strips control sequences and collapses whitespace in the summary', () => {
  const nasty = 'run\x1b[31m evil\n\n\tthing\x07 now\x00';
  const ctx = askContext({ message: 'allow Bash' }, { name: 'Bash', summary: nasty });
  assert.equal(ctx.summary, 'run evil thing now', 'ANSI/control bytes gone, newlines collapsed');
  assert.ok(!/[\x00-\x08\x1b\x7f]/.test(ctx.summary), 'no control bytes survive');
});

test('askContext clamps the summary to ~120 chars', () => {
  const long = 'x'.repeat(500);
  const ctx = askContext({ message: 'allow Bash' }, { name: 'Bash', summary: long });
  assert.equal(ctx.summary.length, ASK_SUMMARY_MAX);
  assert.equal(ASK_SUMMARY_MAX, 120);
});

test('askContext clamps a hostile tool name too (no unbounded field reaches the card)', () => {
  const ctx = askContext({}, { name: 'T'.repeat(200), summary: 'x' });
  assert.ok(ctx.tool.length <= 40);
});
