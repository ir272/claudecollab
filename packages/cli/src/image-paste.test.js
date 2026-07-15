import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeImagePayload,
  saveImageFile,
  looksLikeImagePath,
  MAX_IMAGE_BYTES,
  IMAGE_MIMES,
  CTRL_V,
} from './image-paste.js';

// Tiny valid-looking PNG header bytes (not a full image — we only check size/mime).
const TINY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

test('IMAGE_MIMES covers Claude-supported formats', () => {
  assert.equal(IMAGE_MIMES['image/png'], '.png');
  assert.equal(IMAGE_MIMES['image/jpeg'], '.jpg');
  assert.equal(IMAGE_MIMES['image/webp'], '.webp');
  assert.equal(CTRL_V, '\x16');
});

test('decodeImagePayload accepts a small png and rejects junk', () => {
  const ok = decodeImagePayload({ mime: 'image/png', data: TINY.toString('base64') });
  assert.ok(ok.buf);
  assert.equal(ok.ext, '.png');
  assert.equal(ok.mime, 'image/png');

  assert.match(decodeImagePayload({ mime: 'image/svg+xml', data: TINY.toString('base64') }).error, /unsupported/);
  assert.match(decodeImagePayload({ mime: 'image/png', data: '' }).error, /empty/);
  assert.match(decodeImagePayload({ mime: 'image/png' }).error, /empty/);
});

test('decodeImagePayload strips mime parameters and enforces the 5MB cap', () => {
  const ok = decodeImagePayload({ mime: 'image/jpeg; charset=binary', data: TINY.toString('base64') });
  assert.equal(ok.ext, '.jpg');

  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1);
  assert.match(decodeImagePayload({ mime: 'image/png', data: huge.toString('base64') }).error, /too large/);
});

test('saveImageFile writes unique temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-img-'));
  try {
    const a = saveImageFile({ buf: TINY, ext: '.png' }, dir);
    const b = saveImageFile({ buf: TINY, ext: '.png' }, dir);
    assert.notEqual(a, b);
    assert.ok(a.endsWith('.png'));
    assert.deepEqual(fs.readFileSync(a), TINY);
    assert.deepEqual(fs.readFileSync(b), TINY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('looksLikeImagePath recognizes image extensions', () => {
  assert.equal(looksLikeImagePath('/tmp/claudecollab-1.png'), true);
  assert.equal(looksLikeImagePath('  /x/Y.JPEG '), true);
  assert.equal(looksLikeImagePath('/tmp/notes.txt'), false);
  assert.equal(looksLikeImagePath(''), false);
});
