// Shared display-name sanitizer for BOTH relay doors (ssh + web). A claimed name is
// untrusted input that the host CLI later writes verbatim to its terminal (join/leave
// toasts, the attributed log, session.md, /recap) and mirrors to every ssh guest — so
// a name carrying raw ESC/OSC/BEL bytes is a terminal-escape injection from a URL
// parameter or a pasted ssh name. The ssh door already filters name bytes to printable
// ASCII (0x20–0x7e) as it echoes them; the web door read `?name=` straight off the
// query string and skipped that filter. Both now route through this one function.

const MAX_NAME = 24; // spec: names cap at 24 cells

/**
 * Reduce a claimed name to printable ASCII, trim, cap at 24, and fall back when empty.
 * Mirrors the ssh door's per-byte filter (0x20 ≤ c ≤ 0x7e): control bytes (ESC 0x1b,
 * BEL 0x07, CR/LF, …) and every non-ASCII byte are dropped, so the survivor can only
 * ever be a plain one-line label — never an escape sequence.
 * @param {unknown} raw       the claimed name (a query param or typed bytes)
 * @param {string} [fallback='guest'] used when nothing printable remains
 * @returns {string}
 */
export function sanitizeName(raw, fallback = 'guest') {
  let out = '';
  for (const ch of String(raw ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) out += ch;
  }
  return out.trim().slice(0, MAX_NAME) || fallback;
}
