// Image paste support for browser guests. Claude Code reads images from the HOST
 // OS clipboard (Ctrl+V) or from a file path typed into the prompt — a guest's
 // clipboard never reaches that process. So the browser ships image bytes over
 // {t:'ui', action:{kind:'image'}}, and we land them on disk (and, when we can,
 // onto the host clipboard) here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Claude's documented per-image cap. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_MIMES = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
});

/** Ctrl+V — Claude Code's macOS image-paste chord (reads the OS clipboard). */
export const CTRL_V = '\x16';

/**
 * Decode + validate a browser image action payload.
 * @param {{mime?:string, data?:string}} action
 * @returns {{buf:Buffer, ext:string, mime:string}|{error:string}}
 */
export function decodeImagePayload(action = {}) {
  const mime = String(action.mime || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  const ext = IMAGE_MIMES[mime];
  if (!ext) return { error: 'unsupported image type (png/jpeg/gif/webp)' };
  let buf;
  try {
    buf = Buffer.from(String(action.data || ''), 'base64');
  } catch {
    return { error: 'bad image data' };
  }
  if (!buf.length) return { error: 'empty image' };
  if (buf.length > MAX_IMAGE_BYTES) return { error: 'image too large (max 5MB)' };
  return { buf, ext, mime };
}

/**
 * Write decoded image bytes to a unique temp file. Returns the absolute path.
 * @param {{buf:Buffer, ext:string}} decoded
 * @param {string} [dir]
 */
export function saveImageFile(decoded, dir = os.tmpdir()) {
  const name = `claudecollab-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${decoded.ext}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, decoded.buf);
  return file;
}

/**
 * Best-effort: put an image file on the host OS clipboard so Claude's Ctrl+V
 * attaches it natively. PNG is the reliable clipboard representation; other
 * formats return false and the caller should paste a path instead.
 * @param {string} filePath
 * @param {string} [mime]
 * @returns {boolean}
 */
export function copyImageToClipboard(filePath, mime = 'image/png') {
  const p = String(filePath);
  if (!p || !fs.existsSync(p)) return false;
  // Claude's mac clipboard read + most Linux tools want PNG bytes.
  if (mime !== 'image/png' && path.extname(p).toLowerCase() !== '.png') return false;

  if (process.platform === 'darwin') {
    const script = `set the clipboard to (read (POSIX file ${JSON.stringify(p)}) as «class PNGf»)`;
    const r = spawnSync('osascript', ['-e', script], { timeout: 8000, encoding: 'utf8' });
    return r.status === 0;
  }

  if (process.platform === 'linux') {
    let bytes;
    try {
      bytes = fs.readFileSync(p);
    } catch {
      return false;
    }
    // Wayland first, then X11.
    let r = spawnSync('wl-copy', ['--type', 'image/png'], { input: bytes, timeout: 8000 });
    if (r.status === 0) return true;
    r = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png'], {
      input: bytes,
      timeout: 8000,
    });
    return r.status === 0;
  }

  // Windows: raw clipboard images are unreliable in Claude Code from a PTY; callers
  // fall back to pasting the file path (Claude attaches images referenced by path).
  return false;
}

/** True when a paste token's real text is an image file path we should label `[image]`. */
export function looksLikeImagePath(text) {
  return /\.(png|jpe?g|gif|webp)$/i.test(String(text || '').trim());
}
