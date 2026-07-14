// The room's turn history — every prompt sent to Claude, attributed to the person
// who sent it, paired with Claude's response. This is what each person's window
// shows: "who typed what", and what Claude answered.
//
// A turn opens when a queued prompt is actually written to Claude (the drain edge)
// and closes when Claude finishes (the Stop hook), at which point the response text
// is attached. At most one turn is open at a time — Claude runs one prompt per idle.
//
// The log lives only for the session (matches how rooms already work: a relay
// restart ends them). Only a bounded tail is kept so the state snapshot the browser
// polls can never grow without limit.

const MAX_TURNS = 60;

export class History {
  /** @type {{id:number, author:string, prompt:string, response:string, running:boolean, at:number}[]} */
  #turns = [];
  #openId = null; // id of the turn awaiting a response, or null
  #seq = 0;
  #now;

  /** @param {object} [opts] @param {() => number} [opts.now] injectable clock */
  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  /**
   * Open a turn: a prompt has just gone to Claude. Returns the turn id.
   * @param {string} author  participant id who sent it
   * @param {string} prompt  the prompt text
   */
  start(author, prompt) {
    const id = ++this.#seq;
    this.#turns.push({ id, author, prompt: String(prompt ?? ''), response: '', running: true, at: this.#now() });
    if (this.#turns.length > MAX_TURNS) this.#turns.shift();
    this.#openId = id;
    return id;
  }

  /** Is a turn currently awaiting its response? */
  get open() {
    return this.#openId != null;
  }

  /**
   * Close the open turn with Claude's response text. No-op if nothing is open
   * (e.g. a prompt typed straight into Claude, not from a window).
   * @param {string} response
   */
  finish(response) {
    if (this.#openId == null) return false;
    const turn = this.#turns.find((t) => t.id === this.#openId);
    if (turn) {
      turn.response = String(response ?? '');
      turn.running = false;
    }
    this.#openId = null;
    return true;
  }

  /** Renderer-facing serialisation: plain objects, oldest→newest. */
  snapshot() {
    return this.#turns.map((t) => ({
      id: t.id,
      author: t.author,
      prompt: t.prompt,
      response: t.response,
      running: t.running,
      at: t.at,
    }));
  }
}
