// The draft-lines state machine — the shared composer at the heart of the wow
// moment (spec §draft lines). It is pure logic: raw terminal bytes in, box/cursor
// state out, no terminal and no I/O. The renderer (Task 7) reads snapshot(); the
// per-role gate (Task 7) decides who is allowed to feed keystrokes here at all —
// this module trusts its caller and only models the editor.
//
// Model (spec: "a small shared scratchpad, not a single line"):
//   • The pad is an ordered list of BOXES, one per draft.
//   • Each box is a sequence of ATOMS — one atom is either a single character or a
//     collapsed paste token. Paste stays a single atom (one cursor unit) until the
//     draft is sent, then it expands to its real text ("expands only when sent").
//   • Each user has at most one cursor, living in exactly one box (their focus).
//     Moving a cursor into another box = joining it to co-write (Google-Docs style).
//
// Key rules the tests pin down:
//   • Enter sends ONLY the box the cursor is in; every other box is untouched.
//   • Racing Enter: the box vanishes on the first send taking all its cursors, so a
//     second Enter from a co-editor finds no focus and no-ops.
//   • An empty draft never sends (nothing queues by accident).
//   • Standard editing keymap: shift+enter newline, word-jump, kill-line, ctrl+w,
//     home/end — decoded from the raw escape bytes a terminal actually emits.
//   • Typing "@" at a word boundary opens a mention autocomplete (derived state,
//     read via mentionOf / the keystroke effect; completeMention fills it in).

// ── raw-byte vocabulary ─────────────────────────────────────────────────────
// Bracketed paste brackets its payload; we buffer between these markers (possibly
// across several keystroke() calls) and collapse the whole thing to one atom.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Every recognised key sequence → an internal action. Order is irrelevant: we sort
// by length descending and take the longest prefix match, so a lone ESC ('\x1b')
// only wins when no longer escape sequence applies.
const SEQUENCES = [
  // shift+enter (newline within a draft) — the encodings /terminal-setup produces
  ['\x1b\r', 'newline'],
  ['\x1b\n', 'newline'],
  ['\x1b[13;2u', 'newline'], // kitty keyboard protocol
  ['\x1b[27;2;13~', 'newline'], // CSI-u legacy form
  // Enter → send
  ['\r', 'enter'],
  ['\n', 'enter'],
  // word operations (option/alt + arrow, and ctrl+arrow) and option+backspace
  ['\x1bb', 'wordleft'],
  ['\x1bf', 'wordright'],
  ['\x1b[1;3D', 'wordleft'],
  ['\x1b[1;3C', 'wordright'],
  ['\x1b[1;5D', 'wordleft'],
  ['\x1b[1;5C', 'wordright'],
  ['\x1b\x7f', 'delword'], // option/alt + backspace
  ['\x17', 'delword'], // ctrl+w
  // deletion
  ['\x7f', 'backspace'],
  ['\x08', 'backspace'],
  ['\x15', 'killstart'], // ctrl+u
  ['\x0b', 'killend'], // ctrl+k
  // cursor movement
  ['\x1b[H', 'home'],
  ['\x1bOH', 'home'],
  ['\x1b[1~', 'home'],
  ['\x01', 'home'], // ctrl+a
  ['\x1b[F', 'end'],
  ['\x1bOF', 'end'],
  ['\x1b[4~', 'end'],
  ['\x05', 'end'], // ctrl+e
  ['\x1b[D', 'left'],
  ['\x1bOD', 'left'],
  ['\x1b[C', 'right'],
  ['\x1bOC', 'right'],
  ['\x1b[A', 'up'],
  ['\x1bOA', 'up'],
  ['\x1b[B', 'down'],
  ['\x1bOB', 'down'],
  // a lone escape: dismissed (never inserted). Must be last / shortest.
  ['\x1b', 'escape'],
].sort((a, b) => b[0].length - a[0].length);

// Characters that count as part of an @mention query (letters, digits, _ and -).
const MENTION_CHAR = /[\p{L}\p{N}_-]/u;
const isMentionChar = (atom) => typeof atom === 'string' && MENTION_CHAR.test(atom);
const isWordChar = (atom) => isMentionChar(atom); // same class for word-jump/delete
const isSpace = (atom) => typeof atom === 'string' && /\s/.test(atom) && atom !== '\n';
const isPaste = (atom) => atom != null && typeof atom === 'object' && atom.paste === true;

// ── atom → text helpers ──────────────────────────────────────────────────────
const atomDisplay = (a) => (isPaste(a) ? `[pasted ${a.lines} line${a.lines === 1 ? '' : 's'}]` : a);
const atomReal = (a) => (isPaste(a) ? a.text : a);
const displayText = (box) => box.atoms.map(atomDisplay).join('');
const expandedText = (box) => box.atoms.map(atomReal).join('');

// Line boundaries inside a (possibly multi-line) draft, delimited by '\n' atoms.
function lineStart(atoms, pos) {
  let i = pos;
  while (i > 0 && atoms[i - 1] !== '\n') i--;
  return i;
}
function lineEnd(atoms, pos) {
  let i = pos;
  while (i < atoms.length && atoms[i] !== '\n') i++;
  return i;
}
// Previous / next word boundary — skip whitespace, then a run of word chars OR a
// single paste atom (a paste is one indivisible word).
function wordLeft(atoms, pos) {
  let i = pos;
  while (i > 0 && isSpace(atoms[i - 1])) i--;
  if (i > 0 && isPaste(atoms[i - 1])) return i - 1;
  while (i > 0 && isWordChar(atoms[i - 1])) i--;
  return i;
}
function wordRight(atoms, pos) {
  let i = pos;
  while (i < atoms.length && isSpace(atoms[i])) i++;
  if (i < atoms.length && isPaste(atoms[i])) return i + 1;
  while (i < atoms.length && isWordChar(atoms[i])) i++;
  return i;
}

// Split a string into atoms, one per Unicode code point (so astral chars stay whole).
const toCharAtoms = (str) => [...str];

export class Drafts {
  /** @type {{id:string, atoms:Array, cursors:Map<string,number>, authors:Set<string>}[]} */
  boxes = [];
  #seq = 0;
  // Buffered bracketed-paste payload while we wait for PASTE_END; null when idle.
  #pasting = new Map(); // userId -> string buffer

  // ── public reads ────────────────────────────────────────────────────────────

  /** The box a user's cursor is in, or null. */
  activeBox(userId) {
    for (const b of this.boxes) if (b.cursors.has(userId)) return b;
    return null;
  }

  /** {boxId, pos} for a user's cursor, or null. */
  cursorOf(userId) {
    const b = this.activeBox(userId);
    return b ? { boxId: b.id, pos: b.cursors.get(userId) } : null;
  }

  /**
   * The open @mention autocomplete for a user, or null. Derived from cursor context:
   * open when the cursor sits in a run of mention chars immediately after an "@"
   * that itself starts the box or follows whitespace/newline.
   * @returns {{query:string, start:number, boxId:string}|null}
   */
  mentionOf(userId) {
    const box = this.activeBox(userId);
    if (!box) return null;
    const pos = box.cursors.get(userId);
    let i = pos;
    while (i > 0 && isMentionChar(box.atoms[i - 1])) i--;
    if (i === 0 || box.atoms[i - 1] !== '@') return null;
    const before = box.atoms[i - 2];
    const atBoundary = i - 1 === 0 || isSpace(before) || before === '\n';
    if (!atBoundary) return null;
    return { query: box.atoms.slice(i, pos).join(''), start: i - 1, boxId: box.id };
  }

  /** Renderer-facing serialisation: plain objects only, no Map/Set. */
  snapshot() {
    return {
      boxes: this.boxes.map((b) => ({
        id: b.id,
        text: displayText(b),
        expanded: expandedText(b),
        cursors: Object.fromEntries(b.cursors),
        authors: [...b.authors],
      })),
    };
  }

  // ── explicit focus commands (used by the renderer / commands wiring) ─────────

  /** Start a fresh empty draft and focus this user in it; returns the new box id. */
  startDraft(userId) {
    this.#leaveCurrent(userId);
    return this.#attach(userId).id;
  }

  /** Move a user's cursor into an existing draft to co-write it. */
  focus(userId, boxId) {
    const target = this.#boxById(boxId);
    if (!target) return false;
    if (this.activeBox(userId) === target) return true;
    this.#leaveCurrent(userId);
    target.cursors.set(userId, target.atoms.length);
    return true;
  }

  /** Fill an open @mention with @name plus a trailing space; closes the mention. */
  completeMention(userId, name) {
    const m = this.mentionOf(userId);
    if (!m) return { changed: false };
    const box = this.#boxById(m.boxId);
    const pos = box.cursors.get(userId);
    this.#splice(box, m.start, pos - m.start, toCharAtoms(`@${name} `), userId);
    box.authors.add(userId);
    return { changed: true };
  }

  /** A user left the room: drop their cursor and prune the draft if it's now empty. */
  removeUser(userId) {
    const box = this.activeBox(userId);
    if (!box) return;
    box.cursors.delete(userId);
    this.#prune(box);
  }

  // ── the keystroke pump ───────────────────────────────────────────────────────

  /**
   * Feed one input event (a chunk of raw terminal bytes) from a user.
   * @param {string|Buffer} bytes
   * @returns {{send: null|{text:string, author:string, authors:string[], boxId:string},
   *            mention: null|{query:string,start:number,boxId:string},
   *            changed: boolean}}
   */
  keystroke(userId, bytes) {
    const s = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    let send = null;
    let changed = false;
    let i = 0;

    while (i < s.length) {
      // Mid-paste: swallow bytes until the closing marker (may span calls).
      if (this.#pasting.has(userId)) {
        const end = s.indexOf(PASTE_END, i);
        if (end === -1) {
          this.#pasting.set(userId, this.#pasting.get(userId) + s.slice(i));
          i = s.length;
        } else {
          this.#pasting.set(userId, this.#pasting.get(userId) + s.slice(i, end));
          this.#commitPaste(userId);
          changed = true;
          i = end + PASTE_END.length;
        }
        continue;
      }
      if (s.startsWith(PASTE_START, i)) {
        this.#pasting.set(userId, '');
        i += PASTE_START.length;
        continue;
      }

      const match = matchSequence(s, i);
      if (match) {
        const r = this.#apply(userId, match.type);
        if (r.send) send = r.send;
        if (r.changed) changed = true;
        i += match.seq.length;
        continue;
      }

      // A printable code point (keep astral characters whole).
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      // Unhandled control byte (NUL, tab, stray C0/DEL): drop it, never insert.
      if (cp < 0x20 || cp === 0x7f) continue;
      this.#insert(userId, [ch]);
      changed = true;
    }

    return { send, mention: this.mentionOf(userId), changed };
  }

  // ── key handlers ──────────────────────────────────────────────────────────────

  #apply(userId, type) {
    switch (type) {
      case 'enter':
        return this.#enter(userId);
      case 'newline':
        this.#insert(userId, ['\n']);
        return { changed: true };
      case 'backspace':
        return this.#backspace(userId);
      case 'delword':
        return this.#deleteRange(userId, (atoms, pos) => wordLeft(atoms, pos), 'back');
      case 'killstart':
        return this.#deleteRange(userId, (atoms, pos) => lineStart(atoms, pos), 'back');
      case 'killend':
        return this.#deleteRange(userId, (atoms, pos) => lineEnd(atoms, pos), 'fwd');
      case 'home':
        return this.#moveTo(userId, (atoms, pos) => lineStart(atoms, pos));
      case 'end':
        return this.#moveTo(userId, (atoms, pos) => lineEnd(atoms, pos));
      case 'left':
        return this.#moveTo(userId, (atoms, pos) => Math.max(0, pos - 1));
      case 'right':
        return this.#moveTo(userId, (atoms, pos) => Math.min(atoms.length, pos + 1));
      case 'wordleft':
        return this.#moveTo(userId, (atoms, pos) => wordLeft(atoms, pos));
      case 'wordright':
        return this.#moveTo(userId, (atoms, pos) => wordRight(atoms, pos));
      case 'up':
        return { changed: this.#moveBox(userId, -1) };
      case 'down':
        return { changed: this.#moveBox(userId, 1) };
      case 'escape':
      default:
        return { changed: false };
    }
  }

  #enter(userId) {
    const box = this.activeBox(userId);
    if (!box || box.atoms.length === 0) return { send: null, changed: false };
    const send = { text: expandedText(box), author: userId, authors: [...box.authors], boxId: box.id };
    this.boxes = this.boxes.filter((b) => b !== box); // the sent draft vanishes, cursors and all
    return { send, changed: true };
  }

  #backspace(userId) {
    const box = this.activeBox(userId);
    if (!box) return { changed: false };
    const pos = box.cursors.get(userId);
    if (pos <= 0) return { changed: false };
    this.#splice(box, pos - 1, 1, [], userId);
    box.authors.add(userId);
    return { changed: true };
  }

  // Delete between the cursor and a computed boundary (backward or forward).
  #deleteRange(userId, boundary, dir) {
    const box = this.activeBox(userId);
    if (!box) return { changed: false };
    const pos = box.cursors.get(userId);
    const edge = boundary(box.atoms, pos);
    const [start, count] = dir === 'back' ? [edge, pos - edge] : [pos, edge - pos];
    if (count <= 0) return { changed: false };
    this.#splice(box, start, count, [], userId);
    box.authors.add(userId);
    return { changed: true };
  }

  #moveTo(userId, compute) {
    const box = this.activeBox(userId);
    if (!box) return { changed: false };
    const pos = box.cursors.get(userId);
    const next = compute(box.atoms, pos);
    if (next === pos) return { changed: false };
    box.cursors.set(userId, next);
    return { changed: true };
  }

  // Up/Down hop the cursor to the neighbouring draft (end of it), joining to co-write.
  #moveBox(userId, dir) {
    const box = this.activeBox(userId);
    if (!box) return false;
    const idx = this.boxes.indexOf(box);
    const nidx = idx + dir;
    if (nidx < 0 || nidx >= this.boxes.length) return false;
    const target = this.boxes[nidx]; // reference captured before any pruning
    box.cursors.delete(userId);
    this.#prune(box);
    target.cursors.set(userId, target.atoms.length);
    return true;
  }

  // ── low-level mutation ─────────────────────────────────────────────────────────

  #insert(userId, atoms) {
    const box = this.#ensureBox(userId);
    const pos = box.cursors.get(userId);
    this.#splice(box, pos, 0, atoms, userId);
    box.authors.add(userId);
  }

  #commitPaste(userId) {
    const raw = this.#pasting.get(userId) ?? '';
    this.#pasting.delete(userId);
    const lines = raw === '' ? 0 : raw.split('\n').length;
    this.#insert(userId, [{ paste: true, text: raw, lines }]);
  }

  // Splice atoms in a box and re-home every cursor consistently (multi-cursor safe).
  // The acting user's cursor lands just after the inserted atoms; a co-editor cursor
  // strictly before the edit stays put, one after it shifts by the size delta, and
  // one inside a deleted region collapses to the edit start.
  #splice(box, start, deleteCount, insert, actingUser) {
    box.atoms.splice(start, deleteCount, ...insert);
    const ins = insert.length;
    for (const [uid, p] of box.cursors) {
      if (uid === actingUser) continue;
      let np = p;
      if (p <= start) np = p;
      else if (p >= start + deleteCount) np = p + (ins - deleteCount);
      else np = start + ins;
      box.cursors.set(uid, np);
    }
    if (actingUser != null && box.cursors.has(actingUser)) {
      box.cursors.set(actingUser, start + ins);
    }
  }

  // ── box lifecycle ──────────────────────────────────────────────────────────────

  #boxById(id) {
    return this.boxes.find((b) => b.id === id) ?? null;
  }

  #ensureBox(userId) {
    return this.activeBox(userId) ?? this.#attach(userId);
  }

  #attach(userId) {
    const box = { id: `d${++this.#seq}`, atoms: [], cursors: new Map([[userId, 0]]), authors: new Set() };
    // `text` (collapsed display) and `expanded` (real, paste-expanded) are live
    // getters over atoms, so callers and the renderer read them without a method.
    Object.defineProperty(box, 'text', { enumerable: true, get: () => displayText(box) });
    Object.defineProperty(box, 'expanded', { enumerable: true, get: () => expandedText(box) });
    this.boxes.push(box);
    return box;
  }

  #leaveCurrent(userId) {
    const cur = this.activeBox(userId);
    if (!cur) return;
    cur.cursors.delete(userId);
    this.#prune(cur);
  }

  // A draft with no content and nobody's cursor in it is gone (empty orphan).
  #prune(box) {
    if (box.atoms.length === 0 && box.cursors.size === 0) {
      this.boxes = this.boxes.filter((b) => b !== box);
    }
  }
}

/** Longest-prefix match of a recognised key sequence at s[i], or null. */
function matchSequence(s, i) {
  for (const [seq, type] of SEQUENCES) {
    if (s.startsWith(seq, i)) return { seq, type };
  }
  return null;
}
