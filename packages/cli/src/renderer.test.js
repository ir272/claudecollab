import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paint, statusLine, stringWidth, truncateToWidth, ROLE_GLYPH } from './renderer.js';

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
