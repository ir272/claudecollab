// The claude-share browser client — the one multiplayer surface for everyone, the
// host included (design v2 verdict). It is a plain ESM module, no framework, no
// build step: index.html loads the vendored xterm bundle (a classic <script> that
// puts `Terminal` on the global) and then this file as `<script type="module">`.
//
// Two halves live here:
//
//   1. PURE view-model helpers (exported, DOM-free) — they turn the host's overlay
//      snapshot ({t:'state'} .data) into exactly what the DOM renders, translate a
//      keypress into the terminal bytes the host brain expects, and parse the join
//      URL. These are unit-tested in node (client.test.js) with no browser.
//
//   2. The browser app (guarded so importing this module in node runs no DOM code):
//      the join/knock/waiting/live screens, the xterm mirror, the floating-cursor
//      overlay, the draft tray, and the host-only controls.
//
// The brain stays the single authority (it lives in the host CLI). This client never
// edits a draft locally — it mails keystrokes as {t:'key'} and RENDERS the drafts the
// host sends back. Same for everything else: buttons emit {t:'ui', action} and the
// role gate in the brain still governs. We are views + labeled input sources.

// ── wire constants (must match the host brain / drafts.js keymap) ──────────────
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
export const NEW_DRAFT_BYTES = '\x0e'; // Ctrl+N — "start a fresh draft"

// ════════════════════════════════════════════════════════════════════════════
// PURE HELPERS (exported; no DOM, no globals — safe to import in node)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse the browser location into the fields the join flow needs.
 * @param {{pathname?:string, search?:string}|string} loc  window.location (or a URL string)
 * @returns {{code:string, hostToken:string|null, isHostTab:boolean}}
 */
export function parseLocation(loc) {
  let pathname = '/';
  let search = '';
  if (typeof loc === 'string') {
    const u = new URL(loc, 'http://x');
    pathname = u.pathname;
    search = u.search;
  } else if (loc && typeof loc === 'object') {
    pathname = loc.pathname || '/';
    search = loc.search || '';
  }
  // The room code is the single path segment (/brave-otter). Nothing else is routed
  // to a code, so anything with a slash or a dot (a served asset) yields no code.
  const seg = decodeURIComponent(pathname.replace(/^\/+/, ''));
  const code = seg && !seg.includes('/') && !seg.includes('.') ? seg : '';
  const params = new URLSearchParams(search);
  const hostToken = params.get('host');
  return { code, hostToken: hostToken || null, isHostTab: !!hostToken };
}

/**
 * Build the `/ws` query the web door expects. A host tab carries `host`; a guest
 * carries its browser `token` (returning identity), claimed `name`, and — for a
 * passworded room — the join password `pass` (host tabs never need one).
 * @returns {string} e.g. "/ws?room=brave-otter&name=sid&token=abc"
 */
export function buildWsPath({ code, name, token, hostToken, pass, seat } = {}) {
  const q = new URLSearchParams();
  if (code) q.set('room', code);
  if (name) q.set('name', name);
  if (hostToken) q.set('host', hostToken);
  else if (token) q.set('token', token);
  if (pass && !hostToken) q.set('pass', pass);
  // The host-seat secret binds the host seat to THIS browser (leaked-link defense):
  // it never rides the shareable URL — the browser mints it and keeps it locally —
  // so a stolen host link opened elsewhere presents a different seat and is refused.
  if (seat && hostToken) q.set('seat', seat);
  return '/ws?' + q.toString();
}

/** UTF-8 → base64, in node (Buffer) or the browser (TextEncoder + btoa). */
export function b64encode(str) {
  const s = String(str);
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Translate a keydown into the raw terminal bytes the host's draft editor decodes
 * (drafts.js SEQUENCES). Returns null for keys we don't drive — the caller lets the
 * browser keep those (Ctrl/Cmd shortcuts are never hijacked). We deliberately keep
 * this to a browser-safe subset: Ctrl+N/W/U (new-window/close-tab/view-source) are
 * offered as buttons instead of stolen keystrokes.
 * @param {{key:string, shiftKey?:boolean, altKey?:boolean, ctrlKey?:boolean, metaKey?:boolean}} e
 * @returns {string|null}
 */
export function keyToBytes(e = {}) {
  const { key } = e;
  if (!key) return null;
  // The mac editing chords, translated to the readline bytes the draft editor
  // decodes: ⌘⌫ kill-to-line-start, ⌘←/→ home/end. Everything else with Ctrl/Cmd
  // stays with the browser (copy/paste/reload are never hijacked).
  if (e.metaKey && !e.ctrlKey && !e.altKey) {
    switch (key) {
      case 'Backspace':
        return '\x15';
      case 'ArrowLeft':
        return '\x1b[H';
      case 'ArrowRight':
        return '\x1b[F';
      default:
        return null;
    }
  }
  if (e.ctrlKey || e.metaKey) return null;
  switch (key) {
    case 'Enter':
      return e.shiftKey ? '\x1b\r' : '\r'; // shift+enter = newline within the draft
    case 'Backspace':
      return e.altKey ? '\x1b\x7f' : '\x7f'; // alt+backspace = delete word
    case 'ArrowLeft':
      return e.altKey ? '\x1b[1;3D' : '\x1b[D';
    case 'ArrowRight':
      return e.altKey ? '\x1b[1;3C' : '\x1b[C';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'Escape':
      return '\x1b'; // interrupts Claude's turn (gate: prompter and up)
    default:
      break;
  }
  // A single printable character (no modifier that would make it a shortcut).
  if (!e.altKey && [...key].length === 1) return key;
  return null;
}

/** Wrap pasted text in the bracketed-paste guards the brain collapses to a token. */
export function pasteBytes(text) {
  return PASTE_START + String(text ?? '') + PASTE_END;
}

/**
 * Roster actions carry the target's PARTICIPANT id, never its claimed display name.
 * Names are guest-claimed and non-unique (a second guest can claim an existing name),
 * and a name with spaces or non-word characters can't be @-mentioned at all — so a
 * name-based /role or /kick could hit the wrong person or nobody. The id is unambiguous
 * and the brain applies it directly, bypassing @-mention resolution (finding 4).
 * @param {string} id    the participant id (from the overlay state)
 * @param {string} role  prompter | viewer
 */
export function roleAction(id, role) {
  return { t: 'ui', action: { kind: 'role', id, role } };
}
/** @param {string} id the participant id to kick+ban. */
export function kickAction(id) {
  return { t: 'ui', action: { kind: 'kick', id } };
}

/**
 * The token-free invite link a host copies to share (finding 1). The host tab lives at
 * `<origin>/<code>?host=<token>`; the invite is the same origin + code with the token
 * stripped, so a friend who opens it lands on the normal knock flow — never the host
 * seat. Built from the tab's own location so it works behind any host/port.
 * @param {string} origin  e.g. window.location.origin
 * @param {string} code    the room code
 */
export function inviteLink(origin, code) {
  return `${String(origin || '').replace(/\/+$/, '')}/${code}`;
}

/** Clamp a number into [0,1] (NaN → 0). */
export function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Has enough time passed since `last` to send again at ≤ 1000/interval per second? */
export function throttleReady(last, now, intervalMs) {
  return now - last >= intervalMs;
}

/** id → {name, role, color} lookup over a participants array. */
export function byId(participants) {
  const m = new Map();
  for (const p of Array.isArray(participants) ? participants : []) m.set(p.id, p);
  return m;
}

const nameFor = (m, id) => m.get(id)?.name ?? String(id ?? '');
const colorFor = (m, id) => m.get(id)?.color ?? '#9aa4b2';

/** What a role may do in the tray (mirrors gate.js semantics, client side). */
export function roleCaps(role) {
  const rank = { viewer: 0, prompter: 1, host: 2 }[role] ?? 0;
  return {
    isViewer: rank < 1,
    canCompose: rank >= 1, // prompter+ (typing, asks, slash/bash — all of it)
    isHost: rank >= 2,
  };
}

/** Friendly label + kind for Claude's state chip. */
export function claudeLabel(state) {
  switch (state) {
    case 'busy':
      return { text: 'Claude is brewing', kind: 'busy' };
    case 'ask':
      return { text: 'permission ask pending', kind: 'ask' };
    case 'idle':
    default:
      return { text: 'Claude is idle', kind: 'idle' };
  }
}

/** The knock's first-seen line: never seen → "first time"; else "seen before as X". */
export function seenLabel(seen) {
  if (seen === null || seen === undefined || seen === false || seen === '') return 'first time seeing this key';
  return `seen before as ${seen}`;
}

/** A compact, safe rendering of a key fingerprint for a knock card. */
export function shortFp(fp) {
  const s = String(fp ?? '');
  if (!s) return '';
  const body = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  return body.length > 12 ? body.slice(0, 12) + '…' : body;
}

/**
 * Split a draft's display text into ordered segments with caret blocks inserted at
 * their character offsets. Names are NEVER inline — only bare colored caret blocks
 * (spec §draft lines); author names live on the box border. Offsets are UTF-16
 * indices into `text` (they always fall on a code-point boundary — see drafts.js).
 * @returns {Array<{type:'text',value:string}|{type:'caret',color:string,name:string,self:boolean,id:string}>}
 */
export function segmentBox(text, carets) {
  const t = String(text ?? '');
  const list = (Array.isArray(carets) ? carets : [])
    .map((c) => ({ ...c, offset: Math.max(0, Math.min(t.length, Math.trunc(c.offset) || 0)) }))
    .sort((a, b) => a.offset - b.offset);
  const segs = [];
  let pos = 0;
  for (const c of list) {
    if (c.offset > pos) {
      segs.push({ type: 'text', value: t.slice(pos, c.offset) });
      pos = c.offset;
    }
    segs.push({ type: 'caret', color: c.color, name: c.name, self: !!c.self, id: c.id });
  }
  if (pos < t.length) segs.push({ type: 'text', value: t.slice(pos) });
  if (segs.length === 0) segs.push({ type: 'text', value: '' });
  return segs;
}

/** Build a single draft box's view model (authors on the border, caret blocks in text). */
export function draftView(box, pById, selfId) {
  const text = box?.text ?? '';
  const authors = (box?.authors ?? []).map((uid) => ({
    id: uid,
    name: nameFor(pById, uid),
    color: colorFor(pById, uid),
    isSelf: uid === selfId,
  }));
  const caretOffsets = box?.caretOffsets ?? {};
  const carets = Object.entries(caretOffsets).map(([uid, offset]) => ({
    id: uid,
    offset,
    color: colorFor(pById, uid),
    name: nameFor(pById, uid),
    self: uid === selfId,
  }));
  const focusedBySelf = selfId != null && Object.prototype.hasOwnProperty.call(caretOffsets, selfId);
  return {
    id: box?.id,
    text,
    authors,
    carets,
    focusedBySelf,
    segments: segmentBox(text, carets),
    // Shared placement (stage fractions) — everyone sees a moved box in the same spot.
    place: box?.place ?? null,
  };
}

/**
 * The whole client view model: the single pure function the render layer consumes.
 * @param {object} state  the host's {t:'state'} .data snapshot
 * @param {string|null} selfId  this client's participant id (from the 'joined' frame)
 */
export function overlayView(state, selfId) {
  const s = state && typeof state === 'object' ? state : {};
  const participants = Array.isArray(s.participants) ? s.participants : [];
  const pById = byId(participants);
  const me = pById.get(selfId) || null;
  const role = me?.role || 'viewer';
  const caps = roleCaps(role);

  const rawPtr = s.pointers && typeof s.pointers === 'object' ? s.pointers : {};
  const othersPointers = Object.entries(rawPtr)
    .filter(([id]) => id !== selfId) // never draw my own cursor
    .map(([id, p]) => ({
      id,
      x: clamp01(p?.x),
      y: clamp01(p?.y),
      name: p?.name || nameFor(pById, id),
      color: p?.color || colorFor(pById, id),
    }));

  const boxes = s.drafts && Array.isArray(s.drafts.boxes) ? s.drafts.boxes : [];
  const drafts = boxes.map((b) => draftView(b, pById, selfId));

  const queue = (Array.isArray(s.queue) ? s.queue : []).map((it) => ({
    n: it.n,
    text: it.text ?? '',
    author: it.author,
    isMine: it.author === selfId,
    name: nameFor(pById, it.author),
    color: colorFor(pById, it.author),
  }));

  const knocks = (Array.isArray(s.knocks) ? s.knocks : []).map((k) => ({
    id: k.id,
    name: k.name,
    fp: k.fp,
    shortFp: shortFp(k.fp),
    seen: k.seen,
    seenLabel: seenLabel(k.seen),
  }));

  return {
    room: s.room || '',
    selfId: selfId || null,
    me: me ? { id: me.id, name: me.name, role, color: me.color } : null,
    role,
    ...caps,
    participants: participants.map((p) => ({ ...p, isSelf: p.id === selfId })),
    othersPointers,
    drafts,
    queue,
    claudeState: s.claudeState || 'idle',
    claude: claudeLabel(s.claudeState),
    paused: !!s.paused,
    knocks,
    // The latest addressed notice ({id, msg, seq}) — shown as a toast when it's mine.
    notice: s.notice && typeof s.notice === 'object' ? s.notice : null,
    // The shared clamp every mirrored frame is painted at; the xterm mirror must
    // be exactly this size (null on an older host → fall back to local fitting).
    view: s.view && typeof s.view === 'object' ? s.view : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BROWSER APP  (guarded: nothing below runs when imported in node)
// ════════════════════════════════════════════════════════════════════════════

function main() {
  const TOKEN_KEY = 'claude-share:token';
  const NAME_KEY = 'claude-share:name';
  // Accepted room password, stored per room so a reload glides straight back in
  // (same promise as the token). Cleared the moment the relay rejects it.
  const passKey = (code) => 'claude-share:pass:' + code;
  // Per-browser host-seat secret (leaked-link defense). Minted once and kept in
  // this browser's storage; presented only when opening a host tab. A stolen host
  // link opened in another browser mints a DIFFERENT one, so the host CLI (which
  // binds the seat to the first it sees) refuses it. Reloads reuse it, so the real
  // host glides back into the seat.
  const SEAT_KEY = 'claude-share:seat';
  const POINTER_HZ = 30; // send own pointer ≤ 30/s (spec)
  const POINTER_MS = Math.ceil(1000 / POINTER_HZ);

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* private mode: identity is session-only, that's fine */
      }
    },
  };
  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

  // ── app state ───────────────────────────────────────────────────────────────
  const loc = parseLocation(window.location);
  let ws = null;
  let term = null;
  let selfId = null;
  let lastState = null;
  let phase = 'join'; // join | knocking | live | error | closed
  let intentionalClose = false;
  let endStep = 0; // host End-Session confirm: 0 idle · 1 "end?" · 2 "save?"
  const cursorEls = new Map(); // participant id -> floating-cursor DOM node
  let ptrLast = 0;
  // Mirror sizing: screen bytes buffered until state.view has sized the terminal.
  let mirrorSized = false;
  let pendingFrames = [];
  let lastViewKey = '';
  let retuneTries = 0; // bounded font-retune attempts while xterm re-measures
  // Direct mode is DERIVED, not toggled: anyone who can type, with no draft
  // focused, types straight into Claude. Updated from every state frame.
  let directOn = false;
  // Draft placement is SHARED (brain-owned, stage fractions). Client state here is
  // only for interaction smoothness: the box being dragged and the spawn point of
  // a double-clicked draft (mailed as a place action once the box exists).
  let pendingSpawn = null; // stage-fraction {x,y} for the next box I author (dblclick)
  let draggingDraft = false; // renders skip while a draft is mid-drag
  let placeLast = 0; // throttle for streaming place actions during a drag

  // ── DOM handles ──────────────────────────────────────────────────────────────
  const joinScreen = $('#join');
  const liveScreen = $('#live');
  const roomLabel = $('#join-room');
  const codeInput = $('#code-input');
  const nameInput = $('#name-input');
  const passField = $('#pass-field');
  const passInput = $('#pass-input');
  const knockBtn = $('#knock-btn');
  const joinStatus = $('#join-status');
  const joinForm = $('#join-form');
  const waiting = $('#waiting');
  const stage = $('#stage');
  const termEl = $('#term');
  const cursorLayer = $('#cursors');
  const pausedCard = $('#paused');
  const claudeChip = $('#claude-chip');
  const draftsLayer = $('#drafts');
  const queueChip = $('#queue-chip');
  const queuePop = $('#queue-pop');
  const composer = $('#composer');
  const newDraftBtn = $('#new-draft');
  const hostControls = $('#host-controls');
  const knocksBox = $('#knocks');
  const avatarsBox = $('#avatars');
  const popover = $('#popover');
  const copyInviteBtn = $('#copy-invite');
  const pauseBtn = $('#pause-btn');
  const endBtn = $('#end-btn');
  const endConfirm = $('#end-confirm');
  const sbRoom = $('#sb-room');
  const sbRole = $('#sb-role');
  const toastEl = $('#toast');
  toastEl.addEventListener('click', () => {
    toastEl.hidden = true;
  });

  // ── join screen ──────────────────────────────────────────────────────────────
  function showJoin() {
    phase = 'join';
    joinScreen.hidden = false;
    liveScreen.hidden = true;
    waiting.hidden = true;
    joinForm.hidden = false;
    if (loc.code) {
      roomLabel.textContent = loc.code;
      roomLabel.hidden = false;
      codeInput.hidden = true;
      codeInput.value = loc.code;
    } else {
      roomLabel.hidden = true;
      codeInput.hidden = false;
    }
    nameInput.value = store.get(NAME_KEY) || '';
    setJoinStatus('');
    nameInput.focus();
  }

  function setJoinStatus(msg, isError) {
    joinStatus.textContent = msg || '';
    joinStatus.classList.toggle('error', !!isError);
  }

  const ERRORS = {
    'no-room': 'That room does not exist (or has expired).',
    'host-gone': 'The host is offline right now. Try again in a moment.',
    banned: 'You were removed from this room.',
    lockout: 'Too many attempts. Wait a bit and try again.',
    timeout: 'The host did not answer in time. Try again when they are around.',
    denied: 'The host declined your request.',
    closed: 'The connection closed before you were let in — try again.',
    // password gets its own copy in fail(): the message depends on whether we
    // had one to send ("needs a password" vs "wrong password").
    password: 'This room is password-protected.',
  };

  let sentPass = null; // what the last attempt presented (drives the fail() copy)

  function beginKnock() {
    const code = (loc.code || codeInput.value || '').trim();
    if (!code) return setJoinStatus('Enter a room code to join.', true);
    const name = (nameInput.value || '').trim().slice(0, 24);
    if (!loc.isHostTab && !name) return setJoinStatus('Pick a name so the host knows who you are.', true);
    if (name) store.set(NAME_KEY, name);
    let token = store.get(TOKEN_KEY);
    if (!token) {
      token = uuid();
      store.set(TOKEN_KEY, token);
    }
    // A freshly typed password wins; otherwise reuse the one this room accepted
    // before (reload glide-back). Open rooms send none and never see the field.
    const typed = (passInput.value || '').trim();
    const pass = typed || store.get(passKey(code)) || '';
    sentPass = pass || null;
    if (typed) store.set(passKey(code), typed);
    // Host tabs carry the per-browser seat secret (minted once, kept locally).
    let seat = null;
    if (loc.hostToken) {
      seat = store.get(SEAT_KEY);
      if (!seat) {
        seat = uuid();
        store.set(SEAT_KEY, seat);
      }
    }
    connect({ code, name, token, hostToken: loc.hostToken, pass, seat });
  }

  // ── connection ───────────────────────────────────────────────────────────────
  function connect({ code, name, token, hostToken, pass, seat }) {
    // Supersede any previous socket COMPLETELY. A zombie from an earlier attempt
    // still has live handlers — when the brain dedupes its knock, its deny/close
    // would splash "declined" into a UI that belongs to the NEW attempt.
    const old = ws;
    if (old) {
      old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close();
      } catch {}
    }
    phase = 'knocking';
    joinForm.hidden = true;
    waiting.hidden = false;
    $('#waiting-text').textContent = hostToken
      ? 'Opening your room…'
      : `Waiting for the host to let you in…`;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host + buildWsPath({ code, name, token, hostToken, pass, seat });
    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      return fail('no-room');
    }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {}; // nothing to send until admitted
    sock.onmessage = (ev) => {
      if (sock !== ws) return; // superseded mid-flight
      onMessage(ev);
    };
    sock.onclose = () => {
      if (sock !== ws || intentionalClose) return;
      if (phase === 'removed') return; // the kicked panel owns the screen now
      if (phase === 'live') showDisconnected();
      // A silent close mid-knock is NOT evidence the host is offline (a superseded
      // knock or a network blip closes the same way) — never claim that it is.
      else if (phase !== 'error') fail('closed');
    };
    sock.onerror = () => {};
  }

  function onMessage(ev) {
    if (typeof ev.data !== 'string') {
      // Binary = screen bytes → the xterm mirror. Until the first state frame has
      // told us the shared size, buffer: the join snapshot was painted at that size,
      // and writing it into a wrong-sized terminal wraps every line into garbage.
      const bytes = new Uint8Array(ev.data);
      if (term && mirrorSized) term.write(bytes);
      else pendingFrames.push(bytes);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'joined':
        // A host tab IS the host (the brain maps it to HOST_ID and never adds it as a
        // second participant — finding 4), so adopt the host's roster identity: the
        // view then finds "me" as the host, grants host caps, and shows one host entry.
        selfId = loc.isHostTab ? 'host' : msg.id;
        goLive();
        break;
      case 'state':
        lastState = msg.data;
        if (phase === 'live') render();
        break;
      case 'error':
        // Kicked mid-session: the mirror disappears behind a full-screen panel —
        // never the old "removed" bytes smeared into a still-visible terminal.
        if (msg.reason === 'kicked') showRemoved();
        else fail(msg.reason);
        break;
      default:
        break;
    }
  }

  function fail(reason) {
    phase = 'error';
    joinScreen.hidden = false;
    liveScreen.hidden = true;
    waiting.hidden = true;
    joinForm.hidden = false;
    if (loc.code) {
      roomLabel.hidden = false;
      codeInput.hidden = true;
    }
    if (reason === 'password') {
      // Reveal the field (open rooms never see it) and forget a rejected value —
      // a stale stored password must not silently retry forever.
      const code = (loc.code || codeInput.value || '').trim();
      if (code) store.set(passKey(code), '');
      passField.hidden = false;
      passInput.value = '';
      setJoinStatus(sentPass ? 'Wrong password — try again.' : 'This room is password-protected.', true);
      passInput.focus();
      return;
    }
    setJoinStatus(ERRORS[reason] || 'Could not connect. Try again.', true);
  }

  function showDisconnected() {
    phase = 'closed';
    const banner = $('#dc-banner');
    banner.hidden = false;
  }

  function showRemoved() {
    phase = 'removed';
    intentionalClose = true; // the close that follows is expected — no reconnect UI
    liveScreen.hidden = true;
    joinScreen.hidden = true;
    $('#removed').hidden = false;
  }

  // ── go live ──────────────────────────────────────────────────────────────────
  function goLive() {
    phase = 'live';
    joinScreen.hidden = true;
    liveScreen.hidden = false;
    if (!term) createTerm();
    fit();
    render();
    // Keep the composer ready to type the moment the room is live.
    focusComposer();
  }

  function createTerm() {
    const Term = window.Terminal;
    if (!Term) {
      // xterm bundle failed to load — degrade to a plain message rather than crash.
      termEl.textContent = 'terminal unavailable (xterm did not load)';
      return;
    }
    term = new Term({
      convertEol: false,
      // Claude's real cursor IS the "you type here" indicator — the mirror never
      // holds browser focus, so render the inactive cursor as a full block (CSS
      // adds the blink).
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      disableStdin: true, // the drafts own composed input; the mirror is read-only
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 5000,
      // Transparent over the stage glass: the mirror has no visible edge of its
      // own, so a mirror narrower than the tab never reads as an empty side panel.
      allowTransparency: true,
      theme: {
        background: 'rgba(0,0,0,0)',
        foreground: '#e8ecf4',
        cursor: '#e8a33d',
        selectionBackground: 'rgba(232,163,61,0.28)',
        black: '#0a0c12',
        brightBlack: '#5b6472',
      },
    });
    term.open(termEl);
    // The mirror is read-only, but xterm still focuses its hidden helper textarea on
    // click and its keydown handler swallows every key it gets — which silently ate
    // all direct-mode input. Make the helper unfocusable: keys then land on the
    // composer/document, where OUR handlers route them (drafts or direct-to-Claude).
    // One wrinkle: xterm draws NO cursor until it has been focused once, and Claude's
    // cursor is our "you type here" indicator — prime it with a silent focus/blur
    // cycle BEFORE locking the helper.
    if (term.textarea) {
      term.textarea.tabIndex = -1;
      term.textarea.focus();
      term.textarea.blur();
      term.textarea.disabled = true;
    }
    // The focus/blur prime is inert in a background window (Chrome defers focus
    // events until the window is foreground), so a guest tab opened behind another
    // window never drew a cursor. Flip xterm's init flag directly — the same thing
    // its _showCursor() does on first focus, minus the need for real focus.
    try {
      const cs = term._core?._coreService;
      if (cs && !cs.isCursorInitialized) {
        cs.isCursorInitialized = true;
        term.refresh(0, term.rows - 1);
      }
    } catch {
      /* private API moved — the focus/blur prime still covers foreground tabs */
    }
    const ro = new ResizeObserver(() => fit());
    ro.observe(stage);
    window.addEventListener('resize', fit);
    // Pointer capture over the terminal (the floating-cursor "Figma feel").
    // Pointer events, not mouse events: cancelling a pointerdown (the draft drag)
    // suppresses the compatibility MOUSE stream, which froze cursor broadcasting
    // for the whole drag. Pointermove keeps flowing regardless.
    stage.addEventListener('pointermove', onStageMove);
    stage.addEventListener('pointerleave', () => sendPointer(-1, -1)); // park off-canvas
    // Wheel = Claude's own transcript scroll. Claude enables mouse tracking and
    // scrolls internally on wheel reports — the terminal never receives scrollback
    // lines, so xterm's viewport has nothing to scroll and would swallow the wheel
    // as a dead mouse report (stdin is disabled). Capture it before xterm and mail
    // it to the brain, which types the real report into the pty.
    stage.addEventListener('wheel', onStageWheel, { passive: false, capture: true });
  }

  let wheelAcc = 0;
  function onStageWheel(e) {
    if (phase !== 'live') return;
    if (e.target.closest?.('.fdraft, .popover')) return; // drafts/popovers scroll themselves
    e.preventDefault();
    e.stopPropagation();
    wheelAcc += e.deltaY;
    const lines = Math.trunc(wheelAcc / 40); // ~one report per wheel notch
    if (!lines) return;
    wheelAcc -= lines * 40;
    sendMsg({ t: 'ui', action: { kind: 'scroll', lines: Math.max(-8, Math.min(8, lines)) } });
  }

  // The tab's cell size, from the renderer's own measurement (what addon-fit reads),
  // with a conservative fallback if the private field is unavailable.
  function cellSize() {
    try {
      const cell = term?._core?._renderService?.dimensions?.css?.cell;
      if (cell && cell.width && cell.height) return { cw: cell.width, ch: cell.height };
    } catch {
      /* fall through to estimate */
    }
    return { cw: 13 * 0.6, ch: 13 * 1.1 }; // rough advance for the 13px mono font
  }

  // Report this tab's CAPACITY (how many cells its container could show) — the brain
  // folds it into the shared clamp. Always measured at the REFERENCE font (13px):
  // scaleTerm retunes the actual font to fill the stage, and capacity tracking the
  // live font would feed back into the clamp (bigger font → smaller clamp → bigger
  // font …). The reference cell is measured ONCE, before the first retune — deriving
  // it from a retuned font (cw/font*13) picks up per-size rounding, so the derived
  // reference drifts a little each retune and the clamp oscillates (erase/repaint
  // churn on every join). The mirror itself never sizes from the container: it
  // renders at exactly state.view (see applyView) and scales visually.
  let refCell = null;
  function refCellSize() {
    if (refCell) return refCell;
    const { cw, ch } = cellSize();
    const font = term.options.fontSize || 13;
    const cell = { cw: (cw / font) * 13, ch: (ch / font) * 13 };
    if (font === 13) refCell = cell; // only cache the un-retuned measurement
    return cell;
  }
  function fit() {
    if (!term) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const { cw, ch } = refCellSize();
    const cols = Math.max(2, Math.floor((rect.width - 24) / cw));
    const rows = Math.max(1, Math.floor((rect.height - 20) / ch));
    sendMsg({ t: 'resize', cols, rows });
    scaleTerm();
  }

  // Render the mirror at the shared size the frames were painted at; on the first
  // state frame, flush the buffered join snapshot into the now-correctly-sized term.
  function applyView(v) {
    if (!term) return;
    const vw = v.view;
    if (vw && vw.cols >= 2 && vw.rows >= 1) {
      const key = vw.cols + 'x' + vw.rows;
      if (key !== lastViewKey) {
        lastViewKey = key;
        try {
          term.resize(vw.cols, vw.rows);
        } catch {
          /* xterm not ready */
        }
      }
    }
    if (!mirrorSized) {
      mirrorSized = true; // no view field (older host) → degrade: just start writing
      for (const chunk of pendingFrames) term.write(chunk);
      pendingFrames = [];
      setTimeout(scaleTerm, 350); // warm-up: re-fit once the first paint has settled
    }
    scaleTerm();
  }

  // Make the mirror FILL the tab: pick the font size that best fits the shared
  // cols×rows into the stage (crisp text beats transform-zoom), then a clamped
  // non-uniform residual scale closes the remaining gap. termEl's rect stays equal
  // to the VISUAL content box, so pointer math and the cursor overlay read true
  // positions (getBoundingClientRect reflects the transform, per-axis included).
  function scaleTerm() {
    if (!term) return;
    // .xterm-screen is the true cols×rows content box (.xterm just fills its parent)
    const inner = termEl.querySelector('.xterm-screen');
    if (!inner) return;
    const w = inner.offsetWidth;
    const h = inner.offsetHeight;
    if (w < 2 || h < 2) return;
    const rect = stage.getBoundingClientRect();
    const availW = rect.width - 24;
    const availH = rect.height - 20;
    const fit = Math.min(availW / w, availH / h);
    if (!Number.isFinite(fit) || fit <= 0) return;
    // Pass 1: font size by the BINDING axis (crisp text beats transform-zoom).
    // xterm re-measures ASYNCHRONOUSLY after an option change — a rAF often reads
    // the stale size (the "doesn't span until the first message" bug), so retry on
    // a timer until the measurement settles, bounded so it can never loop.
    const cur = term.options.fontSize || 13;
    const ideal = Math.max(9, Math.min(28, Math.floor(cur * fit)));
    if (ideal !== cur && retuneTries < 8) {
      retuneTries += 1;
      term.options.fontSize = ideal;
      setTimeout(scaleTerm, 90);
      return;
    }
    // Pass 2: close the residual gap (integer font steps + a foreign aspect in the
    // shared size) with a mildly NON-uniform scale — each axis may stretch up to 8%
    // past the uniform fit. The whole rendered picture scales together, so
    // box-drawing lines stay CONNECTED (per-cell padding via letter-spacing /
    // line-height broke every solid line into dashes). Residue past the cap stays
    // as a small quiet gap rather than visible glyph distortion.
    retuneTries = 0;
    const k = Math.min(fit, 1);
    const kx = Math.min(availW / w, k * 1.08);
    const ky = Math.min(availH / h, k * 1.08);
    termEl.style.width = w + 'px';
    termEl.style.height = h + 'px';
    termEl.style.transform = `scale(${kx}, ${ky})`;
    // Center horizontally; anchor to the BOTTOM so Claude's input line hugs the
    // bottom of the page like a real terminal — vertical slack collects above.
    termEl.style.left = Math.max(12, (rect.width - w * kx) / 2) + 'px';
    termEl.style.top = Math.max(10, rect.height - 10 - h * ky) + 'px';
  }

  // ── outbound ───────────────────────────────────────────────────────────────
  function sendMsg(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* socket closing */
      }
    }
  }
  const sendKey = (bytes) => sendMsg({ t: 'key', data: b64encode(bytes) });
  const sendCommand = (text) => sendMsg({ t: 'ui', action: { kind: 'command', text } });
  function sendPointer(x, y) {
    sendMsg({ t: 'pointer', x, y });
  }

  function onStageMove(e) {
    if (phase !== 'live') return;
    const now = Date.now();
    if (!throttleReady(ptrLast, now, POINTER_MS)) return;
    ptrLast = now;
    const rect = termEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    sendPointer(clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height));
  }

  // ── composer (a transparent key/paste catcher; text shows in the draft boxes) ──
  function focusComposer() {
    if (directOn) return; // keys belong to Claude until the user leaves direct mode
    const v = lastState ? overlayView(lastState, selfId) : null;
    if (v && v.canCompose && !composer.disabled) composer.focus();
  }
  composer.addEventListener('keydown', (e) => {
    const bytes = keyToBytes(e); // maps the ⌘ editing chords too, so ask it first
    if (bytes != null) {
      e.preventDefault();
      sendKey(bytes);
      return;
    }
    if (e.ctrlKey || e.metaKey) return; // let the browser own its shortcuts
    if (e.key.length === 1) {
      // an unhandled printable with a modifier we don't map — swallow so the
      // catcher stays empty, but send nothing.
      e.preventDefault();
    }
  });
  composer.addEventListener('input', () => {
    composer.value = ''; // never echo locally; the brain is the authority
  });
  composer.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (text) sendKey(pasteBytes(text));
  });
  // Direct mode: translate a keydown to the raw bytes Claude's own UI expects —
  // a superset of the draft keymap (Tab, Ctrl+letter) since nothing is off-limits
  // for someone typing at the "real" terminal. ⌘ stays with the browser.
  function directKeyBytes(e) {
    if (e.metaKey) return null;
    if (e.ctrlKey) {
      if (!e.altKey && /^[a-z]$/i.test(e.key)) return String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96);
      return null;
    }
    if (e.key === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t';
    return keyToBytes(e);
  }
  // Click the bare terminal while composing → step out of the draft (Esc). The
  // brain sees the Esc as "leave the box" (never an interrupt while composing);
  // the next keystroke is then raw to Claude.
  stage.addEventListener('mousedown', (e) => {
    if (e.target.closest('.fdraft')) return;
    const v = lastState ? overlayView(lastState, selfId) : null;
    if (v && v.drafts.some((d) => d.focusedBySelf)) sendKey('\x1b');
  });
  // Double-click an empty spot → a new draft spawns right there (explicit creation).
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.fdraft')) return;
    const v = lastState ? overlayView(lastState, selfId) : null;
    if (!v?.canCompose) return;
    const r = stage.getBoundingClientRect();
    pendingSpawn = { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
    sendKey(NEW_DRAFT_BYTES);
    setTimeout(() => composer.focus(), 0);
  });

  // Keys over a standing drag-selection (the catcher is blurred then, so these land
  // on the document): delete removes the range; typing replaces it — the range is
  // deleted and the character follows as an ordinary draft keystroke.
  document.addEventListener('keydown', (e) => {
    if (phase !== 'live') return;
    if (directOn) {
      // Straight to Claude. A key that landed on the still-focused catcher was
      // already mailed by its own handler — don't send it twice.
      if (e.target === composer) return;
      const b = directKeyBytes(e);
      if (b != null) {
        e.preventDefault();
        sendKey(b);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey) return; // ⌘C copy of the highlight stays native
    const ds = selectionInDraft();
    if (!ds) return;
    const printable = !e.altKey && [...e.key].length === 1;
    if (e.key === 'Backspace' || e.key === 'Delete' || printable) {
      e.preventDefault();
      sendMsg({ t: 'ui', action: { kind: 'delrange', id: ds.boxId, start: ds.start, end: ds.end } });
      if (printable) sendKey(e.key);
    } else if (e.key !== 'Escape') {
      return; // arrows etc: just collapse the selection below
    }
    window.getSelection()?.removeAllRanges();
    setTimeout(focusComposer, 0);
  });
  newDraftBtn.addEventListener('click', () => {
    sendKey(NEW_DRAFT_BYTES);
    composer.focus(); // straight to the catcher — the new box is already yours
  });

  // ── host controls ────────────────────────────────────────────────────────────
  // Copy the SAFE, token-free invite link — never this tab's own host URL (finding 1).
  copyInviteBtn?.addEventListener('click', async () => {
    const link = inviteLink(window.location.origin, loc.code);
    const label = copyInviteBtn.textContent;
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      // Clipboard API unavailable/denied — fall back to a prompt so the host can copy.
      try {
        window.prompt('Copy this invite link to share:', link);
        ok = true;
      } catch {
        /* nothing more we can do */
      }
    }
    copyInviteBtn.textContent = ok ? 'Invite copied ✓' : 'Copy failed';
    setTimeout(() => {
      copyInviteBtn.textContent = label;
    }, 1600);
  });
  pauseBtn.addEventListener('click', () => {
    const v = overlayView(lastState, selfId);
    sendCommand(v.paused ? '/resume' : '/pause');
  });
  endBtn.addEventListener('click', () => {
    endStep = 1;
    renderEndConfirm();
  });
  // End confirms in place: the ■ chip swaps to its confirm steps right in the strip.
  function renderEndConfirm() {
    endConfirm.innerHTML = '';
    if (endStep === 0) {
      endConfirm.hidden = true;
      endBtn.hidden = false;
      return;
    }
    endBtn.hidden = true;
    endConfirm.hidden = false;
    if (endStep === 1) {
      endConfirm.append(el('span', null, 'End for everyone?'));
      const go = el('button', 'kbtn yes', 'End');
      const cancel = el('button', 'kbtn no', 'Cancel');
      go.onclick = () => {
        endStep = 2;
        renderEndConfirm();
      };
      cancel.onclick = () => {
        endStep = 0;
        renderEndConfirm();
      };
      endConfirm.append(go, cancel);
    } else {
      endConfirm.append(el('span', null, 'Save session.md?'));
      const save = el('button', 'kbtn yes', 'Save & end');
      const skip = el('button', 'kbtn no', 'Just end');
      // The save choice is resolved by the host CLI's /end confirmation; the browser
      // fires /end either way (the two-step gate lives here so the host never has to
      // touch the terminal). Both buttons end the room.
      save.onclick = () => finishEnd();
      skip.onclick = () => finishEnd();
      endConfirm.append(save, skip);
    }
  }
  function finishEnd() {
    endStep = 0;
    renderEndConfirm();
    sendCommand('/end');
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function render() {
    if (!lastState) return;
    const v = overlayView(lastState, selfId);
    // Direct is derived: anyone who can prompt, with no draft focused, types
    // straight into Claude.
    const selfComposing = v.drafts.some((d) => d.focusedBySelf);
    directOn = v.canCompose && !selfComposing;
    // The "keys go into Claude" indicator is Claude's own blinking cursor in the
    // mirror (forced filled+blinking via CSS) — no chip needed.
    stage.classList.toggle('direct', directOn);
    // Composing → the key catcher must hold focus, so typing lands in the draft
    // without a manual click (unless a drag-selection is standing).
    if (selfComposing && !composer.disabled && document.activeElement !== composer) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) composer.focus();
    }
    ghostHint(v);
    applyView(v);
    renderStatusbar(v);
    renderClaudeChip(v);
    renderPaused(v);
    renderDrafts(v);
    renderQueue(v);
    renderComposer(v);
    renderCursors(v);
    renderHeader(v);
    renderNotice(v);
  }

  // An addressed notice from the brain ("you can't use slash commands — …"): show
  // it as a toast pill when it's for me and I haven't shown that seq yet.
  let noticeSeq = 0;
  let noticeTimer = null;
  function renderNotice(v) {
    const n = v.notice;
    if (!n || n.id !== selfId || n.seq === noticeSeq) return;
    noticeSeq = n.seq;
    toastEl.textContent = n.msg;
    toastEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4000);
  }

  function renderStatusbar(v) {
    sbRoom.textContent = v.room ? v.room : '—';
    sbRole.innerHTML = '';
    sbRole.append('you: ');
    const b = el('b', null, v.role);
    b.style.setProperty('--c', v.me?.color || '#9aa4b2');
    sbRole.append(b);
  }

  function renderClaudeChip(v) {
    claudeChip.className = 'chip claude ' + v.claude.kind;
    claudeChip.textContent = v.claude.text;
    // The host's unstick: a missed hook can wedge busy/ask — click forces idle.
    claudeChip.style.cursor = v.isHost ? 'pointer' : 'default';
    claudeChip.title = v.isHost ? 'stuck? click to reset to idle and drain the queue' : '';
    claudeChip.onclick = v.isHost ? () => sendMsg({ t: 'ui', action: { kind: 'resync' } }) : null;
  }

  // Once, when the room first has two people who can type: say how composing works
  // (drafts are explicit now — nothing on screen would otherwise hint they exist).
  let hinted = false;
  function ghostHint(v) {
    if (hinted) return;
    if (v.participants.filter((p) => p.role !== 'viewer').length < 2) return;
    hinted = true;
    localToast('compose together: + draft, or double-click the terminal');
  }
  function localToast(msg, ms = 6000) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, ms);
  }

  function renderPaused(v) {
    pausedCard.hidden = !v.paused;
    stage.classList.toggle('paused', v.paused);
  }

  let lastDraftsJson = '';
  let knownBoxIds = new Set(); // boxes already on screen — only NEW ones animate in
  function renderDrafts(v) {
    // Rebuild only when the drafts actually changed: every rebuild would destroy a
    // native drag-selection, and state frames arrive for unrelated reasons
    // (pointers). Mid-drag renders are skipped too — pointerup re-syncs.
    const json = JSON.stringify(v.drafts);
    if (json === lastDraftsJson || draggingDraft) return;
    lastDraftsJson = json;
    draftsLayer.innerHTML = '';
    const nextIds = new Set();
    for (const [i, d] of v.drafts.entries()) {
      nextIds.add(d.id);
      // A box I just spawned by double-click lands where I clicked — for everyone.
      if (pendingSpawn && d.focusedBySelf && !d.place && d.text === '') {
        sendMsg({ t: 'ui', action: { kind: 'place', id: d.id, ...pendingSpawn } });
        d.place = pendingSpawn; // optimistic, until the next state frame confirms
        pendingSpawn = null;
      }
      // Entrance animation only for a box that just APPEARED — this render runs on
      // every keystroke (full rebuild), and replaying it would strobe. Same idea
      // for the border beam: phase it by wall-clock so a rebuild never resets it.
      const box = el(
        'div',
        'fdraft' + (d.focusedBySelf ? ' focused' : '') + (knownBoxIds.has(d.id) ? '' : ' anim-in'),
      );
      box.style.setProperty('--beam-delay', -(Date.now() % 1960) + 'ms');
      // Someone ELSE is writing in it → the ring glows in their color.
      if (!d.focusedBySelf && d.carets.length > 0) {
        box.classList.add('edited');
        box.style.setProperty('--ec', d.carets[0].color);
      }
      box.dataset.boxId = d.id;
      placeDraft(box, d, i);

      const bar = el('div', 'fbar');
      bar.append(el('span', 'grip', '⠿'));
      for (const a of d.authors) {
        const pill = el('span', 'author-pill', a.name + (a.isSelf ? ' (you)' : ''));
        pill.style.setProperty('--c', a.color);
        bar.append(pill);
      }
      if (v.canCompose) {
        const del = el('button', 'draft-x', '✕');
        del.type = 'button';
        del.title = 'delete this draft';
        del.onclick = () => sendMsg({ t: 'ui', action: { kind: 'deldraft', id: d.id } });
        bar.append(del);
      }

      const body = el('div', 'draft-body');
      for (const seg of d.segments) {
        if (seg.type === 'text') {
          body.append(document.createTextNode(seg.value));
        } else {
          const caret = el('span', 'caret' + (seg.self ? ' self' : ''));
          caret.style.setProperty('--c', seg.color);
          caret.title = seg.name;
          body.append(caret);
        }
      }

      const rsz = el('span', 'rsz', '◢');
      box.append(bar, body, rsz);

      // Move: drag the ⠿ bar. Resize: drag the ◢ corner. Both are SHARED — the box
      // travels on everyone's screen. Double-click the bar snaps it back home.
      bar.addEventListener('pointerdown', (e) => beginDraftDrag(e, box, d.id, 'move'));
      rsz.addEventListener('pointerdown', (e) => beginDraftDrag(e, box, d.id, 'size'));
      bar.addEventListener('dblclick', () => {
        sendMsg({ t: 'ui', action: { kind: 'place', id: d.id, home: true } });
      });
      // Clicks never fall through to the terminal beneath.
      box.addEventListener('mousedown', (e) => e.stopPropagation());
      box.addEventListener('dblclick', (e) => e.stopPropagation());

      // Mouseup, not mousedown: a click places your caret at that spot (blank space
      // → the end); a DRAG leaves the native selection standing — the document-level
      // key handler turns delete/typing over it into brain edits.
      body.addEventListener('mouseup', (e) => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return; // keep the highlight
        const off = clickCharOffset(body, e.clientX, e.clientY);
        sendMsg({ t: 'ui', action: { kind: 'caret', id: d.id, offset: off == null ? d.text.length : off } });
        setTimeout(focusComposer, 0);
      });
      draftsLayer.append(box);
    }
    knownBoxIds = nextIds;
  }

  // Apply a draft's SHARED placement (stage fractions from the brain), or the home
  // slot (pinned above Claude's input line, stacking upward by index).
  function placeDraft(box, d, i) {
    const p = d.place;
    if (!p) {
      box.classList.add('home');
      box.style.setProperty('--stack', String(i));
      return;
    }
    const r = stage.getBoundingClientRect();
    box.classList.remove('home');
    box.style.left = (p.x * r.width).toFixed(1) + 'px';
    box.style.top = (p.y * r.height).toFixed(1) + 'px';
    box.style.bottom = 'auto';
    box.style.transform = 'none';
    if (p.w) box.style.width = Math.max(220, p.w * r.width).toFixed(1) + 'px';
  }

  function beginDraftDrag(e, box, id, mode) {
    if (e.target.closest('button')) return;
    e.preventDefault();
    draggingDraft = true;
    const stageRect = stage.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const orig = { x: boxRect.left - stageRect.left, y: boxRect.top - stageRect.top, w: boxRect.width };
    let last = null;
    const spot = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      // Width always travels with the spot — a move must not reset a prior resize
      // (the brain stores the whole placement object).
      const px = mode === 'move' ? { x: orig.x + dx, y: orig.y + dy, w: orig.w } : { x: orig.x, y: orig.y, w: Math.max(220, orig.w + dx) };
      return { x: clamp01(px.x / stageRect.width), y: clamp01(px.y / stageRect.height), w: clamp01(px.w / stageRect.width) };
    };
    const move = (ev) => {
      last = spot(ev);
      // Local styling immediately (smooth), streamed to the room at ≤30/s.
      box.classList.remove('home');
      box.style.left = (last.x * stageRect.width).toFixed(1) + 'px';
      box.style.top = (last.y * stageRect.height).toFixed(1) + 'px';
      box.style.bottom = 'auto';
      box.style.transform = 'none';
      if (last.w) box.style.width = (last.w * stageRect.width).toFixed(1) + 'px';
      const now = Date.now();
      if (throttleReady(placeLast, now, 33)) {
        placeLast = now;
        sendMsg({ t: 'ui', action: { kind: 'place', id, ...last } });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draggingDraft = false;
      if (last) sendMsg({ t: 'ui', action: { kind: 'place', id, ...last } }); // final spot
      lastDraftsJson = ''; // re-sync with the latest state now that the drag ended
      render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // (node, offset) inside a draft body → display-character offset. Caret spans hold
  // no text, so the body's text nodes concatenate to exactly the draft's display
  // text. Returns null when the point isn't on the body's text.
  function domOffset(bodyEl, node, off) {
    if (!node || !bodyEl.contains(node)) return null;
    if (node.nodeType !== Node.TEXT_NODE) {
      // An element hit: `off` counts childNodes — sum the text of the ones before it.
      if (node !== bodyEl) return null;
      let total = 0;
      let i = 0;
      for (const c of node.childNodes) {
        if (i >= off) break;
        total += c.textContent.length;
        i += 1;
      }
      return total;
    }
    let total = 0;
    const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && n !== node; n = walker.nextNode()) total += n.nodeValue.length;
    return total + off;
  }

  // Translate a click inside a draft body into a display-character offset.
  function clickCharOffset(bodyEl, x, y) {
    const p = document.caretPositionFromPoint
      ? document.caretPositionFromPoint(x, y)
      : document.caretRangeFromPoint
        ? document.caretRangeFromPoint(x, y)
        : null;
    if (!p) return null;
    const node = 'offsetNode' in p ? p.offsetNode : p.startContainer;
    const off = 'offsetNode' in p ? p.offset : p.startOffset;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null; // blank area → caller uses the end
    return domOffset(bodyEl, node, off);
  }

  // The current drag-selection if it lives inside ONE draft body, as display offsets.
  function selectionInDraft() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    const anchor = r.commonAncestorContainer;
    const bodyEl = (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor)?.closest?.('.draft-body');
    if (!bodyEl) return null;
    const start = domOffset(bodyEl, r.startContainer, r.startOffset);
    const end = domOffset(bodyEl, r.endContainer, r.endOffset);
    if (start == null || end == null || start === end) return null;
    const boxId = bodyEl.closest('.draft')?.dataset.boxId;
    if (!boxId) return null;
    return { boxId, start: Math.min(start, end), end: Math.max(start, end) };
  }

  // The queue lives in the header: a quiet chip (amber ring while anything waits,
  // invisible when empty) that opens a popover of the attributed waiting line.
  function renderQueue(v) {
    queueChip.hidden = v.queue.length === 0;
    queueChip.textContent = `queue ${v.queue.length}`;
    if (v.queue.length === 0) {
      queuePop.hidden = true;
      return;
    }
    if (!queuePop.hidden) fillQueuePop(v);
  }
  function fillQueuePop(v) {
    queuePop.innerHTML = '';
    queuePop.append(el('div', 'queue-label', 'Waiting for Claude — fires one per idle'));
    for (const q of v.queue) {
      const chip = el('div', 'queue-chip');
      const who = el('span', 'queue-who', q.name);
      who.style.setProperty('--c', q.color);
      chip.append(el('span', 'queue-n', '#' + q.n), who, el('span', 'queue-text', q.text));
      const act = el('span', 'queue-act');
      if (q.isMine) {
        // Edit = pull the prompt out of the queue and back into a draft box,
        // focused and ready to type — no browser dialogs.
        const edit = el('button', 'ctrl tiny', 'edit');
        edit.onclick = () => {
          sendMsg({ t: 'ui', action: { kind: 'unqueue', n: q.n } });
          queuePop.hidden = true;
          composer.focus();
        };
        act.append(edit);
      }
      if (q.isMine || v.isHost) {
        const del = el('button', 'ctrl tiny end', '✕');
        del.onclick = () => sendCommand(`/queue del ${q.n}`);
        act.append(del);
      }
      chip.append(act);
      queuePop.append(chip);
    }
  }
  queueChip.addEventListener('click', () => {
    if (!queuePop.hidden) {
      queuePop.hidden = true;
      return;
    }
    const v = lastState ? overlayView(lastState, selfId) : null;
    if (!v || v.queue.length === 0) return;
    fillQueuePop(v);
    const r = queueChip.getBoundingClientRect();
    queuePop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 480)) + 'px';
    queuePop.style.top = r.bottom + 8 + 'px';
    queuePop.hidden = false;
  });
  document.addEventListener('mousedown', (e) => {
    if (!queuePop.hidden && !queuePop.contains(e.target) && e.target !== queueChip) queuePop.hidden = true;
  });

  function renderComposer(v) {
    const can = v.canCompose;
    composer.disabled = !can;
    newDraftBtn.disabled = !can;
  }

  function renderCursors(v) {
    const seen = new Set();
    const rect = termEl.getBoundingClientRect(); // post-scale: the visual content box
    const base = cursorLayer.getBoundingClientRect();
    const ox = rect.left - base.left;
    const oy = rect.top - base.top;
    for (const p of v.othersPointers) {
      seen.add(p.id);
      let node = cursorEls.get(p.id);
      if (!node) {
        node = el('div', 'cursor');
        node.innerHTML =
          '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
          '<path d="M1 1 L1 12 L4.2 9 L6.4 14 L8.6 13 L6.4 8 L11 8 Z"/></svg>';
        const pill = el('span', 'cursor-pill');
        node.append(pill);
        cursorLayer.append(node);
        cursorEls.set(p.id, node);
      }
      const svg = node.querySelector('svg path');
      if (svg) svg.setAttribute('fill', p.color);
      const pill = node.querySelector('.cursor-pill');
      pill.textContent = p.name;
      pill.style.background = p.color;
      pill.style.setProperty('--c', p.color);
      node.style.transform = `translate(${(ox + p.x * rect.width).toFixed(1)}px, ${(oy + p.y * rect.height).toFixed(1)}px)`;
    }
    for (const [id, node] of cursorEls) {
      if (!seen.has(id)) {
        node.remove();
        cursorEls.delete(id);
      }
    }
  }

  // The header owns the roster (avatar cluster) and, for the host, knock chips +
  // the Invite/Pause/End controls. There is no sidebar (design v2.1).
  function renderHeader(v) {
    // Avatar cluster: one colored identity dot per participant. Click → popover.
    avatarsBox.innerHTML = '';
    for (const p of v.participants) {
      const av = el('button', 'av', (p.name || '?').slice(0, 1).toUpperCase());
      av.type = 'button';
      av.style.setProperty('--c', p.color);
      av.title = p.name + (p.isSelf ? ' (you)' : '') + ' · ' + p.role;
      av.onclick = (e) => {
        e.stopPropagation();
        openPopover(av, p, v);
      };
      avatarsBox.append(av);
    }

    const host = loc.isHostTab || v.isHost;
    hostControls.hidden = !host;

    // Knock chips: amber-ringed, inline Admit/Deny — the one loud thing on screen.
    knocksBox.innerHTML = '';
    if (host) {
      for (const k of v.knocks) {
        const chip = el('span', 'knock-chip');
        chip.append('🚪 ');
        chip.append(el('span', 'kname', k.name));
        chip.append(el('span', null, ' wants to join'));
        chip.append(el('span', 'kmeta', k.seenLabel));
        const admit = el('button', 'kbtn yes', 'Admit');
        const deny = el('button', 'kbtn no', 'Deny');
        admit.title = deny.title = `${k.seenLabel} · ${k.shortFp}`;
        admit.onclick = () => sendMsg({ t: 'ui', action: { kind: 'admit', id: k.id } });
        deny.onclick = () => sendMsg({ t: 'ui', action: { kind: 'deny', id: k.id } });
        chip.append(admit, deny);
        knocksBox.append(chip);
      }
    }

    pauseBtn.title = v.paused ? 'Resume sharing' : 'Pause sharing';
    pauseBtn.classList.toggle('active', v.paused);
  }

  // Avatar popover: the host manages a person here (role chips + kick); everyone
  // else just sees who the dot is. One popover at a time; outside click closes.
  function openPopover(anchor, p, v) {
    popover.innerHTML = '';
    const head = el('div');
    const nm = el('span', 'pop-name', p.name + (p.isSelf ? ' (you)' : ''));
    nm.style.setProperty('--c', p.color);
    head.append(nm, el('span', 'pop-role', p.role));
    popover.append(head);
    const canManage = (loc.isHostTab || v.isHost) && p.role !== 'host' && !p.isSelf;
    if (canManage) {
      const row = el('div', 'pop-row');
      for (const r of ['viewer', 'prompter']) {
        const b = el('button', 'ctrl tiny' + (r === p.role ? ' active' : ''), r);
        // Target by id, not @name: names are guest-claimed and non-unique (finding 4).
        b.onclick = () => {
          sendMsg(roleAction(p.id, r));
          closePopover();
        };
        row.append(b);
      }
      popover.append(row);
      const kick = el('button', 'ctrl tiny end pop-kick', 'Kick from room');
      kick.onclick = () => {
        sendMsg(kickAction(p.id));
        closePopover();
      };
      popover.append(kick);
    }
    const r = anchor.getBoundingClientRect();
    popover.hidden = false;
    popover.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
    popover.style.top = r.bottom + 8 + 'px';
  }
  function closePopover() {
    popover.hidden = true;
  }
  document.addEventListener('mousedown', (e) => {
    if (!popover.hidden && !popover.contains(e.target)) closePopover();
  });

  // ── wire the join form and boot ────────────────────────────────────────────
  knockBtn.addEventListener('click', beginKnock);
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    beginKnock();
  });
  $('#dc-retry')?.addEventListener('click', () => location.reload());

  if (loc.isHostTab) {
    // Host tab: no name prompt — connect straight to its own room (name comes from
    // the shared state once live).
    joinScreen.hidden = false;
    connect({ code: loc.code, name: '', token: null, hostToken: loc.hostToken });
    joinForm.hidden = true;
    waiting.hidden = false;
  } else {
    showJoin();
    // A returning guest (room in the URL, name + identity token remembered) knocks
    // automatically — with the brain's auto-readmit, a reload glides straight back
    // into the room instead of parking on the join form.
    if (loc.code && store.get(NAME_KEY) && store.get(TOKEN_KEY)) beginKnock();
  }
}

// Run only in a browser; importing this module in node (tests) touches no DOM.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
}
