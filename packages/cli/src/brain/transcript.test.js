import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestResponse } from './transcript.js';

const line = (obj) => JSON.stringify(obj) + '\n';

test('extracts assistant text after the last human prompt', () => {
  const jsonl =
    line({ type: 'user', message: { role: 'user', content: 'first prompt' } }) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } }) +
    line({ type: 'user', message: { role: 'user', content: 'second prompt' } }) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } });
  assert.equal(extractLatestResponse(jsonl), 'second answer');
});

test('joins multiple assistant text blocks in the same turn', () => {
  const jsonl =
    line({ type: 'user', message: { content: 'go' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'part one' }] } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'part two' }] } });
  assert.equal(extractLatestResponse(jsonl), 'part one\n\npart two');
});

test('a tool_result user line does not reset the turn boundary', () => {
  const jsonl =
    line({ type: 'user', message: { content: 'edit the file' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', name: 'Edit' }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done editing' }] } });
  assert.equal(extractLatestResponse(jsonl), 'on it\n\ndone editing');
});

test('handles string content on an assistant message', () => {
  const jsonl =
    line({ type: 'user', message: { content: 'hi' } }) +
    line({ type: 'assistant', message: { content: 'plain string reply' } });
  assert.equal(extractLatestResponse(jsonl), 'plain string reply');
});

test('skips unparseable / truncated leading lines (tail read)', () => {
  const jsonl =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"tr' + // truncated
    '\n' +
    line({ type: 'user', message: { content: 'real prompt' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'real answer' }] } });
  assert.equal(extractLatestResponse(jsonl), 'real answer');
});

test('empty / missing input never throws', () => {
  assert.equal(extractLatestResponse(''), '');
  assert.equal(extractLatestResponse(undefined), '');
  assert.equal(extractLatestResponse(null), '');
});
