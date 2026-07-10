// Room-URL helpers + the room-ready toast — pure so they are unit-testable and so the
// host/guest URL distinction lives in exactly one place.
//
// TWO different URLs, and mixing them up is a security bug:
//   • hostUrl  — carries ?host=<token>. Whoever opens it is auto-admitted as HOST (no
//     knock): they can /end, /kick, set roles, /pause. This is for the host's OWN tab.
//   • inviteUrl — token-free. This is the safe link to hand a friend; they land on the
//     normal knock/roles flow. This is what we copy to the clipboard.
// The earlier code surfaced ONLY the hostUrl (status line + clipboard + "link copied"),
// so the natural "paste the clipboard link to a friend" flow silently granted the host
// seat. Keep them separate: hostUrl on the host's own status line, inviteUrl on the
// clipboard and the host tab's "copy invite" button.

// A deployed relay advertises its public https origin (`base`) in the room grant;
// links then carry that origin. Localhost dev has no base → http://host:port.
function origin({ base, host, port }) {
  if (base) return String(base).replace(/\/+$/, '');
  return `http://${host}:${port}`;
}

/** The host's own tab URL — carries the host token (auto-admit as host). */
export function hostUrl({ base, host, port, code, token }) {
  return `${origin({ base, host, port })}/${code}?host=${token}`;
}

/** The token-free invite URL — the safe link to share with guests. */
export function inviteUrl({ base, host, port, code }) {
  return `${origin({ base, host, port })}/${code}`;
}

/**
 * The "room ready" toast. Only claims the clipboard when the copy actually happened —
 * the copy is macOS-only, opt-out via CLAUDE_SHARE_NO_CLIPBOARD, and can fail. Claiming
 * it unconditionally (as before) told a linux/opt-out/failed host the link was on the
 * clipboard when it was not, which — with a truncated status line — could leave them
 * unable to reach their own room.
 * @param {boolean} copied  did the invite actually land on the clipboard?
 */
export function readyToast(copied) {
  return copied
    ? 'room ready · invite link copied to clipboard'
    : 'room ready · copy the invite from your host tab';
}
