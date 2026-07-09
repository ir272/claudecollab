// Relay room registry — pure state, no ssh. Hands out unique room codes, tracks
// guests/bans/cap per room, runs the 10-minute host-drop TTL, and rate-limits
// knock attempts per ip. The ssh server (Task 2) wires this to real connections.

import { adjectives as defaultAdjectives, animals as defaultAnimals } from './wordlists.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // spec: code survives a 10-min host drop
const DEFAULT_CAP = 8; // spec: room cap, composer stays legible
const DEFAULT_KNOCK_LIMIT = 5; // spec: per-room lockout — 5 knock attempts/min per ip
const DEFAULT_KNOCK_WINDOW_MS = 60 * 1000;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Create an isolated room registry. All timing is injectable so tests stay
 * deterministic: `now` for knock windows, node:test fake timers for the TTL.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]          host-drop grace period before close
 * @param {number} [opts.cap]            max guests per room
 * @param {number} [opts.knockLimit]     knock attempts allowed per window per ip
 * @param {number} [opts.knockWindowMs]  sliding window for the knock limit
 * @param {() => number} [opts.now]      millisecond clock (defaults to Date.now)
 * @param {{adjectives:string[], animals:string[]}} [opts.wordlists]
 */
export function createRegistry(opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cap = opts.cap ?? DEFAULT_CAP;
  const knockLimit = opts.knockLimit ?? DEFAULT_KNOCK_LIMIT;
  const knockWindowMs = opts.knockWindowMs ?? DEFAULT_KNOCK_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const adjectives = opts.wordlists?.adjectives ?? defaultAdjectives;
  const animals = opts.wordlists?.animals ?? defaultAnimals;

  /** @type {Map<string, object>} code -> room */
  const rooms = new Map();

  function makeCode() {
    for (let i = 0; i < 5; i++) {
      const code = `${pick(adjectives)}-${pick(animals)}`;
      if (!rooms.has(code)) return code;
    }
    // 5 collisions: widen to a third word (spec fallback).
    for (let i = 0; i < 50; i++) {
      const code = `${pick(adjectives)}-${pick(animals)}-${pick(adjectives)}`;
      if (!rooms.has(code)) return code;
    }
    // Pathologically tiny wordlists: guarantee uniqueness with a numeric suffix.
    const base = `${pick(adjectives)}-${pick(animals)}-${pick(adjectives)}`;
    let n = 2;
    while (rooms.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  function create() {
    const code = makeCode();
    const room = {
      code,
      guests: new Map(), // id -> {name, fp, role}
      banned: new Set(), // banned fingerprints
      cap,
      hostPresent: true,
      createdAt: now(),
      _ttlTimer: null, // pending host-drop close timer
      _knocks: new Map(), // ip -> number[] (recent knock timestamps)
    };
    rooms.set(code, room);
    return room;
  }

  function get(code) {
    return rooms.get(code);
  }

  function addGuest(code, id, { name, fp, role } = {}) {
    const room = rooms.get(code);
    if (!room) return false;
    if (fp && room.banned.has(fp)) return false;
    if (room.guests.size >= room.cap) return false;
    room.guests.set(id, { name, fp, role: role ?? 'prompter' });
    return true;
  }

  function removeGuest(code, id) {
    const room = rooms.get(code);
    if (!room) return false;
    return room.guests.delete(id);
  }

  // Blocklist a fingerprint for the room's lifetime and evict any live guests
  // holding it (spec §host controls: /kick drops + blocklists the pubkey).
  function ban(code, fp) {
    const room = rooms.get(code);
    if (!room) return;
    room.banned.add(fp);
    for (const [id, g] of room.guests) {
      if (g.fp === fp) room.guests.delete(id);
    }
  }

  // Host connection dropped: start the grace timer that closes the room.
  function hostDropped(code) {
    const room = rooms.get(code);
    if (!room) return;
    room.hostPresent = false;
    if (room._ttlTimer) clearTimeout(room._ttlTimer);
    room._ttlTimer = setTimeout(() => close(code), ttlMs);
    if (typeof room._ttlTimer?.unref === 'function') room._ttlTimer.unref();
  }

  // Host reconnected in time: cancel the pending close.
  function hostReturned(code) {
    const room = rooms.get(code);
    if (!room) return;
    room.hostPresent = true;
    if (room._ttlTimer) {
      clearTimeout(room._ttlTimer);
      room._ttlTimer = null;
    }
  }

  function close(code) {
    const room = rooms.get(code);
    if (!room) return;
    if (room._ttlTimer) {
      clearTimeout(room._ttlTimer);
      room._ttlTimer = null;
    }
    rooms.delete(code);
  }

  // Record + rate-check a knock attempt. Returns false if the room is gone or
  // this ip has used up its allowance inside the sliding window.
  function tryKnock(code, ip) {
    const room = rooms.get(code);
    if (!room) return false;
    const t = now();
    const recent = (room._knocks.get(ip) ?? []).filter((ts) => t - ts < knockWindowMs);
    if (recent.length >= knockLimit) {
      room._knocks.set(ip, recent);
      return false;
    }
    recent.push(t);
    room._knocks.set(ip, recent);
    return true;
  }

  return { create, get, addGuest, removeGuest, ban, hostDropped, hostReturned, close, tryKnock };
}
