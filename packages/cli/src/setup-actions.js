// The first-run side effects, split out from the bin so they're execFile-injectable
// and unit-testable without a real HOME or a real `claude` on PATH.
//
//   • installPlugin      — `claude plugin marketplace add` + `install` (best-effort)
//   • installShimAction  — write the `claude` shim + rc edit (see shim.js)
//   • connectorInstructions — honest per-connector guidance (see the docs note below)
//   • runActions/runSetup — the orchestrated first-run: screen → actions → marker
//   • undoSetup          — reverse the shim + best-effort plugin uninstall
//   • shouldRunSetup + marker helpers — the trigger gate
//
// CONNECTOR MECHANICS (verified against code.claude.com/docs/en/mcp, 2026-07-14):
// `claude mcp add --transport http <name> <url>` is the documented non-interactive
// add, but it needs a KNOWN server URL, and the docs publish NO official server URLs
// for the user-facing Slack / Gmail / Discord connectors — those are claude.ai
// connectors, added in the browser at claude.ai/customize/connectors, after which they
// appear in Claude Code automatically. There is no documented CLI one-liner for them,
// so we print the exact instruction instead of inventing a server URL (plan's graceful
// degradation). Even remote servers added via the CLI still need interactive OAuth.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installShim, removeShim } from './shim.js';
import { runFirstRun } from './first-run.js';

const pexec = promisify(nodeExecFile);
const CONNECTOR_LABELS = { slack: 'Slack', gmail: 'Gmail', discord: 'Discord' };

/** The shown-once marker: `<home>/.claude-share/setup-done`. Brand stays out of paths. */
export function markerPath(home = os.homedir()) {
  return path.join(home, '.claude-share', 'setup-done');
}

/** True once the first-run screen has completed at least once. */
export function setupDone(home = os.homedir()) {
  return fs.existsSync(markerPath(home));
}

/** Record that setup ran (best-effort; a write failure just means we may re-show it). */
export function writeMarker(home = os.homedir()) {
  const p = markerPath(home);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, new Date().toISOString() + '\n');
  } catch {
    /* home not writable — the screen may show again next run, which is harmless */
  }
}

/**
 * The trigger gate. Show the first-run screen iff we're interactive on both ends, no
 * skip env, no --yes, and the marker isn't set. Pure — so it's unit-tested directly.
 */
export function shouldRunSetup({ stdinTTY, stdoutTTY, home = os.homedir(), skipEnv, yes } = {}) {
  return !!stdinTTY && !!stdoutTTY && skipEnv !== '1' && !yes && !setupDone(home);
}

/**
 * Install the /collab plugin (the required core). Best-effort — a private repo or an
 * offline machine fails here, which is EXPECTED pre-launch, so the failure copy says so.
 * @returns {Promise<string>} one honest report line
 */
export async function installPlugin({ execFile = pexec } = {}) {
  try {
    await execFile('claude', ['plugin', 'marketplace', 'add', 'ir272/claudecollab'], { timeout: 30000 });
    await execFile('claude', ['plugin', 'install', 'collab@claudecollab'], { timeout: 30000 });
    return '✓ /collab is installed — type /collab in Claude Code when you want company';
  } catch {
    return "couldn't install the /collab plugin (offline or repo not public yet) — rerun anytime: collab setup";
  }
}

/**
 * Write the `claude` shim + rc edit. Best-effort — a read-only home fails here.
 * @returns {string} one honest report line
 */
export function installShimAction({ home = os.homedir(), rcFiles, installShimFn = installShim } = {}) {
  try {
    installShimFn({ home, rcFiles });
    return '✓ `claude` is now shareable (new terminals; or run: rehash)';
  } catch {
    return "couldn't shim the `claude` command — undo any partial changes with: collab setup --undo";
  }
}

/**
 * One honest instruction line per checked connector. No CLI add exists for the hosted
 * connectors (see the docs note at the top), so we point the user at claude.ai — never
 * a fabricated server URL.
 * @param {string[]} connectors  checked connector keys
 * @returns {string[]}
 */
export function connectorInstructions(connectors = []) {
  return connectors.map((key) => {
    const label = CONNECTOR_LABELS[key] ?? key;
    return `• ${label}: add it at claude.ai/customize/connectors — it then shows up in Claude Code automatically (check /mcp).`;
  });
}

/**
 * Run all first-run side effects and report each on its own line via `out`. Each is
 * best-effort and reports honestly; this never throws.
 */
export async function runActions({ connectors = [], home = os.homedir(), rcFiles, execFile, installShimFn, out = () => {} } = {}) {
  out('');
  out(await installPlugin({ execFile }));
  out(installShimAction({ home, rcFiles, installShimFn }));
  const connLines = connectorInstructions(connectors);
  if (connLines.length) {
    out('');
    out('link delivery — turn on the connectors you picked (they live in your claude.ai account):');
    for (const l of connLines) out(l);
  }
}

/**
 * The orchestrated first run: render the screen, run the actions, write the marker.
 * The marker is written AFTER the screen even if an action failed (failures print
 * their own retry line) so the screen never nags on every subsequent run.
 */
export async function runSetup({ input, output, home = os.homedir(), rcFiles, execFile, installShimFn, connectors } = {}) {
  const picked = await runFirstRun({ input, output, connectors });
  await runActions({
    connectors: picked.connectors,
    home,
    rcFiles,
    execFile,
    installShimFn,
    out: (s) => output.write(s + '\r\n'),
  });
  writeMarker(home);
  return picked;
}

/**
 * Reverse setup: remove the shim + rc edit, best-effort uninstall the plugin. The
 * marker is RETAINED — setup stays "done", so a later plain `collab` won't re-prompt.
 */
export async function undoSetup({ home = os.homedir(), rcFiles, execFile = pexec, removeShimFn = removeShim, out = () => {} } = {}) {
  removeShimFn({ home, rcFiles });
  out('✓ removed the `claude` shim (restart your terminal, or run: rehash)');
  try {
    await execFile('claude', ['plugin', 'uninstall', 'collab@claudecollab'], { timeout: 30000 });
    out('✓ uninstalled the /collab plugin');
  } catch {
    out("left the /collab plugin in place (couldn't uninstall it — remove it with /plugin inside Claude Code)");
  }
}

/**
 * The `collab setup [--undo]` bin entry point. Re-runs the screen + actions ignoring
 * the marker, or reverses everything with --undo. Owns its own exit.
 */
export async function setupMain(args = []) {
  if (args.includes('--undo')) {
    await undoSetup({ out: (s) => process.stdout.write(s + '\n') });
  } else {
    await runSetup({ input: process.stdin, output: process.stdout });
  }
  process.exit(0);
}
