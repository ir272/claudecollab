import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paint, statusLine, stringWidth, truncateToWidth, ROLE_GLYPH } from './renderer.js';

// ── ANSI vocabulary the band uses (must match renderer.js) ────────────────────
const SAVE = '\x1b7';
const RESTORE = '\x1b8';
const CLEAR = '\x1b[2K';
const ORANGE = '\x1b[38;5;214m';
const RESET = '\x1b[0m';
const pos = (row) => `\x1b[${row};1H`;

// Strip the CSI/OSC/DECSC-DECRC escapes so we can measure visible columns.
const stripAnsi = (s) =>
  s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[78]/g, '');

// Pull the content of each band line out of a paint() string.
function bandContentLines(out) {
  const inner = out.replace(/^\x1b7/, '').replace(/\x1b8$/, '');
  return inner.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1);
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
  assert.equal(stringWidth('á'), 1); // a + combining acute accent
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

// ── ROLE_GLYPH ────────────────────────────────────────────────────────────────

test('ROLE_GLYPH covers every spec role', () => {
  for (const role of ['host', 'driver', 'prompter', 'viewer']) {
    assert.equal(typeof ROLE_GLYPH[role], 'string');
    assert.ok(ROLE_GLYPH[role].length >= 1, role);
  }
});

// ── statusLine (the one band line: room · N people · claude-state · URL) ────────

test('statusLine renders room, people count, claude state, and the room URL', () => {
  const line = statusLine(
    { room: 'brave-otter', people: 3, claudeState: '✻ brewing…', url: 'http://h:8787/brave-otter?host=abc' },
    120,
  );
  const plain = stripAnsi(line);
  assert.match(plain, /^─ brave-otter · 3 people · ✻ brewing… · http:\/\/h:8787\/brave-otter\?host=abc ─$/);
});

test('statusLine pluralizes the people count', () => {
  assert.match(stripAnsi(statusLine({ room: 'r', people: 1, claudeState: 'live' }, 80)), /· 1 person ·/);
  assert.match(stripAnsi(statusLine({ room: 'r', people: 2, claudeState: 'live' }, 80)), /· 2 people ·/);
});

test('statusLine falls back to a solo label with no room and drops a missing URL', () => {
  const line = statusLine({ people: 1, claudeState: 'solo' }, 80);
  assert.match(stripAnsi(line), /^─ claude-share · 1 person · solo ─$/);
  assert.doesNotMatch(stripAnsi(line), /http/);
});

test('statusLine omits the count when people is not a finite number', () => {
  assert.match(stripAnsi(statusLine({ room: 'r', claudeState: 'live' }, 80)), /^─ r · live ─$/);
});

test('statusLine never exceeds the column budget (no wrap into Claude)', () => {
  for (const cols of [8, 20, 40, 80]) {
    const line = statusLine(
      {
        room: 'a-very-long-room-code-name',
        people: 8,
        claudeState: '⚠ bypass mode: everyone can now drive real commands with no asks',
        url: 'http://a-long-relay-host.example.com:8787/a-very-long-room-code?host=deadbeefdeadbeef',
      },
      cols,
    );
    assert.ok(stringWidth(line) <= cols, `cols=${cols}: visible width ${stringWidth(line)} > ${cols}`);
  }
});

test('statusLine keeps the room URL whole on common widths, trimming other slots (finding 3)', () => {
  // The live repro: at 100 cols the old whole-line clamp cut the URL to "…8787/humble-s".
  // A realistic host-tab URL must now survive intact at both 100 and the 80-col floor.
  const url = 'http://127.0.0.1:8787/humble-shark?host=deadbeefdeadbeef';
  for (const cols of [80, 100, 120]) {
    const line = statusLine(
      { room: 'humble-shark', people: 3, claudeState: '✻ brewing…', url },
      cols,
    );
    const plain = stripAnsi(line);
    assert.ok(plain.includes(url), `cols=${cols}: the full URL survives, got ${JSON.stringify(plain)}`);
    assert.ok(stringWidth(line) <= cols, `cols=${cols}: still never wraps into Claude`);
  }
});

test('statusLine drops lower-priority slots before touching the URL (finding 3)', () => {
  // Narrow enough that not everything fits: the URL and room survive; people/claude go.
  const url = 'http://127.0.0.1:8787/humble-shark?host=deadbeefdeadbeef';
  const line = statusLine({ room: 'humble-shark', people: 3, claudeState: '✻ brewing…', url }, 74);
  const plain = stripAnsi(line);
  assert.ok(plain.includes(url), 'the URL is never sacrificed to fit the other slots');
  assert.ok(stringWidth(line) <= 74);
});

test('statusLine only trims the URL itself on an absurdly narrow terminal', () => {
  // Below the URL's own width there is no other option than to trim it — the
  // never-wrap-into-Claude invariant wins, but this is far below the 80-col floor.
  const line = statusLine({ room: 'r', url: 'http://127.0.0.1:8787/humble-shark?host=deadbeef' }, 20);
  assert.ok(stringWidth(line) <= 20, 'the band still never exceeds the width');
});

test('statusLine is colored orange and reset', () => {
  const line = statusLine({ room: 'r', people: 1, claudeState: 'live' }, 80);
  assert.ok(line.startsWith(ORANGE), 'opens with the orange SGR');
  assert.ok(line.endsWith(RESET), 'ends with a reset');
});

// ── paint: the single status line pinned to the bottom row ──────────────────────

test('paint renders one status line on the terminal bottom row', () => {
  const out = paint({ cols: 40, rows: 10, bandRows: 1, room: 'x', people: 1, claudeState: 'live' });
  const status = statusLine({ room: 'x', people: 1, claudeState: 'live', cols: 40 }, 40);
  const expected = SAVE + pos(10) + CLEAR + status + RESTORE;
  assert.equal(out, expected);
});

test('paint saves and restores the cursor around the band', () => {
  const out = paint({ cols: 80, rows: 24, bandRows: 1, room: 'r' });
  assert.ok(out.startsWith(SAVE), 'starts with DECSC');
  assert.ok(out.endsWith(RESTORE), 'ends with DECRC');
});

test('paint anchors the single line to the terminal bottom row for any height', () => {
  for (const rows of [24, 30, 40, 50]) {
    const out = paint({ cols: 100, rows, bandRows: 1, room: 'r', people: 2, claudeState: 'live' });
    const rowsRef = bandRowsReferenced(out);
    assert.deepEqual(rowsRef, [rows], `rows=${rows}: the one band row is the bottom row`);
  }
});

test('paint clears any reserved rows above the status line', () => {
  // A defensive bandRows > 1: the status line is on the last row, the rows above are
  // cleared blank (never used in practice — the band is one line).
  const out = paint({ cols: 40, rows: 10, bandRows: 3, room: 'x', people: 1, claudeState: 'live' });
  const content = bandContentLines(out);
  assert.equal(content.length, 3);
  assert.equal(content[0], '', 'first reserved row blank');
  assert.equal(content[1], '', 'second reserved row blank');
  assert.match(stripAnsi(content[2]), /─ x · 1 person · live ─/, 'status on the last row');
  assert.deepEqual(bandRowsReferenced(out), [8, 9, 10]);
});

test('paint never lets the band line exceed the terminal width', () => {
  for (const cols of [8, 20, 40, 80]) {
    const out = paint({
      cols,
      rows: 24,
      bandRows: 1,
      room: 'a-very-long-room-code-name',
      people: 8,
      claudeState: 'a very long status that would overflow a narrow terminal',
      url: 'http://host:8787/a-very-long-room-code-name?host=deadbeefdeadbeef',
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
  const out = paint({ bandRows: 1, room: 'r' });
  assert.deepEqual(bandRowsReferenced(out), [24]);
  for (const line of bandContentLines(out)) assert.ok(stringWidth(line) <= 80);
});
