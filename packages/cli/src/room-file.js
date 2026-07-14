// The room file — how the Claude INSIDE the session learns its own invite link
// (env CLAUDE_SHARE_ROOM_FILE names it). Whitelist, not caller discipline: the
// host URL carries the seat token and must never reach the child-readable file.
import fs from 'node:fs';
const FIELDS = ['room', 'inviteUrl', 'webUrl'];
export function writeRoomFile(file, info = {}) {
  const out = {};
  for (const k of FIELDS) if (typeof info[k] === 'string' && info[k]) out[k] = info[k];
  try {
    fs.writeFileSync(file, JSON.stringify(out) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false; // a tmpfile problem must never take the session down
  }
}
export function clearRoomFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone / never written */
  }
}
