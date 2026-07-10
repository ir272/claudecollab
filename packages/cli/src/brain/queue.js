// The attributed queue — where sent drafts land while Claude is busy, and from
// which they drain, in order, one per idle turn (spec §queue). Pure logic; the
// wiring calls drain() from the 'idle' hook handler and feeds the released item
// to the PTY.
//
// Permissions (spec): the author may edit or delete their own item; the host and
// the host may delete anyone's. Draining is fail-closed — it only releases an item
// when Claude is *known* idle; any other (or unknown) state keeps the queue frozen
// so a missed hook can never auto-fire a stranger's prompt.

import { atLeast } from './state.js';

export class Queue {
  #items = [];
  #seq = 0;

  /** Append an attributed item; returns the stored record (with its id). */
  enqueue(text, author) {
    const item = { id: `q${++this.#seq}`, text: String(text), author };
    this.#items.push(item);
    return item;
  }

  /** Defensive copies so a caller can't mutate queue internals through a read. */
  get items() {
    return this.#items.map((i) => ({ ...i }));
  }

  get length() {
    return this.#items.length;
  }

  /** The front item (copy) without removing it, or null. */
  peek() {
    return this.#items[0] ? { ...this.#items[0] } : null;
  }

  /**
   * Edit a queued item's text. Author-only (spec): the host can DELETE any
   * item but may not rewrite what someone else meant to say.
   * @returns {boolean} true if edited
   */
  edit(id, text, byUserId, _byRole) {
    const it = this.#items.find((i) => i.id === id);
    if (!it || it.author !== byUserId) return false;
    it.text = String(text);
    return true;
  }

  /**
   * Delete a queued item. Allowed for the author, or for the host on any item.
   * @returns {boolean} true if removed
   */
  remove(id, byUserId, byRole) {
    const idx = this.#items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    const it = this.#items[idx];
    if (it.author !== byUserId && !atLeast(byRole, 'host')) return false;
    this.#items.splice(idx, 1);
    return true;
  }

  /** Drop every item authored by a user (they left or were kicked). Returns the count. */
  removeByAuthor(userId) {
    const before = this.#items.length;
    this.#items = this.#items.filter((i) => i.author !== userId);
    return before - this.#items.length;
  }

  /**
   * Release the front item — but only when Claude is *known* idle. Any other state
   * (busy, ask, or an ambiguous/undefined signal) returns null and leaves the queue
   * untouched (fail closed, spec §agent-state-detection).
   * @param {string} claudeState the current hook-derived state
   * @returns {{id:string,text:string,author:string}|null}
   */
  drain(claudeState) {
    if (claudeState !== 'idle') return null;
    return this.#items.shift() ?? null;
  }
}
