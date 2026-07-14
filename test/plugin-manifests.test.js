// Structural checks on the in-repo plugin (spec phase 5a). We validate the manifests
// and frontmatter parse and carry the required fields against the OFFICIAL schema
// (code.claude.com/docs/en/plugins + /plugin-marketplaces). We never run `claude
// plugin` against the real user config — Ian tests the plugin interactively; this
// only proves the files are well formed and wired to the right names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// Minimal YAML-frontmatter reader (no YAML dep — no new deps allowed). Pulls the
// block between the first pair of `---` fences into flat key -> string pairs.
function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    fm[key] = val;
  }
  return fm;
}

const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

test('marketplace.json: valid, required fields, points at ./plugin', () => {
  const p = join(repoRoot, '.claude-plugin', 'marketplace.json');
  assert.ok(existsSync(p), 'the root marketplace manifest exists');
  const mp = readJson('.claude-plugin/marketplace.json');
  assert.equal(typeof mp.name, 'string', 'marketplace has a name');
  assert.equal(mp.name, 'claudecollab', 'marketplace name matches the install docs (@claudecollab)');
  assert.ok(mp.owner && typeof mp.owner.name === 'string', 'marketplace has an owner.name');
  assert.ok(Array.isArray(mp.plugins) && mp.plugins.length >= 1, 'marketplace lists at least one plugin');
  const entry = mp.plugins.find((e) => e.name === 'collab');
  assert.ok(entry, 'the collab plugin is listed');
  assert.equal(entry.source, './plugin', 'the plugin source is the in-repo ./plugin path');
  assert.equal(typeof entry.description, 'string', 'the plugin entry has a description');
});

test('plugin.json: valid, name is the collab namespace', () => {
  const p = join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json');
  assert.ok(existsSync(p), 'the plugin manifest exists at plugin/.claude-plugin/plugin.json');
  const pj = readJson('plugin/.claude-plugin/plugin.json');
  assert.equal(pj.name, 'collab', 'plugin name is the /collab namespace and matches the marketplace entry');
  assert.equal(typeof pj.description, 'string', 'plugin has a description');
});

test('/collab command: frontmatter parses with description, argument-hint, allowed-tools', () => {
  const p = join(repoRoot, 'plugin', 'commands', 'collab.md');
  assert.ok(existsSync(p), 'the /collab command file exists');
  const md = readFileSync(p, 'utf8');
  const fm = parseFrontmatter(md);
  assert.ok(fm, 'the command frontmatter parses');
  assert.equal(typeof fm.description, 'string', 'command has a description');
  assert.ok(fm['argument-hint'] && fm['argument-hint'].length, 'command has an argument-hint');
  assert.match(fm['allowed-tools'], /Bash/, 'command allows Bash (it runs collab go)');
  // The body must teach the safety rule: never share a host= link.
  assert.match(md, /host=/, 'the command body names the host= link as the thing never to share');
  assert.match(md, /collab go/, 'the command body drives `collab go`');
});

test('collab-invite skill: frontmatter parses with a trigger description', () => {
  const p = join(repoRoot, 'plugin', 'skills', 'collab-invite', 'SKILL.md');
  assert.ok(existsSync(p), 'the collab-invite skill exists');
  const md = readFileSync(p, 'utf8');
  const fm = parseFrontmatter(md);
  assert.ok(fm, 'the skill frontmatter parses');
  assert.equal(typeof fm.description, 'string', 'the skill has a description');
  assert.ok(fm.description.length <= 1024, 'the description is within the trigger budget');
  // Teaches the two env vars and the safety rule.
  assert.match(md, /CLAUDE_SHARE_ROOM_FILE/, 'the skill teaches the room-file env var');
  assert.match(md, /CLAUDE_SHARE_CTL/, 'the skill teaches the control-socket env var');
  assert.match(md, /host=/, 'the skill teaches the never-share-host= rule');
});
