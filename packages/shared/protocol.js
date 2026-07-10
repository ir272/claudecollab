// claude-share wire protocol: JSON-lines over the host's ssh channel to the relay.
// Guests speak no protocol — they exchange raw terminal bytes. Only the host<->relay
// control channel uses these messages.

/** Canonical message-type strings (the `t` field of every message). */
export const TYPES = Object.freeze({
  HELLO: 'hello', // host->relay: {t:'hello', want:'room'}          — new room
  RECLAIM: 'reclaim', // host->relay: {t:'reclaim', code}           — take back an existing room after a drop
  ROOM: 'room', // relay->host: {t:'room', code}                    — room granted (create OR reclaim)
  GONE: 'gone', // relay->host: {t:'gone', code}                    — reclaim refused (expired / wrong key)
  KNOCK: 'knock', // relay->host: {t:'knock', id, name, fp, seen}
  ADMIT: 'admit', // host->relay: {t:'admit', id}
  DENY: 'deny', // host->relay: {t:'deny', id}
  JOINED: 'joined', // relay->host: {t:'joined', id}
  LEFT: 'left', // relay->host: {t:'left', id}
  KEY: 'key', // relay->host: {t:'key', id, data}   (guest keystrokes, base64)
  RESIZE: 'resize', // relay->host: {t:'resize', id, cols, rows}
  SCREEN: 'screen', // host->relay: {t:'screen', data}  (broadcast frame, base64)
  TO: 'to', // host->relay: {t:'to', id, data}   (one guest only, base64)
  DROP: 'drop', // host->relay: {t:'drop', id, ban}
  END: 'end', // host->relay: {t:'end'}

  // ── overlay-state channel (browser multiplayer surface) ────────────────────
  // The browser is the multiplayer surface for everyone (host included): a plain
  // ssh guest still exchanges raw bytes, but a browser view renders a rich overlay
  // from the host's snapshot and mails back pointer moves and button-driven commands.
  STATE: 'state', // host->relay: {t:'state', data:{room, participants:[{id,name,role,color}],
  //   drafts:<Drafts.snapshot()>, queue:[{n,author,text}], claudeState:'busy'|'idle'|'ask',
  //   paused:bool, pointers:{id:{x,y,name,color}}, knocks:[{id,name,fp,seen}]}} — full
  //   overlay snapshot, emitted on every brain change (throttled ≤1/50ms); the relay
  //   fans it out to browser views. Knocks live IN the state (the host admits from the browser).
  POINTER: 'pointer', // guest->host (relay stamps `id` = sender): {t:'pointer', id?, x, y}
  //   x/y normalized 0..1 over the terminal canvas; the host rebroadcasts via state.pointers.
  UI: 'ui', // guest->host (relay stamps `id` = sender): {t:'ui', id?, action}
  //   action = {kind:'admit'|'deny', id} | {kind:'command', text}. The command text runs
  //   through the existing parser AS that sender, so the role gate still applies.
});

/**
 * Serialize a message to a newline-terminated JSON Buffer, ready to write to a stream.
 * @param {object} obj
 * @returns {Buffer}
 */
export function encode(obj) {
  return Buffer.from(JSON.stringify(obj) + '\n');
}

// Newline-free buffer cap (10 MB). Real messages are tiny (a full-repaint screen
// frame is a few KB of base64), so a partial line this large is a peer that
// never terminates — a memory-exhaustion flood. We drop it rather than grow.
const MAX_BUF = 10 * 1024 * 1024;

/**
 * Stateful, per-connection stream decoder. Feed it raw chunks (Buffer or string);
 * it buffers partial lines and returns an array of parsed messages once each line
 * is complete. One instance per ssh channel.
 */
export class Decoder {
  #buf = '';

  /**
   * @param {Buffer|string} chunk
   * @returns {object[]} messages completed by this chunk (possibly empty)
   */
  push(chunk) {
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out = [];
    let nl;
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Malformed line: drop it (spec: the relay and host drop anything that
        // fails the check). A single unparseable line must never sever the
        // connection or swallow the valid messages that follow it.
      }
    }
    // Only a newline-free remainder is left now. If it has outgrown the cap, no
    // terminator is coming — clear it so a peer can't exhaust memory.
    if (this.#buf.length > MAX_BUF) this.#buf = '';
    return out;
  }
}

/**
 * Stateless one-shot decode of a chunk that contains only complete lines
 * (e.g. the output of `encode`, which always ends in a newline). A trailing
 * partial line is ignored. For streaming input use a {@link Decoder}.
 * @param {Buffer|string} chunk
 * @returns {object[]}
 */
export function decode(chunk) {
  return new Decoder().push(chunk);
}

const isStr = (v) => typeof v === 'string';
const isNum = (v) => Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A {t:'ui'} action: a knock verdict (admit/deny, carrying the target knock id), a
// roster action (role/kick, carrying the target PARTICIPANT id — not a @-mention, so
// duplicate/space/unicode names can't mis-target), or a button-driven command (command
// text). Anything else is rejected — this is the boundary that lets a browser button
// drive the host, so it fails closed.
function isUiAction(a) {
  if (!isObj(a)) return false;
  if (a.kind === 'admit' || a.kind === 'deny' || a.kind === 'kick') return isStr(a.id);
  if (a.kind === 'role') return isStr(a.id) && isStr(a.role);
  if (a.kind === 'command') return isStr(a.text);
  if (a.kind === 'caret') return isStr(a.id) && isNum(a.offset); // click into a draft
  if (a.kind === 'delrange') return isStr(a.id) && isNum(a.start) && isNum(a.end); // delete a selection
  if (a.kind === 'deldraft') return isStr(a.id); // delete a whole draft box
  return false;
}

/**
 * Shallow structural validation of a decoded message. Returns true only for a
 * known type whose required fields are present and correctly typed. The relay
 * and host drop anything that fails this check.
 * @param {unknown} obj
 * @returns {boolean}
 */
export function validate(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  switch (obj.t) {
    case TYPES.HELLO:
      return obj.want === 'room';
    case TYPES.RECLAIM:
    case TYPES.ROOM:
    case TYPES.GONE:
      return isStr(obj.code);
    case TYPES.KNOCK:
      return (
        isStr(obj.id) &&
        isStr(obj.name) &&
        isStr(obj.fp) &&
        (isStr(obj.seen) || typeof obj.seen === 'boolean' || obj.seen === null)
      );
    case TYPES.ADMIT:
    case TYPES.DENY:
    case TYPES.JOINED:
    case TYPES.LEFT:
      return isStr(obj.id);
    case TYPES.KEY:
    case TYPES.TO:
      return isStr(obj.id) && isStr(obj.data);
    case TYPES.RESIZE:
      return isStr(obj.id) && isNum(obj.cols) && isNum(obj.rows);
    case TYPES.SCREEN:
      return isStr(obj.data);
    case TYPES.DROP:
      return isStr(obj.id) && typeof obj.ban === 'boolean';
    case TYPES.END:
      return true;
    // Overlay channel. Shallow, like the rest: `data` need only be a plain object
    // (browser views read it defensively). pointer/ui carry an optional sender `id`
    // the relay stamps on the guest→host hop; guest→relay forms omit it.
    case TYPES.STATE:
      return isObj(obj.data);
    case TYPES.POINTER:
      return isNum(obj.x) && isNum(obj.y) && (obj.id === undefined || isStr(obj.id));
    case TYPES.UI:
      return (obj.id === undefined || isStr(obj.id)) && isUiAction(obj.action);
    default:
      return false;
  }
}
