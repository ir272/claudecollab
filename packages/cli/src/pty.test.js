import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameSplitter, SU_END } from './pty.js';

// ─────────────────────────────────────────────────────────────────────────────
// FrameSplitter is the pure, testable heart of the PTY wrapper. Claude Code v2
// is an alternate-screen TUI that wraps every repaint in a synchronized-update
// frame (`?2026h` … `?2026l`). We cut Claude's output stream on the `?2026l`
// end-marker so the caller writes whole frames to stdout and only redraws the
// band on a frame boundary — no smearing mid-repaint (spec §renderer).
//
// startPty() itself needs a real terminal + node-pty, so it is exercised by the
// manual check below rather than in CI.
//
// MANUAL CHECK — verified 2026-07-09 with a node-pty harness that spawns the bin
// inside an 80x24 PTY and wraps a fake "claude" (`bash -c` emitting one
// `?2026h…?2026l` frame + a markerless tail). Reproduce:
//   const pty = require('node-pty');
//   const t = pty.spawn(process.execPath,
//     ['packages/cli/bin/claude-share.js','--no-relay','--cmd','bash','--','-c',
//      "printf '\\x1b[?2026hHELLO\\x1b[?2026l'; sleep .3; printf TAIL"],
//     {name:'xterm-256color', cols:80, rows:24});
//   let out=''; t.onData(d=>out+=d); t.onExit(()=>console.log(JSON.stringify(out)));
//   Observed: child frame + markerless tail pass through; the orange status line
//   and dim placeholder paint at rows 23 & 24 (24 - bandRows=2); cursor is saved
//   (\x1b7) / restored (\x1b8) around each band redraw; `?1049l` on teardown. The
//   band never scrolls with output because the child PTY is (rows - bandRows) tall.
//   (tmux capture-pane, as in spike/wrap.py, shows the same layout visually.)
// ─────────────────────────────────────────────────────────────────────────────

test('SU_END is the synchronized-update end marker (?2026l)', () => {
  assert.equal(SU_END, '\x1b[?2026l');
});

test('one complete frame in one chunk is emitted whole', () => {
  const fs = new FrameSplitter();
  const frame = `\x1b[?2026hpaint the screen${SU_END}`;
  assert.deepEqual(fs.push(frame), [frame]);
  assert.equal(fs.pending, 0);
});

test('two frames in one chunk split into two', () => {
  const fs = new FrameSplitter();
  const f1 = `A${SU_END}`;
  const f2 = `B${SU_END}`;
  assert.deepEqual(fs.push(f1 + f2), [f1, f2]);
});

test('a frame split across chunks is reassembled', () => {
  const fs = new FrameSplitter();
  assert.deepEqual(fs.push('first half of a '), []); // no marker yet
  assert.equal(fs.pending > 0, true);
  const rest = `repaint${SU_END}`;
  assert.deepEqual(fs.push(rest), [`first half of a repaint${SU_END}`]);
  assert.equal(fs.pending, 0);
});

test('the end marker itself split across a chunk boundary is reassembled', () => {
  const fs = new FrameSplitter();
  // Break the 8-byte marker "\x1b[?2026l" between "?20" and "26l".
  assert.deepEqual(fs.push('hi\x1b[?20'), []);
  assert.deepEqual(fs.push('26l'), ['hi\x1b[?2026l']);
});

test('trailing bytes after the last marker stay pending until flushed', () => {
  const fs = new FrameSplitter();
  const frames = fs.push(`done${SU_END}and more`);
  assert.deepEqual(frames, [`done${SU_END}`]);
  assert.equal(fs.pending, 'and more'.length);
  assert.equal(fs.flush(), 'and more');
  assert.equal(fs.pending, 0);
  assert.equal(fs.flush(), null); // nothing left
});

test('markerless output stays buffered and comes out on flush', () => {
  const fs = new FrameSplitter();
  assert.deepEqual(fs.push('plain banner text, no frame'), []);
  assert.equal(fs.flush(), 'plain banner text, no frame');
});
