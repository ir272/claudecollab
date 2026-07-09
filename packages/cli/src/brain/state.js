// Room state — the host brain's canonical view of who is in the room, what role
// each holds, Claude's current permission mode, whether sharing is paused, and
// how big the shared screen may be (spec §roles, §renderer size clamp).
//
// Pure state, no I/O. The relay client feeds it join/leave/resize; the hook
// listener feeds it the mode; commands mutate roles/pause. The renderer and the
// join-context card read it. Roles rank here so gate.js / queue.js / commands.js
// share one source of truth for "who outranks whom".

/** Role names, lowest privilege first. */
export const ROLES = Object.freeze(['viewer', 'prompter', 'driver', 'host']);

/** Numeric privilege rank — higher answers more (spec §roles table). */
export const ROLE_RANK = Object.freeze({ viewer: 0, prompter: 1, driver: 2, host: 3 });

/**
 * Is `role` at least as privileged as `min`? Fails closed: an unknown actor role
 * ranks below everything, and an unknown required floor is unreachable.
 * @param {string} role
 * @param {string} min
 * @returns {boolean}
 */
export function atLeast(role, min) {
  const have = ROLE_RANK[role];
  const need = ROLE_RANK[min];
  if (have == null || need == null) return false;
  return have >= need;
}

// Spec §renderer: the shared view is clamped to the smallest participant's
// terminal, floored at 80×24. A participant below the floor spectates instead of
// shrinking the room for everyone.
export const FLOOR_COLS = 80;
export const FLOOR_ROWS = 24;

/** The host's own participant id (the host is not a relay guest). */
export const HOST_ID = 'host';

export class RoomState {
  /** @type {Map<string,{id:string,name:string,fp:string|null,role:string,cols?:number,rows?:number}>} */
  participants = new Map();
  mode = 'default';
  paused = false;
  room = null;
  startedAt;

  #defaultRole;
  #now;

  /**
   * @param {object} [opts]
   * @param {string} [opts.hostName='host']       display name for the host
   * @param {string} [opts.defaultRole='prompter'] role new guests get (spec default)
   * @param {{cols:number,rows:number}} [opts.hostSize] the host terminal size
   * @param {() => number} [opts.now]             injectable clock (ms)
   */
  constructor({ hostName = 'host', defaultRole = 'prompter', hostSize, now = () => Date.now() } = {}) {
    this.#now = now;
    this.#defaultRole = defaultRole;
    this.startedAt = now();
    this.participants.set(HOST_ID, {
      id: HOST_ID,
      name: hostName,
      fp: null,
      role: 'host',
      cols: hostSize?.cols,
      rows: hostSize?.rows,
    });
  }

  setRoom(code) {
    this.room = code;
  }

  /** Update the permission mode; returns true only if it actually changed. */
  setMode(mode) {
    if (mode === this.mode) return false;
    this.mode = mode;
    return true;
  }

  setPaused(paused) {
    this.paused = !!paused;
  }

  get(id) {
    return this.participants.get(id);
  }

  roleOf(id) {
    return this.participants.get(id)?.role ?? null;
  }

  nameOf(id) {
    return this.participants.get(id)?.name ?? null;
  }

  /** All participants including the host, in insertion order. */
  list() {
    return [...this.participants.values()];
  }

  /** Just the guests (everyone but the host). */
  guests() {
    return this.list().filter((p) => p.id !== HOST_ID);
  }

  /** Add a guest at the room's default role (or an explicit one). Returns the record. */
  addGuest(id, { name, fp, role } = {}) {
    const p = {
      id,
      name: name ?? 'guest',
      fp: fp ?? null,
      role: role ?? this.#defaultRole,
      cols: undefined,
      rows: undefined,
    };
    this.participants.set(id, p);
    return p;
  }

  /** Drop a guest. The host can never be removed. */
  removeGuest(id) {
    if (id === HOST_ID) return false;
    return this.participants.delete(id);
  }

  /**
   * Set a guest's role. Refuses to touch the host, to promote anyone to host, or
   * to set an unknown role (spec: host is fixed; /role targets driver|prompter|viewer).
   */
  setRole(id, role) {
    const p = this.participants.get(id);
    if (!p || id === HOST_ID) return false;
    if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, role) || role === 'host') return false;
    p.role = role;
    return true;
  }

  /** Record a participant's terminal size (host or guest). */
  setSize(id, cols, rows) {
    const p = this.participants.get(id);
    if (!p) return false;
    p.cols = cols;
    p.rows = rows;
    return true;
  }

  /** True if this participant's terminal is below the 80×24 floor (they spectate). */
  belowFloor(id) {
    const p = this.participants.get(id);
    if (!p) return false;
    return (p.cols != null && p.cols < FLOOR_COLS) || (p.rows != null && p.rows < FLOOR_ROWS);
  }

  /**
   * The shared view dimensions: the component-wise minimum over participants that
   * meet the floor, then raised to the 80×24 floor. Below-floor participants are
   * excluded (they spectate) and participants of unknown size do not constrain it.
   * @returns {{cols:number, rows:number}}
   */
  clamp() {
    let cols = Infinity;
    let rows = Infinity;
    for (const p of this.participants.values()) {
      if (this.belowFloor(p.id)) continue;
      if (p.cols != null) cols = Math.min(cols, p.cols);
      if (p.rows != null) rows = Math.min(rows, p.rows);
    }
    if (!Number.isFinite(cols)) cols = FLOOR_COLS;
    if (!Number.isFinite(rows)) rows = FLOOR_ROWS;
    return { cols: Math.max(FLOOR_COLS, cols), rows: Math.max(FLOOR_ROWS, rows) };
  }

  /** Milliseconds since the session started (uses the injected clock). */
  ageMs() {
    return this.#now() - this.startedAt;
  }
}
