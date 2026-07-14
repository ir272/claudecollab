// The first-run screen — shown once, on the first interactive `collab`. It states the
// required core (the /collab plugin), offers an optional connector multi-select for
// link delivery, and carries the relay/donate footer. Copy is the approved mock v3 —
// do NOT rewrite it. Pure I/O injection: input/output are passed in, so the whole
// screen is testable by feeding byte sequences (no real TTY).
//
// A hand-rolled raw-mode picker (no dependency): ↑/↓ move the cursor, space toggles
// the highlighted connector, enter starts claude. No alt-screen — it prints in place,
// redrawing by moving the cursor up and clearing to the end of the screen.

/** The connectors offered for link delivery. Slack is the sensible default-on pick. */
export const DEFAULT_CONNECTORS = [
  { key: 'slack', label: 'Slack', hint: 'DM the join link to a teammate', checked: true },
  { key: 'gmail', label: 'Gmail', hint: 'email it', checked: false },
  { key: 'discord', label: 'Discord', hint: 'DM it to a friend', checked: false },
];

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
      const arrow = i === cursor ? '▸' : ' ';
      const box = it.checked ? '[x]' : '[ ]';
      return `${arrow} ${box} ${it.label.padEnd(10)}${it.hint}`;
    });
    return [
      '',
      '  ✦ collab — first run',
      '',
      '  ✓ /collab will be added to Claude Code   (required — it IS the product)',
      '       claude          ← start like you always do',
      '       /collab @james  ← the moment you want company',
      '',
      '  optional: let /collab @name deliver your join link for you.',
      "  it sends through YOUR accounts, using Claude's connectors. pick any:",
      '',
      ...rows,
      '',
      '  collaborations run through our free server (claudecollab.org).',
      '  want to run your own? `collab relay` — guide in the README.',
      '  please consider donating so we can keep this open ♥',
      '',
      '  ↑↓ move · space toggle · enter start claude',
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
