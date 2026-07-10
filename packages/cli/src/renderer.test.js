import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paint,
  statusLine,
  stringWidth,
  truncateToWidth,
  ROLE_GLYPH,
  draftBox,
  queueBlock,
  knockLine,
  bandHeight,
} from './renderer.js';

// ── ANSI vocabulary the band uses (must match renderer.js) ────────────────────
const SAVE = '\x1b7';
const RESTORE = '\x1b8';
const CLEAR = '\x1b[2K';
const ORANGE = '\x1b[38;5;214m';
const DIM = '\x1b[38;5;245m';
const RESET = '\x1b[0m';
const pos = (row) => `\x1b[${row};1H`;

// Strip the CSI/OSC/DECSC-DECRC escapes so we can measure visible columns.
const stripAnsi = (s) =>
  s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[78]/g, '');

// Pull the content of each band line out of a paint() string.
function bandContentLines(out) {
  const inner = out.replace(/^\x1b7/, '').replace(/\x1b8$/, '');
  // Each line is `\x1b[<row>;1H\x1b[2K<content>`; split on the position+clear prefix.
  return inner
    .split(/\x1b\[\d+;1H\x1b\[2K/)
    .slice(1); // drop the empty piece before the first prefix
}

function bandRowsReferenced(out) {
  return [...out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));
}

// ── stringWidth ───────────────────────────────────────────────────────────────

test('stringWidth counts plain ASCII one cell each', () => {
  assert.equal(stringWidth(''), 0);
  assert.equal(stringWidth('abcde'), 5);
});

test('stringWidth ignores ANSI escape sequences', () => {
  assert.equal(stringWidth(`${ORANGE}hi${RESET}`), 2);
  assert.equal(stringWidth(`${SAVE}${pos(3)}${CLEAR}x${RESTORE}`), 1);
});

test('stringWidth treats CJK and emoji as two cells', () => {
  assert.equal(stringWidth('中文'), 4); // 中文
  assert.equal(stringWidth('\u{1F441}'), 2); // 👁
});

test('stringWidth treats combining marks as zero width', () => {
  assert.equal(stringWidth('á'), 1); // a + combining acute accent
  assert.equal(stringWidth('x️'), 1); // x + variation selector-16
});

// ── truncateToWidth ─────────────────────────────────────────────────────────

test('truncateToWidth cuts plain text to a column budget', () => {
  assert.equal(truncateToWidth('hello', 3), 'hel');
  assert.equal(truncateToWidth('hello', 10), 'hello');
  assert.equal(truncateToWidth('anything', 0), '');
});

test('truncateToWidth never splits a wide char across the budget', () => {
  // 中(2) 文(2) 字(2): budget 3 fits only the first wide char (2 <= 3, next is 4 > 3).
  assert.equal(truncateToWidth('中文字', 3), '中');
  assert.equal(truncateToWidth('a中b', 2), 'a');
});

// ── paint: exact output ───────────────────────────────────────────────────────

test('paint renders one truncated status line for a 1-row band', () => {
  const out = paint({ cols: 24, rows: 5, bandRows: 1, room: 'x', participants: [], mode: 'default' });
  const expected =
    SAVE + pos(5) + CLEAR + ORANGE + '─ x · solo · mode: defau' + RESET + RESTORE;
  assert.equal(out, expected);
});

test('paint renders status + placeholder for a 2-row band', () => {
  const out = paint({
    cols: 60,
    rows: 10,
    bandRows: 2,
    room: 'brave-otter',
    participants: [
      { name: 'ian', role: 'host' },
      { name: 'siddh', role: 'prompter' },
    ],
    mode: 'accept-edits',
    status: 'hello',
  });
  const status =
    ORANGE + '─ brave-otter · ian★ siddh✎ · mode: accept-edits ─' + RESET;
  const filler = DIM + 'hello' + RESET;
  const expected = SAVE + pos(9) + CLEAR + status + pos(10) + CLEAR + filler + RESTORE;
  assert.equal(out, expected);
});

// ── paint: structural invariants ────────────────────────────────────────────

test('paint saves and restores the cursor around the band', () => {
  const out = paint({ cols: 80, rows: 24, bandRows: 3 });
  assert.ok(out.startsWith(SAVE), 'starts with DECSC');
  assert.ok(out.endsWith(RESTORE), 'ends with DECRC');
});

test('paint emits exactly bandRows lines, positioned at the bottom rows', () => {
  for (const bandRows of [1, 2, 3, 4]) {
    const out = paint({ cols: 80, rows: 24, bandRows });
    const clears = [...out.matchAll(/\x1b\[2K/g)].length;
    assert.equal(clears, bandRows, `bandRows=${bandRows}: line count`);
    const rowsRef = bandRowsReferenced(out);
    assert.deepEqual(
      rowsRef,
      Array.from({ length: bandRows }, (_, i) => 24 - bandRows + 1 + i),
      `bandRows=${bandRows}: rows`,
    );
    assert.equal(Math.max(...rowsRef), 24, 'never writes past the last row');
  }
});

test('paint never lets a band line exceed the terminal width (no wrap into Claude)', () => {
  for (const cols of [8, 20, 40, 80]) {
    const out = paint({
      cols,
      rows: 24,
      bandRows: 2,
      room: 'a-very-long-room-code-name',
      participants: [
        { name: 'aaaaaaaa', role: 'host' },
        { name: 'bbbbbbbb', role: 'driver' },
        { name: 'cccccccc', role: 'viewer' },
      ],
      mode: 'bypassPermissions',
      status: 'a very long placeholder status line that would overflow a narrow terminal',
    });
    for (const line of bandContentLines(out)) {
      assert.ok(stringWidth(line) <= cols, `cols=${cols}: visible width ${stringWidth(line)} > ${cols}`);
    }
  }
});

test('paint returns empty output for a zero-row band', () => {
  assert.equal(paint({ cols: 80, rows: 24, bandRows: 0 }), '');
});

test('paint tolerates missing size fields with 80x24 defaults', () => {
  const out = paint({ bandRows: 2 });
  const rowsRef = bandRowsReferenced(out);
  assert.deepEqual(rowsRef, [23, 24]);
  for (const line of bandContentLines(out)) assert.ok(stringWidth(line) <= 80);
});

// ── statusLine details ────────────────────────────────────────────────────────

test('statusLine falls back to a solo label when no room and no participants', () => {
  const line = statusLine({ mode: 'default' }, 80);
  assert.match(stripAnsi(line), /^─ claude-share · solo · mode: default ─$/);
});

test('ROLE_GLYPH covers every spec role', () => {
  for (const role of ['host', 'driver', 'prompter', 'viewer']) {
    assert.equal(typeof ROLE_GLYPH[role], 'string');
    assert.ok(ROLE_GLYPH[role].length >= 1, role);
  }
});

// ── draftBox (spec §draft lines) ────────────────────────────────────────────────

test('draftBox renders a 3-line author-tagged box within its width', () => {
  const lines = draftBox({ text: 'make the hero full-bleed', authors: ['ian', 'siddh'] }, { cols: 54, focused: true });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('╭'), 'top-left corner');
  assert.ok(lines[0].endsWith('╮'), 'top-right corner');
  assert.match(lines[0], /ian \+ siddh/, 'authors tagged, joined with +');
  assert.match(lines[0], /↵ sends this draft/, 'focused box shows the send hint');
  assert.match(lines[1], /make the hero full-bleed/, 'content line carries the draft text');
  assert.ok(lines[2].startsWith('╰') && lines[2].endsWith('╯'), 'bottom corners');
  for (const l of lines) assert.ok(stringWidth(l) <= 54, `line width ${stringWidth(l)} > 54`);
});

test('an unfocused draftBox omits the send hint', () => {
  const [top] = draftBox({ text: 'use tailwind', authors: ['james'] }, { cols: 40, focused: false });
  assert.doesNotMatch(top, /sends this draft/);
  assert.match(top, /james/);
});

// ── live cursors (the wow beat, spec §draft lines) ──────────────────────────────

test('draftBox renders a caret block + name tag for each participant cursor', () => {
  const lines = draftBox(
    {
      text: 'make the hero full-bleed',
      authors: ['ian', 'siddh'],
      cursors: [
        { name: 'ian', offset: 24 },
        { name: 'siddh', offset: 24 },
      ],
    },
    { cols: 60, focused: true },
  );
  assert.match(lines[1], /▊ian/, "ian's caret is tagged");
  assert.match(lines[1], /▊siddh/, "siddh's caret is tagged");
  assert.match(lines[1], /full-bleed▊/, 'carets sit after the text (both at the end)');
  for (const l of lines) assert.ok(stringWidth(l) <= 60, `width ${stringWidth(l)} > 60`);
});

test('a caret lands at its offset inside the text', () => {
  const [, body] = draftBox(
    { text: 'abcdef', authors: ['ian'], cursors: [{ name: 'jo', offset: 3 }] },
    { cols: 40 },
  );
  assert.match(body, /abc▊jodef/, 'caret+name inserted between "abc" and "def"');
});

test('draftBox without cursors renders no caret (backward compatible)', () => {
  const [, body] = draftBox({ text: 'plain draft', authors: ['ian'] }, { cols: 40 });
  assert.doesNotMatch(body, /▊/);
  assert.match(body, /plain draft/);
});

test('cursor carets never push a draft box past its width', () => {
  for (const cols of [16, 24, 40]) {
    const lines = draftBox(
      {
        text: 'x'.repeat(60),
        authors: ['ian', 'jo'],
        cursors: [
          { name: 'ian', offset: 60 },
          { name: 'jo', offset: 10 },
        ],
      },
      { cols },
    );
    for (const l of lines) assert.ok(stringWidth(l) <= cols, `cols=${cols}: width ${stringWidth(l)}`);
  }
});

test('draftBox truncates overlong text to its inner width', () => {
  const lines = draftBox({ text: 'x'.repeat(200), authors: ['ian'] }, { cols: 30, focused: false });
  for (const l of lines) assert.ok(stringWidth(l) <= 30);
});

test('draftBox collapses newlines so a multi-line draft stays one row', () => {
  const lines = draftBox({ text: 'line one\nline two', authors: ['ian'] }, { cols: 60, focused: false });
  assert.equal(lines.length, 3, 'still exactly three rows');
  assert.doesNotMatch(lines[1], /\n/);
});

// ── queueBlock (spec §queue) ────────────────────────────────────────────────────

test('queueBlock renders an attributed, ordered list under a count header', () => {
  const lines = queueBlock(
    [
      { author: 'james', text: 'use tailwind' },
      { author: 'ian', text: 'make it dark' },
    ],
    { cols: 60 },
  );
  assert.match(lines[0], /queue \(2\)/);
  assert.match(lines[1], /james/);
  assert.match(lines[1], /use tailwind/);
  assert.match(lines[2], /ian/);
  assert.match(lines[2], /make it dark/);
  for (const l of lines) assert.ok(stringWidth(l) <= 60);
});

test('queueBlock is empty for an empty queue', () => {
  assert.deepEqual(queueBlock([], { cols: 60 }), []);
});

// ── knockLine (spec §knock) ──────────────────────────────────────────────────────

test('knockLine warns on a first-time key and asks to admit', () => {
  const line = knockLine({ name: 'siddh', fp: 'SHA256:a1b2c3d4', seen: null }, { cols: 80 });
  assert.match(line, /siddh/);
  assert.match(line, /first time/i);
  assert.match(line, /admit\? \(y\/n\)/);
  assert.ok(stringWidth(line) <= 80);
});

test('knockLine notes a returning key by its prior name', () => {
  const line = knockLine({ name: 'siddh', fp: 'SHA256:a1b2c3d4', seen: 'siddh' }, { cols: 80 });
  assert.match(line, /seen before as siddh/);
});

// ── paint with composed dynamic lines ─────────────────────────────────────────────

test('paint fills the dynamic region from state.lines when provided', () => {
  const out = paint({
    cols: 40,
    rows: 10,
    bandRows: 3,
    room: 'brave-otter',
    participants: [{ name: 'ian', role: 'host' }],
    mode: 'default',
    lines: ['first dynamic line', 'second dynamic line'],
  });
  assert.match(out, /first dynamic line/);
  assert.match(out, /second dynamic line/);
  // three band rows: status + two dynamic lines, positioned at the bottom
  const rowsRef = [...out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));
  assert.deepEqual(rowsRef, [8, 9, 10]);
});

test('paint truncates composed lines to the terminal width', () => {
  const out = paint({
    cols: 12,
    rows: 6,
    bandRows: 2,
    lines: ['this line is definitely wider than twelve columns'],
  });
  const inner = out.replace(/^\x1b7/, '').replace(/\x1b8$/, '');
  const content = inner.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1);
  for (const line of content) assert.ok(stringWidth(line) <= 12, `width ${stringWidth(line)} > 12`);
});

// ── bandHeight (dogfood finding 2: content-driven, capped, never overflows) ───────

test('bandHeight grows with content up to a third-of-screen cap', () => {
  // rows=30, min=6 → cap = max(6, floor(30/3)=10) = 10
  assert.equal(bandHeight(2, 30, { min: 6 }), 6, 'small content clamps up to the min floor');
  assert.equal(bandHeight(8, 30, { min: 6 }), 8, 'grows to fit the content');
  assert.equal(bandHeight(20, 30, { min: 6 }), 10, 'never grows past the cap');
});

test('bandHeight caps at a third of the screen and always leaves Claude a row', () => {
  for (const rows of [24, 30, 40, 50]) {
    const h = bandHeight(1000, rows, { min: 6 });
    assert.ok(h <= Math.max(6, Math.floor(rows / 3)), `rows=${rows}: within the cap`);
    assert.ok(h <= rows - 1, `rows=${rows}: leaves Claude at least one row`);
    assert.ok(h >= 1, `rows=${rows}: at least one band row`);
  }
});

test('bandHeight honors a min floor above a third of a small screen', () => {
  // rows=24, min=8 → cap = max(8, floor(24/3)=8) = 8
  assert.equal(bandHeight(3, 24, { min: 8 }), 8);
});

// ── paint: overflow collapses to "+N more", never past the last row (finding 2) ──

test('paint clips overflowing content to a "+N more" tail within the band', () => {
  // status + 8 dynamic lines = 9 content rows, but the band reserves only 6.
  const lines = ['box1a', 'box1b', 'box1c', 'box2a', 'box2b', 'box2c', 'q1', 'q2'];
  const rows = 24;
  const bandRows = 6;
  const out = paint({ cols: 80, rows, bandRows, room: 'r', participants: [], mode: 'default', lines });
  const content = bandContentLines(out);
  assert.equal(content.length, bandRows, 'paints exactly bandRows content lines');
  assert.match(content[content.length - 1], /\+\d+ more/, 'last row is the overflow marker');
  // 9 content rows into 6: keep 5, mark "+4 more".
  assert.match(content[content.length - 1], /\+4 more/);
  const rowsRef = bandRowsReferenced(out);
  assert.equal(rowsRef.length, bandRows, 'exactly bandRows rows positioned');
  assert.equal(Math.max(...rowsRef), rows, 'bottom band row is the terminal last row');
  assert.equal(Math.min(...rowsRef), rows - bandRows + 1, 'top band row leaves Claude the rest');
});

test('paint never positions a band row past the terminal, even with huge content', () => {
  for (const [rows, bandRows] of [[24, 6], [30, 8], [40, 10]]) {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const out = paint({ cols: 80, rows, bandRows, lines });
    const rowsRef = bandRowsReferenced(out);
    assert.equal(rowsRef.length, bandRows, `rows=${rows}: exactly bandRows rows`);
    assert.equal(Math.max(...rowsRef), rows, `rows=${rows}: never past the last row`);
    assert.ok(rowsRef.every((r) => r >= 1 && r <= rows), `rows=${rows}: all rows on-screen`);
    for (const line of bandContentLines(out)) assert.ok(stringWidth(line) <= 80);
  }
});

test('paint anchors the band bottom to the terminal rows for any height (clamped anchoring)', () => {
  // Finding 3: painted at the shared/clamped size, the band's last row is always the
  // terminal's last row — identical anchoring for every participant.
  for (const rows of [24, 30, 40]) {
    const out = paint({ cols: 100, rows, bandRows: 6, lines: ['a', 'b'] });
    const rowsRef = bandRowsReferenced(out);
    assert.equal(Math.max(...rowsRef), rows, `rows=${rows}: band bottom == last row`);
  }
});
