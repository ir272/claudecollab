import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drafts } from './drafts.js';

// ── raw terminal byte vocabulary the state machine understands ──────────────────
const ENTER = '\r'; // Enter → send this draft
const SHIFT_ENTER = '\x1b\r'; // shift+enter → newline within the draft
const SHIFT_ENTER_KITTY = '\x1b[13;2u';
const SHIFT_ENTER_CSIU = '\x1b[27;2;13~';
const BS = '\x7f'; // backspace (DEL)
const BS_ALT = '\x08'; // backspace (BS)
const CTRL_W = '\x17'; // delete previous word
const CTRL_U = '\x15'; // kill to line start
const CTRL_K = '\x0b'; // kill to line end
const CTRL_A = '\x01'; // home
const CTRL_E = '\x05'; // end
const HOME = '\x1b[H';
const END = '\x1b[F';
const HOME_TILDE = '\x1b[1~';
const END_TILDE = '\x1b[4~';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const WORD_LEFT = '\x1bb'; // option/alt + left (ESC b)
const WORD_RIGHT = '\x1bf'; // option/alt + right (ESC f)
const WORD_LEFT_CSI = '\x1b[1;3D';
const WORD_RIGHT_CSI = '\x1b[1;3C';
const ALT_BS = '\x1b\x7f'; // option/alt + backspace → delete previous word
const ESC = '\x1b'; // lone escape
const paste = (s) => `\x1b[200~${s}\x1b[201~`;

// grab the sole box (most tests build exactly one)
const only = (d) => {
  assert.equal(d.boxes.length, 1, `expected exactly one box, got ${d.boxes.length}`);
  return d.boxes[0];
};

// ── creating & typing ───────────────────────────────────────────────────────

test('typing with no active draft creates a box, inserts text, advances the cursor', () => {
  const d = new Drafts();
  const eff = d.keystroke('ian', 'hello');
  const box = only(d);
  assert.equal(box.text, 'hello');
  assert.equal(box.cursors.get('ian'), 5);
  assert.ok(box.authors.has('ian'));
  assert.equal(eff.send, null);
  assert.equal(eff.changed, true);
});

test('two users each typing with no focus land in separate boxes', () => {
  const d = new Drafts();
  d.keystroke('ian', 'aaa');
  d.keystroke('james', 'bbb');
  assert.equal(d.boxes.length, 2);
  assert.equal(d.boxes[0].text, 'aaa');
  assert.equal(d.boxes[1].text, 'bbb');
  assert.ok(d.boxes[0].authors.has('ian') && !d.boxes[0].authors.has('james'));
  assert.ok(d.boxes[1].authors.has('james'));
});

test('printable insertion happens at the cursor, not the end', () => {
  const d = new Drafts();
  d.keystroke('ian', 'helo');
  d.keystroke('ian', LEFT); // cursor between 'l' and 'o'
  d.keystroke('ian', 'l');
  assert.equal(only(d).text, 'hello');
  assert.equal(only(d).cursors.get('ian'), 4);
});

test('box ids are stable and distinct', () => {
  const d = new Drafts();
  d.keystroke('ian', 'a');
  d.keystroke('james', 'b');
  assert.notEqual(d.boxes[0].id, d.boxes[1].id);
});

// ── Enter / send semantics ────────────────────────────────────────────────────

test('Enter sends only the draft the cursor is in; other boxes are untouched', () => {
  const d = new Drafts();
  d.keystroke('ian', 'first');
  d.keystroke('james', 'second');
  const id = d.activeBox('ian').id;
  const eff = d.keystroke('ian', ENTER);
  assert.deepEqual(eff.send, { text: 'first', author: 'ian', authors: ['ian'], boxId: id });
  // ian's window box stays (emptied, ready for the next prompt); james's is untouched
  assert.equal(d.activeBox('ian').id, id, 'same box kept, not recreated');
  assert.equal(d.activeBox('ian').text, '');
  assert.equal(d.activeBox('james').text, 'second');
});

test('a sent draft vanishes and takes every cursor in it with it', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hi');
  const id = d.activeBox('ian').id;
  d.focus('james', id); // james co-edits ian's draft
  assert.equal(d.boxes[0].cursors.size, 2);
  d.keystroke('ian', ENTER);
  assert.equal(d.boxes.length, 0);
  assert.equal(d.activeBox('ian'), null);
  assert.equal(d.activeBox('james'), null);
});

test('racing Enters on one draft: first sends, second is a no-op', () => {
  const d = new Drafts();
  d.keystroke('ian', 'go');
  const id = d.activeBox('ian').id;
  d.focus('james', id);
  const first = d.keystroke('ian', ENTER);
  const second = d.keystroke('james', ENTER);
  assert.equal(first.send.text, 'go');
  assert.equal(second.send, null); // james' cursor left with the vanished box
  assert.equal(second.changed, false);
});

test('Enter on an empty draft never sends (nothing queues by accident)', () => {
  const d = new Drafts();
  d.startDraft('ian');
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send, null);
});

test('Enter with no active draft is a no-op', () => {
  const d = new Drafts();
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send, null);
  assert.equal(eff.changed, false);
});

test('a bare LF also sends (some terminals emit \\n for Enter)', () => {
  const d = new Drafts();
  d.keystroke('ian', 'yo');
  const eff = d.keystroke('ian', '\n');
  assert.equal(eff.send.text, 'yo');
});

test('after sending, the same user can start a fresh draft by typing', () => {
  const d = new Drafts();
  d.keystroke('ian', 'one');
  d.keystroke('ian', ENTER);
  d.keystroke('ian', 'two');
  assert.equal(only(d).text, 'two');
});

// A solo window box (unplaced, only its owner in it) is the per-user bottom-row
// composer: Enter empties it but keeps it, so the owner can fire the next prompt
// right away (it queues behind the running one) without falling through to Claude.
test('Enter on a solo window box keeps the (emptied) box so composing continues', () => {
  const d = new Drafts();
  d.keystroke('ian', 'first prompt');
  const id = d.activeBox('ian').id;
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send.text, 'first prompt'); // still sends
  const box = d.activeBox('ian');
  assert.ok(box, 'the window box is still there');
  assert.equal(box.id, id, 'same box, kept not recreated');
  assert.equal(box.text, '', 'emptied, ready for the next prompt');
  assert.equal(box.cursors.get('ian'), 0, 'caret back at the start');
});

test('Enter on a placed (floating) box still removes it', () => {
  const d = new Drafts();
  d.keystroke('ian', 'shared');
  const id = d.activeBox('ian').id;
  d.placeBox(id, { x: 0.2, y: 0.3 }); // dropped on the terminal → floating box
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send.text, 'shared');
  assert.equal(d.boxes.length, 0, 'a placed box is one-shot and vanishes on send');
  assert.equal(d.activeBox('ian'), null);
});

// ── starting a fresh draft (Ctrl+N) ──────────────────────────────────────────

const CTRL_N = '\x0e'; // start a new draft

test('Ctrl+N breaks a co-editor out into their own fresh empty draft', () => {
  const d = new Drafts();
  d.keystroke('ian', 'shared thought');
  const id = d.activeBox('ian').id;
  d.focus('james', id); // james is co-writing ian's box
  assert.equal(d.boxes[0].cursors.size, 2);

  const eff = d.keystroke('james', CTRL_N);
  assert.equal(eff.changed, true);
  // ian's box is untouched (still has content + ian's cursor); james now owns a new box.
  assert.equal(d.boxes.length, 2);
  assert.equal(d.boxes[0].id, id);
  assert.equal(d.boxes[0].text, 'shared thought');
  assert.ok(d.boxes[0].cursors.has('ian') && !d.boxes[0].cursors.has('james'));
  const jamesBox = d.activeBox('james');
  assert.notEqual(jamesBox.id, id);
  assert.equal(jamesBox.text, '');
  // …and james types into the fresh draft, not the shared one.
  d.keystroke('james', 'my own idea');
  assert.equal(d.activeBox('james').text, 'my own idea');
  assert.equal(d.boxes[0].text, 'shared thought');
});

test('Ctrl+N with an empty focused draft leaves the user in a (fresh) empty draft', () => {
  const d = new Drafts();
  d.keystroke('ian', 'abc');
  d.keystroke('ian', ENTER); // sent; ian now has no box
  const eff = d.keystroke('ian', CTRL_N);
  assert.equal(eff.changed, true);
  assert.equal(d.boxes.length, 1);
  assert.equal(d.activeBox('ian').text, '');
});

// ── multi-cursor co-editing ─────────────────────────────────────────────────

test('a user can move their cursor into an existing draft and co-write it', () => {
  const d = new Drafts();
  d.keystroke('ian', 'foo');
  const id = d.activeBox('ian').id;
  d.focus('james', id); // james joins at the end (pos 3)
  d.keystroke('james', 'bar');
  const box = only(d);
  assert.equal(box.text, 'foobar');
  assert.ok(box.authors.has('ian') && box.authors.has('james'));
  assert.equal(box.cursors.get('james'), 6);
});

test('one user typing shifts a co-editor cursor that sits after the insertion', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello'); // ian at 5
  const id = d.activeBox('ian').id;
  d.focus('james', id); // james at 5
  for (let i = 0; i < 5; i++) d.keystroke('james', LEFT); // james to 0
  assert.equal(only(d).cursors.get('james'), 0);
  d.keystroke('james', 'X'); // insert at 0 -> 'Xhello'
  const box = only(d);
  assert.equal(box.text, 'Xhello');
  assert.equal(box.cursors.get('james'), 1);
  assert.equal(box.cursors.get('ian'), 6); // ian pushed right by the insertion
});

test('a co-editor cursor before the insertion point stays put', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello'); // ian at 5
  const id = d.activeBox('ian').id;
  d.focus('james', id);
  for (let i = 0; i < 5; i++) d.keystroke('james', LEFT); // james at 0
  d.keystroke('ian', '!'); // ian inserts at 5 -> 'hello!'
  const box = only(d);
  assert.equal(box.text, 'hello!');
  assert.equal(box.cursors.get('james'), 0); // unmoved
  assert.equal(box.cursors.get('ian'), 6);
});

// ── the send attribution ─────────────────────────────────────────────────────

test('send is attributed to the sender, with every co-author listed', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hi ');
  const id = d.activeBox('ian').id;
  d.focus('james', id);
  d.keystroke('james', 'there');
  const eff = d.keystroke('james', ENTER); // james presses Enter
  assert.equal(eff.send.text, 'hi there');
  assert.equal(eff.send.author, 'james');
  assert.deepEqual([...eff.send.authors].sort(), ['ian', 'james']);
});

// ── editing keys ─────────────────────────────────────────────────────────────

test('backspace deletes the char before the cursor (both DEL and BS)', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello');
  d.keystroke('ian', BS);
  assert.equal(only(d).text, 'hell');
  d.keystroke('ian', BS_ALT);
  assert.equal(only(d).text, 'hel');
  assert.equal(only(d).cursors.get('ian'), 3);
});

test('backspace at position 0 is a no-op', () => {
  const d = new Drafts();
  d.keystroke('ian', 'x');
  d.keystroke('ian', LEFT);
  const eff = d.keystroke('ian', BS);
  assert.equal(only(d).text, 'x');
  assert.equal(eff.changed, false);
});

test('ctrl+w deletes the previous word, eating a trailing space first', () => {
  const d = new Drafts();
  d.keystroke('ian', 'foo bar');
  d.keystroke('ian', CTRL_W);
  assert.equal(only(d).text, 'foo ');
  const d2 = new Drafts();
  d2.keystroke('ian', 'foo bar ');
  d2.keystroke('ian', CTRL_W);
  assert.equal(only(d2).text, 'foo ');
});

test('option+backspace deletes the previous word too', () => {
  const d = new Drafts();
  d.keystroke('ian', 'alpha beta');
  d.keystroke('ian', ALT_BS);
  assert.equal(only(d).text, 'alpha ');
});

test('ctrl+u kills from the cursor back to the start of the line', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello world');
  d.keystroke('ian', CTRL_U);
  assert.equal(only(d).text, '');
  assert.equal(only(d).cursors.get('ian'), 0);
});

test('ctrl+u on a multi-line draft only kills the current line', () => {
  const d = new Drafts();
  d.keystroke('ian', 'ab');
  d.keystroke('ian', SHIFT_ENTER);
  d.keystroke('ian', 'cd'); // 'ab\ncd', cursor at end
  d.keystroke('ian', CTRL_U);
  assert.equal(only(d).text, 'ab\n');
});

test('ctrl+k kills from the cursor to the end of the line', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello');
  d.keystroke('ian', HOME);
  d.keystroke('ian', CTRL_K);
  assert.equal(only(d).text, '');
});

// ── cursor movement ──────────────────────────────────────────────────────────

test('left/right arrows move the cursor and clamp at the ends', () => {
  const d = new Drafts();
  d.keystroke('ian', 'ab');
  d.keystroke('ian', LEFT);
  assert.equal(only(d).cursors.get('ian'), 1);
  d.keystroke('ian', LEFT);
  assert.equal(only(d).cursors.get('ian'), 0);
  const eff = d.keystroke('ian', LEFT); // clamp
  assert.equal(only(d).cursors.get('ian'), 0);
  assert.equal(eff.changed, false);
  d.keystroke('ian', RIGHT);
  assert.equal(only(d).cursors.get('ian'), 1);
});

test('home/end move to the line boundaries (arrows, ctrl, and tilde forms)', () => {
  for (const [homeKey, endKey] of [
    [HOME, END],
    [CTRL_A, CTRL_E],
    [HOME_TILDE, END_TILDE],
  ]) {
    const d = new Drafts();
    d.keystroke('ian', 'hello');
    d.keystroke('ian', homeKey);
    assert.equal(only(d).cursors.get('ian'), 0, `home via ${JSON.stringify(homeKey)}`);
    d.keystroke('ian', endKey);
    assert.equal(only(d).cursors.get('ian'), 5, `end via ${JSON.stringify(endKey)}`);
  }
});

test('home/end respect line boundaries in a multi-line draft', () => {
  const d = new Drafts();
  d.keystroke('ian', 'ab');
  d.keystroke('ian', SHIFT_ENTER);
  d.keystroke('ian', 'cd'); // 'ab\ncd', cursor at 5
  d.keystroke('ian', HOME);
  assert.equal(only(d).cursors.get('ian'), 3); // start of second line
  d.keystroke('ian', END);
  assert.equal(only(d).cursors.get('ian'), 5);
});

test('option+arrow jumps by word (ESC b / ESC f and CSI forms)', () => {
  for (const [wl, wr] of [
    [WORD_LEFT, WORD_RIGHT],
    [WORD_LEFT_CSI, WORD_RIGHT_CSI],
  ]) {
    const d = new Drafts();
    d.keystroke('ian', 'foo bar baz'); // cursor at 11
    d.keystroke('ian', wl);
    assert.equal(only(d).cursors.get('ian'), 8, 'to start of baz');
    d.keystroke('ian', wl);
    assert.equal(only(d).cursors.get('ian'), 4, 'to start of bar');
    d.keystroke('ian', wr);
    assert.equal(only(d).cursors.get('ian'), 7, 'to end of bar');
  }
});

// ── shift+enter newline ──────────────────────────────────────────────────────

test('shift+enter inserts a newline instead of sending (all encodings)', () => {
  for (const se of [SHIFT_ENTER, SHIFT_ENTER_KITTY, SHIFT_ENTER_CSIU]) {
    const d = new Drafts();
    d.keystroke('ian', 'line1');
    const eff = d.keystroke('ian', se);
    assert.equal(eff.send, null, `${JSON.stringify(se)} must not send`);
    d.keystroke('ian', 'line2');
    assert.equal(only(d).text, 'line1\nline2');
  }
});

test('a multi-line draft sends its full text on Enter', () => {
  const d = new Drafts();
  d.keystroke('ian', 'a');
  d.keystroke('ian', SHIFT_ENTER);
  d.keystroke('ian', 'b');
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send.text, 'a\nb');
});

// ── paste collapse ───────────────────────────────────────────────────────────

test('a bracketed paste collapses to a [pasted N lines] token', () => {
  const d = new Drafts();
  d.keystroke('ian', paste('l1\nl2\nl3'));
  const box = only(d);
  assert.equal(box.text, '[pasted 3 lines]');
  assert.equal(box.cursors.get('ian'), 1); // the whole paste is one cursor unit
});

test('a single-line paste reads "1 line"', () => {
  const d = new Drafts();
  d.keystroke('ian', paste('just one'));
  assert.equal(only(d).text, '[pasted 1 line]');
});

test('an image-path paste collapses to an [image] chip and expands on send', () => {
  const d = new Drafts();
  d.keystroke('ian', 'look: ');
  d.keystroke('ian', paste('/tmp/claudecollab-1.png'));
  const box = only(d);
  assert.equal(box.text, 'look: [image]');
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send.text, 'look: /tmp/claudecollab-1.png');
});

test('the paste token expands to the real text only when sent', () => {
  const d = new Drafts();
  d.keystroke('ian', 'see: ');
  d.keystroke('ian', paste('x\ny'));
  d.keystroke('ian', ' end');
  const box = only(d);
  assert.equal(box.text, 'see: [pasted 2 lines] end');
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send.text, 'see: x\ny end');
});

test('backspace removes a whole paste token as one unit', () => {
  const d = new Drafts();
  d.keystroke('ian', paste('a\nb'));
  d.keystroke('ian', BS);
  assert.equal(d.boxes[0]?.text ?? '', '');
});

test('a bracketed paste split across two keystroke calls is joined', () => {
  const d = new Drafts();
  d.keystroke('ian', '\x1b[200~a\nb\n'); // opens paste, no close yet
  assert.equal(d.boxes.length, 0, 'nothing committed until the paste closes');
  d.keystroke('ian', 'c\x1b[201~'); // closes it
  const box = only(d);
  assert.equal(box.text, '[pasted 3 lines]');
  const eff = d.keystroke('ian', ENTER);
  assert.equal(eff.send.text, 'a\nb\nc');
});

// ── box navigation (up/down between drafts) ──────────────────────────────────

test('up/down move the cursor between drafts', () => {
  const d = new Drafts();
  d.keystroke('ian', 'aaa'); // box 0
  d.keystroke('james', 'bbb'); // box 1
  const id0 = d.boxes[0].id;
  const id1 = d.boxes[1].id;
  d.keystroke('ian', DOWN); // ian moves from box 0 to box 1
  assert.equal(d.activeBox('ian').id, id1);
  assert.equal(d.boxes[1].cursors.get('ian'), 3); // at end of 'bbb'
  d.keystroke('ian', UP); // back to box 0
  assert.equal(d.activeBox('ian').id, id0);
});

test('down at the last draft is a no-op', () => {
  const d = new Drafts();
  d.keystroke('ian', 'only');
  const eff = d.keystroke('ian', DOWN);
  assert.equal(eff.changed, false);
  assert.equal(d.activeBox('ian').text, 'only');
});

// ── mention autocomplete ─────────────────────────────────────────────────────

test('typing @ at a word boundary opens the mention autocomplete', () => {
  const d = new Drafts();
  const eff = d.keystroke('ian', 'hey @');
  assert.deepEqual(eff.mention, { query: '', start: 4, boxId: d.boxes[0].id });
});

test('mention query grows as you type and closes on a space', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hey @');
  let eff = d.keystroke('ian', 'si');
  assert.equal(eff.mention.query, 'si');
  eff = d.keystroke('ian', ' ');
  assert.equal(eff.mention, null);
});

test('@ in the middle of a word does NOT open a mention', () => {
  const d = new Drafts();
  const eff = d.keystroke('ian', 'a@b');
  assert.equal(eff.mention, null);
  assert.equal(d.mentionOf('ian'), null);
});

test('backspacing the @ closes the mention', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hi @s');
  assert.equal(d.mentionOf('ian').query, 's');
  d.keystroke('ian', BS); // remove 's'
  assert.equal(d.mentionOf('ian').query, '');
  d.keystroke('ian', BS); // remove '@'
  assert.equal(d.mentionOf('ian'), null);
});

test('completeMention replaces @query with @name and a trailing space', () => {
  const d = new Drafts();
  d.keystroke('ian', 'ping @si');
  const res = d.completeMention('ian', 'siddh');
  assert.equal(res.changed, true);
  assert.equal(only(d).text, 'ping @siddh ');
  assert.equal(only(d).cursors.get('ian'), 12);
  assert.equal(d.mentionOf('ian'), null); // closed after completion
});

test('completeMention with no open mention does nothing', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello');
  const res = d.completeMention('ian', 'siddh');
  assert.equal(res.changed, false);
  assert.equal(only(d).text, 'hello');
});

// ── escape & unknown control bytes ───────────────────────────────────────────

test('a lone escape is not inserted and does not send', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hi');
  const eff = d.keystroke('ian', ESC);
  assert.equal(only(d).text, 'hi');
  assert.equal(eff.send, null);
});

test('unhandled control bytes (NUL, tab) are dropped, not inserted', () => {
  const d = new Drafts();
  d.keystroke('ian', 'a\x00\tb');
  assert.equal(only(d).text, 'ab');
});

// ── leaving / cleanup ────────────────────────────────────────────────────────

test('removeUser drops the cursor and prunes an empty draft', () => {
  const d = new Drafts();
  d.startDraft('ian');
  assert.equal(d.boxes.length, 1);
  d.removeUser('ian');
  assert.equal(d.boxes.length, 0);
});

test('removeUser keeps a draft that already has content', () => {
  const d = new Drafts();
  d.keystroke('ian', 'work in progress');
  d.removeUser('ian');
  assert.equal(d.boxes.length, 1);
  assert.equal(d.boxes[0].cursors.size, 0);
  assert.equal(d.boxes[0].text, 'work in progress');
});

// ── snapshot ─────────────────────────────────────────────────────────────────

test('snapshot serialises boxes with text, expanded text, cursors, and authors', () => {
  const d = new Drafts();
  d.keystroke('ian', 'q: ');
  d.keystroke('ian', paste('x\ny'));
  const snap = d.snapshot();
  assert.equal(snap.boxes.length, 1);
  const b = snap.boxes[0];
  assert.equal(b.text, 'q: [pasted 2 lines]');
  assert.equal(b.expanded, 'q: x\ny');
  assert.deepEqual(b.cursors, { ian: 4 });
  assert.deepEqual(b.authors, ['ian']);
});

test('snapshot exposes caretOffsets as display-text offsets (paste-aware)', () => {
  const d = new Drafts();
  d.keystroke('ian', 'q: '); // 3 char atoms
  d.keystroke('ian', paste('x\ny')); // one paste atom → cursor at atom index 4
  const b = d.snapshot().boxes[0];
  assert.deepEqual(b.cursors, { ian: 4 }, 'raw atom index preserved');
  assert.equal(b.text, 'q: [pasted 2 lines]');
  // …but the caret offset is the DISPLAY position (end of the collapsed token),
  // not the atom index — what the renderer needs to place the block.
  assert.equal(b.caretOffsets.ian, b.text.length);
});

test('caretOffsets tracks each co-editor cursor independently', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello'); // ian at 5
  const id = d.activeBox('ian').id;
  d.focus('james', id); // james at 5
  for (let i = 0; i < 5; i++) d.keystroke('james', LEFT); // james to 0
  const b = d.snapshot().boxes[0];
  assert.equal(b.caretOffsets.ian, 5);
  assert.equal(b.caretOffsets.james, 0);
});

test('Buffer input is accepted, not just strings', () => {
  const d = new Drafts();
  d.keystroke('ian', Buffer.from('hi', 'utf8'));
  assert.equal(only(d).text, 'hi');
});

// ── placeCaret (a browser mouse click inside a draft) ─────────────────────────

test('placeCaret puts the caret at a display offset in the clicked box', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello world');
  const id = d.activeBox('ian').id;
  assert.equal(d.placeCaret('ian', id, 5), true);
  assert.equal(d.cursorOf('ian').pos, 5);
  d.placeCaret('ian', id, 999); // past the end clamps to the end
  assert.equal(d.cursorOf('ian').pos, 11);
});

test('placeCaret joins another box (leaving the old one) — click-to-co-write', () => {
  const d = new Drafts();
  d.keystroke('ian', 'first');
  const target = d.activeBox('ian').id;
  d.keystroke('james', 'second');
  assert.equal(d.placeCaret('james', target, 2), true);
  assert.equal(d.cursorOf('james').boxId, target);
  assert.equal(d.cursorOf('james').pos, 2);
  assert.equal(d.boxes.length, 2); // james' own non-empty draft survives
});

test('placeCaret snaps to a paste token edge, never inside it', () => {
  const d = new Drafts();
  d.keystroke('ian', 'a\x1b[200~two\nlines\x1b[201~b'); // atoms: a, [paste], b
  const box = d.activeBox('ian');
  const tokenWidth = '[pasted 2 lines]'.length;
  d.placeCaret('ian', box.id, 1 + 2); // 2 chars into the token → nearest edge (start)
  assert.equal(d.cursorOf('ian').pos, 1);
  d.placeCaret('ian', box.id, 1 + tokenWidth - 2); // near its far edge → after it
  assert.equal(d.cursorOf('ian').pos, 2);
  assert.equal(d.placeCaret('ian', 'nope', 0), false); // unknown box refused
});

test('deleteRange removes a display range and parks the caret at its start', () => {
  const d = new Drafts();
  d.keystroke('ian', 'hello world');
  const id = d.activeBox('ian').id;
  assert.equal(d.deleteRange('ian', id, 3, 8), true);
  assert.equal(d.activeBox('ian').text, 'helrld');
  assert.equal(d.cursorOf('ian').pos, 3);
  assert.equal(d.deleteRange('ian', id, 9, 2), true); // reversed endpoints normalise
  assert.equal(d.activeBox('ian').text, 'he');
  assert.equal(d.deleteRange('ian', 'nope', 0, 1), false);
});

test('deleteRange takes a partially covered paste token out whole', () => {
  const d = new Drafts();
  d.keystroke('ian', 'a\x1b[200~two\nlines\x1b[201~b'); // atoms: a, [pasted 2 lines], b
  const box = d.activeBox('ian');
  d.deleteRange('ian', box.id, 3, 6); // a range strictly inside the token's display
  assert.equal(box.text, 'ab');
  assert.equal(d.cursorOf('ian').pos, 1);
});

test('deleteBox removes a whole draft, cursors and all', () => {
  const d = new Drafts();
  d.keystroke('ian', 'doomed');
  const id = d.activeBox('ian').id;
  d.focus('james', id);
  assert.equal(d.deleteBox(id), true);
  assert.equal(d.boxes.length, 0);
  assert.equal(d.activeBox('ian'), null);
  assert.equal(d.activeBox('james'), null);
  assert.equal(d.deleteBox('nope'), false);
});

test('placeBox stores shared, clamped stage fractions; null goes home', () => {
  const d = new Drafts();
  const id = d.startDraft('ian');
  assert.equal(d.placeBox(id, { x: 0.25, y: 1.7, w: 0.4 }), true);
  assert.deepEqual(d.boxes[0].place, { x: 0.25, y: 1, w: 0.4 });
  assert.ok(d.snapshot().boxes[0].place, 'placement rides the snapshot');
  d.placeBox(id, null);
  assert.equal(d.boxes[0].place, null);
  assert.equal(d.placeBox('nope', { x: 0, y: 0 }), false);
});

test('seedDraft starts a focused draft pre-filled with the text', () => {
  const d = new Drafts();
  const id = d.seedDraft('ian', 'fix the nav\nthen tests');
  const box = d.activeBox('ian');
  assert.equal(box.id, id);
  assert.equal(box.text, 'fix the nav\nthen tests');
  assert.equal(d.cursorOf('ian').pos, box.atoms.length, 'caret lands at the end');
});
