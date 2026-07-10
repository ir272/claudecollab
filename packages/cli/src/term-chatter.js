// Terminal "chatter" vs human typing.
//
// Claude Code queries the terminal (device attributes, version) and enables
// mouse tracking. The terminal ANSWERS on stdin — DA replies, DCS version
// strings, SGR mouse reports, focus events. Those bytes are machine chatter
// addressed to Claude, not prompt text; fed into the composer they render as
// garbage like "[<35;34;4M" (real dogfood bug, 2026-07-09).
//
// partitionInput() splits a chunk into { chatter, human, carry }:
//   chatter — forward to Claude's PTY (host) or drop (guests)
//   human   — everything else: printable keys + the editing escapes the
//             composer keymap understands (arrows, home/end, alt-word…)
//   carry   — an incomplete sequence at the chunk's tail; prepend to the
//             next chunk before partitioning again.

const ESC = '\x1b';

// Complete chatter sequences, anchored at an ESC.
const CHATTER = [
  /^\x1b\[\?[\d;]*c/, // DA1 reply: ESC [ ? 62;22;52 c
  /^\x1b\[>[\d;]*c/, // DA2 reply: ESC [ > 1;10;0 c
  /^\x1b\[[\d;]*R/, // cursor position report
  /^\x1b\[<[\d;]+[Mm]/, // SGR mouse report
  /^\x1b\[[IO]/, // focus in / out
  /^\x1bP[^\x1b\x07]*(?:\x1b\\|\x07)/, // DCS reply (e.g. XTVERSION: ESC P > | ghostty 1.3.1 ESC \)
  /^\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/, // OSC reply (color queries etc.)
];

// Could this tail still become a chatter sequence with more bytes?
// Conservative prefix test: ESC alone, or ESC + opener + params with no final.
const MAYBE_PREFIX = /^\x1b(?:$|\[(?:$|[<>?]?[\d;]*$)|P[^\x1b\x07]*$|\][^\x1b\x07]*$|P[^\x1b\x07]*\x1b$|\][^\x1b\x07]*\x1b$)/;

export function partitionInput(s) {
  let chatter = '';
  let human = '';
  let carry = '';
  let i = 0;
  while (i < s.length) {
    const esc = s.indexOf(ESC, i);
    if (esc === -1) {
      human += s.slice(i);
      break;
    }
    human += s.slice(i, esc);
    const rest = s.slice(esc);
    let matched = null;
    for (const re of CHATTER) {
      const m = re.exec(rest);
      if (m) {
        matched = m[0];
        break;
      }
    }
    if (matched) {
      chatter += matched;
      i = esc + matched.length;
    } else if (rest === ESC) {
      // A chunk that is exactly ESC is the Escape KEY (interrupt) — deliver it
      // now. Chatter sequences never arrive as a bare trailing ESC chunk.
      human += ESC;
      break;
    } else if (MAYBE_PREFIX.test(rest)) {
      carry = rest; // incomplete — decide when the rest arrives
      break;
    } else {
      // A real escape sequence, but not chatter (arrow key, alt-word, paste
      // guard…) — the composer keymap owns it. Emit the ESC and move on; the
      // rest of the sequence flows through as ordinary bytes.
      human += ESC;
      i = esc + 1;
    }
  }
  return { chatter, human, carry };
}

/** Stateful wrapper: feeds carry back in across chunks. */
export function createPartitioner() {
  let carry = '';
  return (chunk) => {
    const out = partitionInput(carry + chunk.toString('binary'));
    carry = out.carry;
    return out;
  };
}
