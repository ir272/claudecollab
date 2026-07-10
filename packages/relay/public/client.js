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
 * carries its browser `token` (returning identity) and claimed `name`.
 * @returns {string} e.g. "/ws?room=brave-otter&name=sid&token=abc"
 */
export function buildWsPath({ code, name, token, hostToken } = {}) {
  const q = new URLSearchParams();
  if (code) q.set('room', code);
  if (name) q.set('name', name);
  if (hostToken) q.set('host', hostToken);
  else if (token) q.set('token', token);
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
  // Never translate a Ctrl/Cmd combo — let the browser own copy/paste/etc.
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
 * @param {string} role  driver | prompter | viewer
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
  const rank = { viewer: 0, prompter: 1, driver: 2, host: 3 }[role] ?? 0;
  return {
    isViewer: rank < 1,
    canCompose: rank >= 1, // prompter+
    canDrive: rank >= 2, // driver+ (answer asks, slash/bash)
    isHost: rank >= 3,
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
  return { id: box?.id, text, authors, carets, focusedBySelf, segments: segmentBox(text, carets) };
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
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BROWSER APP  (guarded: nothing below runs when imported in node)
// ════════════════════════════════════════════════════════════════════════════

function main() {
  const TOKEN_KEY = 'claude-share:token';
  const NAME_KEY = 'claude-share:name';
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

  // ── DOM handles ──────────────────────────────────────────────────────────────
  const joinScreen = $('#join');
  const liveScreen = $('#live');
  const roomLabel = $('#join-room');
  const codeInput = $('#code-input');
  const nameInput = $('#name-input');
  const knockBtn = $('#knock-btn');
  const joinStatus = $('#join-status');
  const joinForm = $('#join-form');
  const waiting = $('#waiting');
  const stage = $('#stage');
  const termEl = $('#term');
  const cursorLayer = $('#cursors');
  const pausedCard = $('#paused');
  const trayClaude = $('#claude-chip');
  const trayDrafts = $('#drafts');
  const trayQueue = $('#queue');
  const composer = $('#composer');
  const composerHint = $('#composer-hint');
  const newDraftBtn = $('#new-draft');
  const viewerNote = $('#viewer-note');
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
    timeout: 'The host did not answer in time. Knock again when ready.',
  };

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
    connect({ code, name, token, hostToken: loc.hostToken });
  }

  // ── connection ───────────────────────────────────────────────────────────────
  function connect({ code, name, token, hostToken }) {
    phase = 'knocking';
    joinForm.hidden = true;
    waiting.hidden = false;
    $('#waiting-text').textContent = hostToken
      ? 'Opening your room…'
      : `Knocking — waiting for the host to let you in…`;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host + buildWsPath({ code, name, token, hostToken });
    try {
      ws = new WebSocket(url);
    } catch {
      return fail('no-room');
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {}; // nothing to send until admitted
    ws.onmessage = onMessage;
    ws.onclose = () => {
      if (intentionalClose) return;
      if (phase === 'live') showDisconnected();
      else if (phase !== 'error') fail('host-gone');
    };
    ws.onerror = () => {};
  }

  function onMessage(ev) {
    if (typeof ev.data !== 'string') {
      // Binary = screen bytes → feed the xterm mirror.
      if (term) term.write(new Uint8Array(ev.data));
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
        fail(msg.reason);
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
    setJoinStatus(ERRORS[reason] || 'Could not connect. Try again.', true);
  }

  function showDisconnected() {
    phase = 'closed';
    const banner = $('#dc-banner');
    banner.hidden = false;
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
      cursorBlink: false,
      disableStdin: true, // the draft tray owns input; the mirror is read-only
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 5000,
      theme: {
        background: '#0a0c12',
        foreground: '#e8ecf4',
        cursor: '#e8a33d',
        selectionBackground: 'rgba(232,163,61,0.28)',
        black: '#0a0c12',
        brightBlack: '#5b6472',
      },
    });
    term.open(termEl);
    const ro = new ResizeObserver(() => fit());
    ro.observe(stage);
    window.addEventListener('resize', fit);
    // Pointer capture over the terminal (the floating-cursor "Figma feel").
    stage.addEventListener('mousemove', onStageMove);
    stage.addEventListener('mouseleave', () => sendPointer(-1, -1)); // park off-canvas
  }

  // Manual fit — @xterm/addon-fit is not vendored, so we replicate its math from the
  // renderer's own measured cell size (accurate, matches what the addon does), with a
  // conservative fallback if the private field is unavailable.
  function fit() {
    if (!term) return;
    const rect = termEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    let cw = 0;
    let ch = 0;
    try {
      const cell = term._core?._renderService?.dimensions?.css?.cell;
      if (cell && cell.width && cell.height) {
        cw = cell.width;
        ch = cell.height;
      }
    } catch {
      /* fall through to estimate */
    }
    if (!cw || !ch) {
      cw = 13 * 0.6; // rough monospace advance for the 13px font
      ch = 13 * 1.1;
    }
    const cols = Math.max(2, Math.floor(rect.width / cw));
    const rows = Math.max(1, Math.floor(rect.height / ch));
    if (cols !== term.cols || rows !== term.rows) {
      try {
        term.resize(cols, rows);
      } catch {
        /* xterm not ready */
      }
    }
    sendMsg({ t: 'resize', cols: term.cols, rows: term.rows });
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
    const v = lastState ? overlayView(lastState, selfId) : null;
    if (v && v.canCompose && !composer.disabled) composer.focus();
  }
  composer.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) return; // let the browser own its shortcuts
    const bytes = keyToBytes(e);
    if (bytes != null) {
      e.preventDefault();
      sendKey(bytes);
    } else if (e.key.length === 1) {
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
  // Clicking anywhere in the tray (but not on a button) refocuses the catcher.
  $('#tray').addEventListener('mousedown', (e) => {
    if (e.target.closest('button, input, select, a')) return;
    setTimeout(focusComposer, 0);
  });
  newDraftBtn.addEventListener('click', () => {
    sendKey(NEW_DRAFT_BYTES);
    focusComposer();
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
    renderStatusbar(v);
    renderClaudeChip(v);
    renderPaused(v);
    renderDrafts(v);
    renderQueue(v);
    renderComposer(v);
    renderCursors(v);
    renderHeader(v);
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
    trayClaude.className = 'chip claude ' + v.claude.kind;
    trayClaude.textContent = v.claude.text;
  }

  function renderPaused(v) {
    pausedCard.hidden = !v.paused;
    stage.classList.toggle('paused', v.paused);
  }

  function renderDrafts(v) {
    trayDrafts.innerHTML = '';
    if (v.drafts.length === 0) {
      const empty = el('div', 'drafts-empty', 'No drafts yet. Start typing to compose one together.');
      trayDrafts.append(empty);
      return;
    }
    for (const d of v.drafts) {
      const box = el('div', 'draft' + (d.focusedBySelf ? ' focused' : ''));
      const border = el('div', 'draft-authors');
      for (const a of d.authors) {
        const pill = el('span', 'author-pill', a.name + (a.isSelf ? ' (you)' : ''));
        pill.style.setProperty('--c', a.color);
        border.append(pill);
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
      box.append(border, body);
      if (d.focusedBySelf) box.append(el('span', 'send-hint', '↵ sends'));
      trayDrafts.append(box);
    }
  }

  function renderQueue(v) {
    trayQueue.innerHTML = '';
    if (v.queue.length === 0) {
      trayQueue.hidden = true;
      return;
    }
    trayQueue.hidden = false;
    trayQueue.append(el('div', 'queue-label', 'Queued'));
    for (const q of v.queue) {
      const chip = el('div', 'queue-chip');
      const who = el('span', 'queue-who', q.name);
      who.style.setProperty('--c', q.color);
      chip.append(el('span', 'queue-n', '#' + q.n), who, el('span', 'queue-text', q.text));
      trayQueue.append(chip);
    }
  }

  function renderComposer(v) {
    const can = v.canCompose;
    composer.disabled = !can;
    newDraftBtn.disabled = !can;
    viewerNote.hidden = can;
    if (!can) {
      composerHint.textContent = '';
      return;
    }
    const focused = v.drafts.find((d) => d.focusedBySelf);
    composerHint.textContent = focused ? '⏎ sends · Shift+⏎ newline' : 'Type to start a draft';
  }

  function renderCursors(v) {
    const seen = new Set();
    const rect = termEl.getBoundingClientRect();
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
      node.style.transform = `translate(${(p.x * rect.width).toFixed(1)}px, ${(p.y * rect.height).toFixed(1)}px)`;
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
        chip.append(el('span', null, ' is knocking'));
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
      for (const r of ['viewer', 'prompter', 'driver']) {
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
  }
}

// Run only in a browser; importing this module in node (tests) touches no DOM.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
}
