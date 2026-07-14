// The in-memory attributed log — the room's who-typed-what record (spec §host
// controls, §join context card). It captures three kinds of entry:
//
//   prompt  — a sent draft, attributed to its author (feeds the card + /recap)
//   event   — a room event: joins, leaves, role changes, kicks, mode flips, pause
//   tool    — a Claude PostToolUse, with the files it touched (feeds the card)
//
// The log lives only for the session. On /end the host chooses whether to persist
// it: N discards it, Y writes session.md via write(). toText() is the plain
// transcript /recap hands to a one-shot `claude -p`.

import fs from 'node:fs';

// Escape-injection guard: display copies only — pty-bound text stays raw (Claude
// must receive real bytes, including newlines). Pasted prompts land verbatim in
// join cards, the shared log, and session.md; a raw ESC/OSC/BEL there would inject
// terminal escapes into every guest's terminal and the saved file. This strips
// ANSI/OSC sequences wholesale, then any remaining C0 controls + DEL — but keeps
// \n and \t so multi-line prompts and tabs survive as plain text.
const ANSI = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

/**
 * Remove terminal control/escape sequences from a string, keeping printable text
 * plus newlines and tabs. Safe to run on any untrusted display string.
 * @param {string} s
 * @returns {string}
 */
export function stripControls(s) {
  return String(s).replace(ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export class Log {
  #entries = [];
  #files = [];
  #now;
  #startedAt;

  /** @param {object} [opts] @param {() => number} [opts.now] injectable clock */
  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
    this.#startedAt = now();
  }

  /** Record an attributed prompt (sanitized for display — the raw text still went to the pty). */
  prompt(author, text, at = this.#now()) {
    const e = { kind: 'prompt', author: stripControls(author), text: stripControls(text), at };
    this.#entries.push(e);
    return e;
  }

  /** Record a room event (join/leave/role/kick/mode/pause). */
  event(text, at = this.#now()) {
    const e = { kind: 'event', text: stripControls(text), at };
    this.#entries.push(e);
    return e;
  }

  /** Record a tool use and merge any touched files into the ordered unique list. */
  tool(name, files = [], at = this.#now()) {
    const list = Array.isArray(files) ? files : [];
    const e = { kind: 'tool', name, files: [...list], at };
    for (const f of list) if (f && !this.#files.includes(f)) this.#files.push(f);
    this.#entries.push(e);
    return e;
  }

  /** All entries, as copies. */
  get entries() {
    return this.#entries.map((e) => ({ ...e }));
  }

  /** The de-duplicated files touched so far, in first-touch order. */
  get files() {
    return [...this.#files];
  }

  get startedAt() {
    return this.#startedAt;
  }

  /** Just the prompt entries. */
  prompts() {
    return this.#entries.filter((e) => e.kind === 'prompt').map((e) => ({ ...e }));
  }

  /** The last `n` prompts, oldest→newest. */
  recentPrompts(n = 3) {
    const p = this.prompts();
    return p.slice(Math.max(0, p.length - n));
  }

  /** Author of the most recent prompt, or null. */
  lastPromptAuthor() {
    const p = this.#entries.filter((e) => e.kind === 'prompt');
    return p.length ? p[p.length - 1].author : null;
  }

  /** Plain attributed transcript — the input /recap feeds to `claude -p`. */
  toText() {
    return this.#entries
      .map((e) => {
        if (e.kind === 'prompt') return `${e.author}: ${e.text}`;
        if (e.kind === 'event') return `* ${e.text}`;
        if (e.kind === 'tool') return `[tool] ${e.name}${e.files.length ? ' ' + e.files.join(', ') : ''}`;
        return '';
      })
      .join('\n');
  }

  /**
   * Render the attributed log as a Markdown session record.
   * @param {object} [opts]
   * @param {string} [opts.title]  document title
   * @returns {string}
   */
  toMarkdown({ title = 'claude-share session' } = {}) {
    const rel = (at) => {
      const s = Math.max(0, Math.round((at - this.#startedAt) / 1000));
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    };
    const lines = [`# ${title}`, ''];
    for (const e of this.#entries) {
      if (e.kind === 'prompt') lines.push(`- \`${rel(e.at)}\` **${e.author}**: ${e.text}`);
      else if (e.kind === 'event') lines.push(`- \`${rel(e.at)}\` _${e.text}_`);
      else if (e.kind === 'tool')
        lines.push(`- \`${rel(e.at)}\` \`${e.name}\`${e.files.length ? ' — ' + e.files.join(', ') : ''}`);
    }
    if (this.#files.length) {
      lines.push('', '## Files touched', '', ...this.#files.map((f) => `- ${f}`));
    }
    return lines.join('\n') + '\n';
  }

  /** Write the Markdown record to a file (spec §host controls: /end → session.md). */
  write(filePath, opts) {
    fs.writeFileSync(filePath, this.toMarkdown(opts));
    return filePath;
  }
}
