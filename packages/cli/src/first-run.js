// The first-run screen — shown once, on the first interactive `collab`. It states the
// core (the /collab plugin), offers the connector picker for link delivery, and
// carries the relay footer. Copy is Ian-approved (revised 2026-07-15) — do NOT
// rewrite it. Pure I/O injection: input/output are passed in, so the whole screen is
// testable by feeding byte sequences (no real TTY).
//
// A hand-rolled raw-mode picker (no dependency): ↑/↓ move the cursor, space toggles
// the highlighted connector, enter starts claude. No alt-screen — it prints in place,
// redrawing by moving the cursor up and clearing to the end of the screen.

/** The connectors offered for link delivery. Slack only for now (Ian, 2026-07-15). */
export const DEFAULT_CONNECTORS = [
  { key: 'slack', label: 'Slack', hint: 'DM the join link to a teammate', checked: true },
];

// ── styling (the approved mock's visual layer: orange accent = the band's color,
// green ✓, dim grays, a highlighted selection row, kbd chips). NO_COLOR disables
// every code; the words themselves never change — tests match on stripped text.
const useColor = !process.env.NO_COLOR;
const sgr = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const o = (s) => sgr('1;38;5;214', s); // orange, bold — the band accent
const g = (s) => sgr('1;32', s); // green — the "already done" checkmark
const d = (s) => sgr('38;5;245', s); // dim gray — secondary copy
const b = (s) => sgr('1', s); // bold
const chip = (s) => (useColor ? `\x1b[48;5;236m\x1b[38;5;252m${s}\x1b[0m` : s); // kbd key chip (no padding — stripped text stays byte-equal to the approved copy)
const selRow = (s) => (useColor ? `\x1b[48;5;236m${s}\x1b[0m` : s); // highlighted picker row

// ── the CLAUDE COLLAB wordmark (the skills-installer look: chunky block glyphs with
// a light→dark gray gradient per row). 5-row bitmap font, only the letters we need.
// Width: "CLAUDE COLLAB" renders 75 cols incl. indent — under the 80-col floor; a
// narrower terminal gets the plain one-line title instead of wrapped soup.
const FONT = {
  A: ['█████', '█   █', '█████', '█   █', '█   █'],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  C: ['█████', '█    ', '█    ', '█    ', '█████'],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '███  ', '█    ', '█████'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
  U: ['█   █', '█   █', '█   █', '█   █', '█████'],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};
const GRADIENT = ['223', '216', '215', '214', '208']; // light → deep orange (the band accent family)
function wordmark(text) {
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const line = [...text].map((ch) => FONT[ch]?.[r] ?? '     ').join(' ');
    rows.push(useColor ? `\x1b[38;5;${GRADIENT[r]}m${line}\x1b[0m` : line);
  }
  return rows;
}

/**
 * Render the first-run screen and drive the picker.
 * @param {object} opts
 * @param {NodeJS.ReadableStream} [opts.input]   raw key source (default process.stdin)
 * @param {{write:(s:string)=>void}} [opts.output] screen sink (default process.stdout)
 * @param {Array} [opts.connectors]              connector rows (default DEFAULT_CONNECTORS)
 * @returns {Promise<{connectors:string[]}>}     the checked connector keys, in order
 */
export function runFirstRun({ input = process.stdin, output = process.stdout, connectors = DEFAULT_CONNECTORS } = {}) {
  const items = connectors.map((c) => ({ ...c }));
  let cursor = 0;
  let lastLines = 0;
  let pending = ''; // a partial escape sequence straddling two chunks

  const frame = () => {
    const rows = items.map((it, i) => {
      const sel = i === cursor;
      const arrow = sel ? o('▸') : ' ';
      const box = it.checked ? o('[x]') : '[ ]';
      const body = ` ${box} ${b(it.label.padEnd(10))}${d(it.hint)} `;
      return `${arrow}${sel ? selRow(body) : body}`;
    });
    // The wordmark needs ~75 cols; a narrower terminal gets the plain title so the
    // blocks never wrap into soup. Injected test outputs have no .columns → wordmark.
    const wide = output.columns === undefined || output.columns >= 76;
    const mark = wordmark('CLAUDE COLLAB');
    const title = wide ? mark.map((l) => `  ${l}`) : [`  ${o('✦ claudecollab')}`];
    // The rule spans exactly the wordmark's width (strip the color codes to measure).
    const ruleWidth = wide ? mark[0].replace(/\x1b\[[0-9;]*m/g, '').length : 58;
    return [
      '',
      ...title,
      `  ${sgr('38;5;208', '─'.repeat(ruleWidth))}`,
      '',
      `  ${g('✓')} /collab will be added to Claude Code`,
      `       ${b('claude')}    ${d('← start like you always do')}`,
      `       ${b('/collab')}   ${d('← run /collab to turn it multiplayer!')}`,
      '',
      `  ${d("Select Claude's connectors:")}`,
      '',
      ...rows,
      '',
      `  ${d('collaborations run through our free server (claudecollab.org).')}`,
      `  ${d('want to run your own? `collab relay` — guide in the README.')} ${o('♥')}`,
      '',
      `  ${chip('↑↓')} ${d('move ·')} ${chip('space')} ${d('toggle ·')} ${chip('enter')} ${d('start claude')}`,
    ];
  };

  const paint = () => {
    const lines = frame();
    let out = '';
    if (lastLines > 0) out += `\x1b[${lastLines}A`; // back up over the previous frame
    out += '\x1b[0J'; // clear from the cursor to the end of the screen
    out += lines.join('\r\n') + '\r\n';
    lastLines = lines.length;
    output.write(out);
  };

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      input.removeListener('data', onData);
      try {
        input.setRawMode?.(false);
      } catch {}
      resolve({ connectors: items.filter((it) => it.checked).map((it) => it.key) });
    };

    const onData = (chunk) => {
      let buf = pending + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      pending = '';
      while (buf.length) {
        if (buf[0] === '\x1b') {
          if (buf.startsWith('\x1b[A') || buf.startsWith('\x1bOA')) {
            cursor = (cursor - 1 + items.length) % items.length;
            buf = buf.slice(3);
            paint();
            continue;
          }
          if (buf.startsWith('\x1b[B') || buf.startsWith('\x1bOB')) {
            cursor = (cursor + 1) % items.length;
            buf = buf.slice(3);
            paint();
            continue;
          }
          if (buf.length < 3) {
            pending = buf; // incomplete escape — wait for the rest of the sequence
            return;
          }
          buf = buf.slice(1); // an escape we don't handle — drop the ESC, keep going
          continue;
        }
        const ch = buf[0];
        buf = buf.slice(1);
        if (ch === ' ') {
          items[cursor].checked = !items[cursor].checked;
          paint();
        } else if (ch === '\r' || ch === '\n' || ch === '\x03') {
          // Enter starts claude; Ctrl-C also proceeds (never leaves the user stuck).
          return finish();
        }
      }
    };

    try {
      input.setRawMode?.(true);
    } catch {}
    input.resume?.();
    input.on('data', onData);
    paint();
  });
}
