#!/usr/bin/env node
// claude-share — wrap Claude Code in a PTY and paint a live multiplayer band
// under its full-screen TUI. Runs Claude locally (frame-synced band redraws, full
// I/O passthrough) and, unless `--no-relay`, connects to a relay so real ssh
// guests can join and co-drive.
//
// Task 7 makes the room real: RoomState tracks participants/roles/mode/size; the
// per-role gate routes every keystroke (host and guests alike) to the draft
// composer, to Claude, or to nothing; sent drafts land in the attributed queue and
// drain one-per-idle (fail closed); /role /kick /pause /resume /recap /end are
// wired; joiners get a context card before the mirror; a mode flip with guests
// present raises a warning banner; the shared view is clamped to the smallest
// participant (floor 80×24).
//
// Solo mode (`--no-relay`) keeps the Task 3/5 behavior: the host drives Claude
// directly and the band is a status placeholder — the composer is a sharing tool.

import process from 'node:process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import ssh2 from 'ssh2';
import { startPty } from '../src/pty.js';
import { paint, ROLE_GLYPH, draftBox, queueBlock, knockLine } from '../src/renderer.js';
import { installHooks, listenHooks } from '../src/hooks.js';
import { connectRelay, parseRelayUrl, openingMove } from '../src/relay-client.js';
import { createPartitioner } from '../src/term-chatter.js';
import { RoomState, HOST_ID } from '../src/brain/state.js';
import { Queue } from '../src/brain/queue.js';
import { Log } from '../src/brain/log.js';
import { Drafts } from '../src/brain/drafts.js';
import { dispatch, classifySend, sendAllowed } from '../src/brain/gate.js';
import { parse as parseCommand, permitted as commandPermitted, resolveMention } from '../src/brain/commands.js';
import { build as buildCard, recapCard } from '../src/brain/card.js';

function parseArgs(argv) {
  const opts = {
    relay: true,
    relayUrl: 'ssh://127.0.0.1:2222', // dev default; override with --relay <url>
    bandRows: 6, // status + room for a focused draft box (3) + a couple queue rows
    cmd: 'claude',
    hooks: true,
    guests: 'prompter', // default role for a newly admitted guest (spec default)
    childArgs: [],
  };
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-relay') opts.relay = false;
    else if (a === '--relay') opts.relayUrl = argv[++i] ?? opts.relayUrl;
    else if (a === '--no-hooks') opts.hooks = false;
    else if (a === '--band-rows') opts.bandRows = Math.max(2, Number(argv[++i]) || opts.bandRows);
    else if (a === '--cmd') opts.cmd = argv[++i];
    else if (a === '--guests') opts.guests = argv[++i] ?? opts.guests;
    else if (a === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else passthrough.push(a); // unknown flags pass through to the child
  }
  opts.childArgs = passthrough;
  return opts;
}

function hostName() {
  try {
    return os.userInfo().username || process.env.USER || 'host';
  } catch {
    return process.env.USER || 'host';
  }
}

// The host's stable ssh identity — its fingerprint gates room reclaim on the relay
// (spec §failure-behavior), so it must survive restarts. Persisted under
// ~/.claude-share, generated on first run, readable only by the user.
function loadHostKey() {
  const dir = path.join(os.homedir(), '.claude-share');
  const keyPath = path.join(dir, 'host_key');
  try {
    return fs.readFileSync(keyPath);
  } catch {
    /* not created yet */
  }
  const priv = ssh2.utils.generateKeyPairSync('ed25519').private;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, priv, { mode: 0o600 });
  } catch {
    /* home not writable — fall back to an in-memory key for this run */
  }
  return priv;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { stdin, stdout } = process;
  const bandRows = opts.bandRows;
  const multiplayer = opts.relay; // the composer/gate is active only when sharing

  // ── the brain ─────────────────────────────────────────────────────────────
  const state = new RoomState({
    hostName: hostName(),
    defaultRole: opts.guests,
    hostSize: { cols: stdout.columns || 80, rows: stdout.rows || 24 },
  });
  const queue = new Queue();
  const log = new Log();
  const drafts = new Drafts();
  const toasted = new Set(); // userIds already shown the viewer toast
  const knockInfo = new Map(); // id -> {name, fp} captured at knock time
  const claude = { state: 'idle' };
  let armed = false; // true only while a permission ask is pending (hook-armed)
  let pendingKnocks = []; // FIFO of {id,name,fp,seen} awaiting the host's y/n
  let endConfirm = 0; // /end confirmation stage: 0 none · 1 "end?" · 2 "save?"
  const ui = { toast: null, toastTimer: null };
  let relay = null;
  let exited = false;
  // Reconnect-with-reclaim state (spec §failure-behavior: the relay holds the code
  // 10 min after a host drop). On a lost connection we reconnect and RECLAIM the
  // room we still hold, rather than abandoning it.
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 8;

  // ── hook-based state detection (Task 4) ─────────────────────────────────────
  const childArgs = [...opts.childArgs];
  let hooks = null;
  let settingsFile = null;
  let socketPath = null;
  if (opts.hooks && opts.cmd === 'claude') {
    try {
      socketPath = path.join(os.tmpdir(), `claude-share-${process.pid}.sock`);
      settingsFile = installHooks(socketPath);
      hooks = listenHooks(socketPath);
      await hooks.ready;
      childArgs.unshift('--settings', settingsFile);
    } catch (err) {
      process.stderr.write(`claude-share: hook setup failed (${err.message}); state detection off\n`);
      hooks = null;
    }
  }

  let pty;
  try {
    pty = await startPty({ cmd: opts.cmd, args: childArgs, bandRows });
  } catch (err) {
    process.stderr.write(
      `claude-share: could not start "${opts.cmd}": ${err.message}\n` +
        'If this is a native-module error, run `npm install` in packages/cli (needs node-pty).\n',
    );
    process.exit(1);
  }

  const CLAUDE_STATUS = { busy: '✻ brewing…', idle: '● idle', ask: '⚠ permission ask pending' };

  // ── band rendering ───────────────────────────────────────────────────────────
  // The dynamic region: a pending knock wins (spec: knocks render in the band,
  // never over Claude's output), otherwise a status/toast line then the draft
  // boxes and the attributed queue. paint() clips to the reserved rows.
  const nameOf = (id) => state.nameOf(id) ?? knockInfo.get(id)?.name ?? id;

  function bandDynamicLines(cols) {
    const k = pendingKnocks[0];
    if (k) return [knockLine(k, { cols })];

    const lines = [];
    if (state.paused) lines.push('⏸ sharing paused — /resume to continue');
    else if (ui.toast) lines.push(ui.toast);
    else if (hooks) lines.push(CLAUDE_STATUS[claude.state] ?? claude.state);
    else if (state.room) lines.push(`room live · ${state.guests().length} watching`);
    else lines.push(relay ? 'connecting to relay…' : 'solo session · band is a placeholder');

    if (multiplayer) {
      const hostBoxId = drafts.activeBox(HOST_ID)?.id;
      for (const b of drafts.snapshot().boxes) {
        const authors = b.authors.map(nameOf);
        // Each participant's live cursor, tagged by display name — the wow beat.
        const cursors = Object.entries(b.caretOffsets).map(([uid, offset]) => ({ name: nameOf(uid), offset }));
        lines.push(...draftBox({ text: b.text, authors, cursors }, { cols, focused: b.id === hostBoxId }));
      }
      const qitems = queue.items.map((it) => ({ author: nameOf(it.author), text: it.text }));
      lines.push(...queueBlock(qitems, { cols }));
    }
    return lines;
  }

  const bandState = (cols, rows) => ({
    cols,
    rows,
    bandRows,
    room: state.room,
    participants: state.list().map((p) => ({ name: p.name, role: p.role })),
    mode: state.mode,
    lines: bandDynamicLines(cols),
  });
  // The band is part of the ONE live screen (spec §how-a-session-works). Paint it
  // for the host at its own terminal size, and mirror the same band to guests
  // sized to the clamped shared view — so everyone, not just the host, sees the
  // draft boxes/cursors, the attributed queue, the status line, knocks, and every
  // event toast (joins/leaves/kicks/role changes, the mode-change warning banner,
  // recap notices). Suppressed while paused: guests hold on the pause card.
  // Send a shared-view frame to the guests who should see it. When everyone is at or
  // above the 80×24 floor this is a single broadcast; when at least one guest is below
  // the floor we deliver per-guest to the eligible ones only, so a below-floor guest
  // stays parked on the spectate hint instead of receiving a mirror sized for bigger
  // terminals (spec §renderer clamp). Suppressed while paused.
  const mirror = (data) => {
    if (!relay || !multiplayer || state.paused) return;
    if (state.spectators().length === 0) relay.sendScreen(data);
    else for (const id of state.mirrorTargets()) relay.sendTo(id, data);
  };

  const repaintBand = () => {
    if (stdout.isTTY) stdout.write(paint(bandState(stdout.columns || 80, stdout.rows || 24)));
    if (relay && multiplayer && !state.paused) {
      const { cols, rows } = state.clamp();
      mirror(paint(bandState(cols, rows)));
    }
  };

  const showToast = (msg, ms = 4000) => {
    ui.toast = msg;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      ui.toast = null;
      repaintBand();
    }, ms);
    ui.toastTimer.unref?.();
    repaintBand();
  };

  // A message meant for one participant: mail it to a guest, and surface it in the
  // host's band too so moderation stays visible.
  const notify = (userId, msg) => {
    if (userId && userId !== HOST_ID) relay?.sendTo(userId, `\r\n${msg}\r\n`);
    showToast(msg);
  };

  // Post prose to the SHARED screen — the host's stdout and every live guest's
  // terminal (spec: /recap posts its summary to the shared screen, for all to read,
  // not a host-only toast). Claude repaints its region on the next frame; the band
  // repaints after. Not while paused.
  const broadcast = (text) => {
    const framed = '\r\n' + String(text).replace(/\r?\n/g, '\r\n') + '\r\n';
    if (stdout.isTTY) stdout.write(framed);
    mirror(framed);
    repaintBand();
  };

  // ── size clamp (spec §renderer) ────────────────────────────────────────────
  const recomputeClamp = () => {
    const { cols, rows } = state.clamp();
    try {
      pty.resize(cols, rows); // pty.resize subtracts bandRows for the child
    } catch {}
  };

  // ── queue drain (fail closed, one per idle) ─────────────────────────────────
  const pump = () => {
    if (!hooks || claude.state !== 'idle') return; // no drain unless known-idle
    const item = queue.drain('idle');
    if (!item) return;
    pty.write(item.text + '\r');
    claude.state = 'busy'; // optimistic; the UserPromptSubmit hook confirms
    repaintBand();
  };

  // ── routing a sent draft ─────────────────────────────────────────────────────
  const routeSend = (userId, send) => {
    const role = state.roleOf(userId) ?? 'viewer';
    const text = send.text;
    const cls = classifySend(text);

    if (cls.kind === 'command') return handleCommand(userId, text);

    if (!sendAllowed(cls.kind, role)) {
      const what = cls.kind === 'bash' ? 'run bash' : cls.kind === 'claude-slash' ? 'use slash commands' : 'send that';
      notify(userId, `you can't ${what} — ask the host for a driver role`);
      return;
    }
    // Bound for Claude. Log by display name (card is display-only); attribute the
    // queue by userId (permission + purge on leave).
    log.prompt(nameOf(userId), text);
    if (!hooks) {
      pty.write(text + '\r'); // no state tracking → send immediately
      return;
    }
    queue.enqueue(text, userId);
    pump();
    repaintBand();
  };

  // ── claude-share commands ─────────────────────────────────────────────────────
  function handleCommand(userId, text) {
    const role = state.roleOf(userId) ?? 'viewer';
    const parsed = parseCommand(text);
    if (!parsed) return;
    if (!commandPermitted(parsed.name, role)) {
      notify(userId, `you can't run /${parsed.name}`);
      return;
    }
    if (parsed.error) {
      notify(userId, parsed.error);
      return;
    }
    const by = nameOf(userId);
    switch (parsed.name) {
      case 'role': {
        const targetId = resolveMention(state, parsed.mention);
        if (!targetId || !state.setRole(targetId, parsed.role)) {
          notify(userId, `can't set @${parsed.mention} to ${parsed.role}`);
          return;
        }
        const msg = `${by} set ${state.nameOf(targetId)} to ${parsed.role} ${ROLE_GLYPH[parsed.role] ?? ''}`;
        log.event(msg);
        showToast(msg);
        break;
      }
      case 'kick': {
        const targetId = resolveMention(state, parsed.mention);
        if (!targetId || targetId === HOST_ID) {
          notify(userId, `can't kick @${parsed.mention}`);
          return;
        }
        const name = state.nameOf(targetId);
        relay?.drop(targetId, true); // ban=true blocklists the fingerprint
        state.removeGuest(targetId);
        drafts.removeUser(targetId);
        queue.removeByAuthor(targetId);
        knockInfo.delete(targetId);
        recomputeClamp();
        const msg = `${name} was kicked`;
        log.event(msg);
        showToast(msg);
        break;
      }
      case 'pause':
        state.setPaused(true);
        relay?.sendScreen('\x1b[2J\x1b[H  ⏸ sharing paused — the host will resume shortly\r\n');
        log.event(`${by} paused sharing`);
        showToast('sharing paused — guests see a hold card');
        break;
      case 'resume':
        state.setPaused(false);
        log.event(`${by} resumed sharing`);
        showToast('sharing resumed');
        break;
      case 'queue': {
        // Reachable path for Queue.edit()/remove() (spec §queue): an author edits or
        // deletes their own queued item; a driver/host deletes any. Per-item rights
        // are enforced by the Queue methods; the index is 1-based (the renderer's
        // numbering). handleCommand only runs for prompter+, so viewers never arrive.
        const item = queue.items[parsed.index - 1];
        if (!item) {
          notify(userId, `no queued item #${parsed.index}`);
          return;
        }
        if (parsed.sub === 'del') {
          if (!queue.remove(item.id, userId, role)) {
            notify(userId, `you can't delete queued item #${parsed.index} — it isn't yours`);
            return;
          }
          const msg = `${by} removed queued item #${parsed.index}`;
          log.event(msg);
          showToast(msg);
        } else {
          if (!queue.edit(item.id, parsed.text, userId, role)) {
            notify(userId, 'you can only edit your own queued item');
            return;
          }
          const msg = `${by} edited queued item #${parsed.index}`;
          log.event(msg);
          showToast(msg);
        }
        break;
      }
      case 'recap':
        runRecap(by);
        break;
      case 'end':
        beginEnd();
        break;
    }
    repaintBand();
  }

  // /recap — one-shot headless Claude over the attributed log, posted to the room.
  // Best-effort: uses the host's existing auth; failures are surfaced, never fatal.
  function runRecap(by) {
    showToast('recap: asking Claude…', 8000);
    const prompt = `Summarize this collaborative coding session transcript in 3-4 plain sentences:\n\n${log.toText()}`;
    execFile('claude', ['-p', prompt], { timeout: 30000, maxBuffer: 1 << 20 }, (err, out) => {
      const summary = err ? 'recap unavailable (claude -p failed)' : String(out).trim();
      log.event(`recap by ${by}: ${summary}`);
      // Post the FULL prose to the shared screen so everyone — guests included, and
      // the prompter who ran it — reads the whole recap, not a 60-char host toast.
      broadcast(recapCard(by, summary, { cols: state.clamp().cols }));
      showToast('recap posted to the room', 6000);
    });
  }

  // /end — two confirmations, answered by the host's y/n (see the stdin handler).
  function beginEnd() {
    endConfirm = 1;
    showToast('end session? everyone will be disconnected (y/n)', 30000);
  }
  function handleEndConfirm(d) {
    const s = d.toString('utf8');
    const yes = s === 'y' || s === 'Y';
    const no = s === 'n' || s === 'N';
    if (endConfirm === 1) {
      if (yes) {
        endConfirm = 2;
        showToast('save a session summary to session.md? (y/n)', 30000);
      } else if (no) {
        endConfirm = 0;
        showToast('end cancelled');
      }
      return;
    }
    if (endConfirm === 2) {
      if (yes) {
        try {
          log.write(path.join(process.cwd(), 'session.md'));
        } catch {}
      }
      if (yes || no) {
        endConfirm = 0;
        relay?.end();
        cleanup(0);
      }
    }
  }

  // Free a guest's seat and purge their footprint — draft boxes, queued items, any
  // stale knock — then re-clamp the shared view and announce the departure. Shared
  // by a relay-signaled LEFT (wifi drop / natural disconnect) and a self-detach.
  const forgetGuest = (id) => {
    const name = nameOf(id);
    state.removeGuest(id);
    drafts.removeUser(id);
    queue.removeByAuthor(id);
    pendingKnocks = pendingKnocks.filter((k) => k.id !== id);
    knockInfo.delete(id);
    recomputeClamp();
    log.event(`${name} left`);
    showToast(`${name} left`);
  };

  // ── input effect application (host + guests, one table via the gate) ─────────
  const applyInput = (userId, eff) => {
    switch (eff.kind) {
      case 'pty':
        pty.write(eff.data);
        break;
      case 'draft': {
        const r = drafts.keystroke(userId, eff.bytes);
        if (r.send) routeSend(userId, r.send);
        repaintBand();
        break;
      }
      case 'detach':
        // Ctrl+C: the guest leaves on their own. The relay drops the connection
        // WITHOUT echoing a LEFT back (it assumes host-initiated drops mean the host
        // already knows) — so onLeave never fires and we must free the seat here, or
        // the guest lingers as a ghost in the status line, queue, and size clamp.
        if (userId !== HOST_ID) {
          relay?.drop(userId, false); // close the connection, no ban
          forgetGuest(userId);
        }
        break;
      case 'toast':
        notify(eff.target, eff.message);
        break;
      case 'drop':
      default:
        break;
    }
  };

  // ── relay client (Task 5 transport, Task 7 brain) ────────────────────────────
  const answerKnock = (admitYes) => {
    const knock = pendingKnocks.shift();
    if (!knock || !relay) return;
    if (admitYes) relay.admit(knock.id);
    else {
      relay.deny(knock.id);
      showToast(`declined ${knock.name}`);
    }
    repaintBand();
  };

  const { host: RELAY_HOST, port: RELAY_PORT } = parseRelayUrl(opts.relayUrl);
  const inviteFor = (code) =>
    RELAY_PORT === 22 ? `ssh ${code}@${RELAY_HOST}` : `ssh -p ${RELAY_PORT} ${code}@${RELAY_HOST}`;
  // One stateful chatter partitioner per guest (split sequences carry per stream).
  const guestPartitioners = new Map();
  const guestPartitioner = (id) => {
    if (!guestPartitioners.has(id)) guestPartitioners.set(id, createPartitioner());
    return guestPartitioners.get(id);
  };

  // Attach every relay→brain handler to one relay instance. Reused verbatim for the
  // initial connection and each reconnect, so a reattached connection behaves
  // identically. Handlers use their own instance `r` for replies, so a stale
  // instance can never write to (or resurrect) a superseded connection.
  function wireRelay(r) {
    r.onRoom((code) => {
      reconnectAttempts = 0;
      const reclaimed = state.room === code; // we already held this exact code → reclaim
      state.setRoom(code);
      if (reclaimed) showToast('reconnected — room reclaimed', 6000);
      else {
        const invite = inviteFor(code);
        // Best-effort clipboard copy (spec: invite on the clipboard before
        // Claude finishes booting). macOS only for now; silent on failure.
        if (process.platform === 'darwin' && !process.env.CLAUDE_SHARE_NO_CLIPBOARD) {
          try {
            const pb = execFile('pbcopy');
            pb.stdin.end(invite);
          } catch {}
        }
        showToast(`room ready · invite copied: ${invite}`, 15000);
      }
    });
    r.onGone(() => {
      // Reclaim refused: the 10-min TTL lapsed or the room truly ended. Nothing to
      // return to — drop the code so onClose won't keep retrying, and finish solo.
      state.setRoom(null);
      showToast('the room expired while disconnected — continuing solo', 8000);
    });
    r.onKnock((knock) => {
      knockInfo.set(knock.id, { name: knock.name, fp: knock.fp });
      pendingKnocks.push(knock);
      repaintBand();
    });
    r.onJoin((id) => {
      const info = knockInfo.get(id) ?? { name: 'guest', fp: null };
      // addGuest restores the role a returning fingerprint last held this session
      // (spec §identity); a new/keyless guest takes the room default (opts.guests).
      const g = state.addGuest(id, { name: info.name, fp: info.fp, role: opts.guests });
      log.event(`${g.name} joined as ${g.role}`);
      // The join context card lands in the guest's own scrollback before the
      // live mirror attaches (spec §join context card).
      try {
        const card = buildCard(state, log, { joinerId: id, claudeState: claude.state });
        r.sendTo(id, card.replace(/\n/g, '\r\n') + '\r\n');
      } catch {}
      showToast(`${g.name} joined as ${g.role} ${ROLE_GLYPH[g.role] ?? ''}`);
      recomputeClamp();
    });
    r.onLeave((id) => {
      guestPartitioners.delete(id);
      forgetGuest(id);
    });
    r.onKey(({ id, data }) => {
      // Guests' terminals also answer mirrored queries and emit mouse reports.
      // Claude already gets the HOST terminal's answers; guest chatter is
      // dropped (v1: guest mouse doesn't drive the shared session).
      const { human } = guestPartitioner(id)(data);
      if (!human) return;
      const role = state.roleOf(id) ?? 'viewer';
      applyInput(id, dispatch(id, role, Buffer.from(human, 'binary'), { armed, toasted }));
    });
    r.onResize(({ id, cols, rows }) => {
      state.setSize(id, cols, rows);
      if (state.belowFloor(id)) {
        r.sendTo(id, '\x1b[2J\x1b[H  your terminal is below 80×24 — make it bigger to join the shared view\r\n');
      }
      recomputeClamp();
      repaintBand();
    });
    r.onClose(() => {
      if (exited || r !== relay) return; // a superseded instance's close is not ours
      relay = null;
      scheduleReconnect();
    });
    r.onError(() => {}); // transport errors surface via onClose; never crash
  }

  // Open (or reopen) the relay connection. On ready, hello for a fresh room or
  // RECLAIM the one we still hold (spec §failure-behavior) — this is the reclaim the
  // CLI was missing. Failures on a held room retry within the TTL; an initial
  // failure just runs solo.
  function openRelay() {
    if (exited) return;
    let r;
    try {
      r = connectRelay({ url: opts.relayUrl, privateKey: loadHostKey() });
    } catch (err) {
      if (state.room) return scheduleReconnect();
      process.stderr.write(`claude-share: relay setup failed (${err.message}); running solo\n`);
      return;
    }
    relay = r;
    wireRelay(r);
    r.ready
      .then(() => {
        const move = openingMove(state.room);
        if (move.t === 'reclaim') r.reclaim(move.code);
        else r.hello();
      })
      .catch((err) => {
        if (r === relay) relay = null;
        if (state.room) scheduleReconnect(); // lost a held room — keep trying within TTL
        else process.stderr.write(`claude-share: relay unavailable (${err.message}); running solo\n`);
      });
  }

  // A dropped connection: if we still hold a room, back off and reconnect to reclaim
  // it; otherwise there is nothing to return to, so go solo.
  function scheduleReconnect() {
    if (exited) return;
    if (!state.room) return showToast('relay disconnected — running solo', 8000);
    if (reconnectAttempts >= MAX_RECONNECT) {
      return showToast('could not reconnect to the relay — continuing solo', 8000);
    }
    reconnectAttempts++;
    showToast(`relay disconnected — reconnecting to reclaim the room (${reconnectAttempts}/${MAX_RECONNECT})…`, 8000);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(openRelay, reconnectAttempts === 1 ? 300 : 1500);
    reconnectTimer.unref?.();
  }

  if (opts.relay) openRelay();

  // ── hook events → brain ───────────────────────────────────────────────────────
  if (hooks) {
    hooks.on('busy', () => {
      claude.state = 'busy';
      armed = false;
      repaintBand();
    });
    hooks.on('idle', () => {
      claude.state = 'idle';
      armed = false;
      pump();
      repaintBand();
    });
    hooks.on('ask', () => {
      claude.state = 'ask';
      armed = true; // the ONLY thing that arms driver+ y/n → Claude (spec: gate on events)
      repaintBand();
    });
    hooks.on('tool', (p) => {
      const name = p?.tool_name ?? 'tool';
      const files = [];
      const inp = p?.tool_input ?? {};
      for (const key of ['file_path', 'path', 'notebook_path']) {
        if (typeof inp[key] === 'string') files.push(inp[key]);
      }
      log.tool(name, files);
      repaintBand();
    });
    hooks.on('mode', (m) => {
      const changed = state.setMode(m);
      // Any mode change with guests present raises a prominent warning banner into
      // the shared transcript (spec §roles).
      if (changed && state.guests().length) {
        const warn =
          m === 'bypassPermissions'
            ? '⚠ bypass mode: everyone in this room can now drive real commands with no asks'
            : `⚠ mode changed to ${m} — visible to the whole room`;
        log.event(warn);
        showToast(warn, 8000);
      }
      repaintBand();
    });
  }

  // ── teardown ──────────────────────────────────────────────────────────────────
  const cleanup = (code) => {
    if (exited) return;
    exited = true;
    clearTimeout(reconnectTimer); // stop any pending reclaim attempt
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {}
    stdin.pause();
    try {
      relay?.end();
      relay?.close();
    } catch {}
    try {
      hooks?.close();
    } catch {}
    for (const f of [settingsFile, socketPath]) {
      if (f) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
    }
    stdout.write('\x1b[?1049l\r\n[claude-share exited]\r\n');
    process.exit(code ?? 0);
  };

  // ── passthrough + broadcast ────────────────────────────────────────────────────
  // Write every Claude frame locally; mirror it to guests unless paused. The band
  // redraws on the frame boundary so it never smears mid-repaint.
  pty.onFrame((chunk) => {
    stdout.write(chunk);
    mirror(chunk);
    repaintBand();
  });
  pty.onExit(({ exitCode }) => cleanup(exitCode ?? 0));

  // ── host stdin ──────────────────────────────────────────────────────────────
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const partitionHostInput = createPartitioner();
  stdin.on('data', (d) => {
    // Terminal chatter first: DA/version replies and mouse reports are the
    // terminal answering Claude, not the human typing — they belong to the PTY,
    // never to the composer (they render as "[<35;34;4M" garbage in drafts).
    const { chatter, human } = partitionHostInput(d);
    if (chatter) pty.write(Buffer.from(chatter, 'binary'));
    if (!human) return;
    const d2 = Buffer.from(human, 'binary');
    // Modal host interactions intercept a lone y/n first: an /end confirmation,
    // then a knocking guest. Neither is forwarded to Claude.
    if (endConfirm) return handleEndConfirm(d2);
    if (relay && pendingKnocks.length) {
      const s = d2.toString('utf8');
      if (s === 'y' || s === 'Y') return answerKnock(true);
      if (s === 'n' || s === 'N') return answerKnock(false);
    }
    // Sharing: the host composes through the same gate as everyone. Solo: the host
    // drives Claude directly (the composer is a sharing tool).
    if (multiplayer) applyInput(HOST_ID, dispatch(HOST_ID, 'host', d2, { armed, toasted }));
    else pty.write(d2);
  });

  process.on('SIGWINCH', () => {
    state.setSize(HOST_ID, stdout.columns || 80, stdout.rows || 24);
    recomputeClamp();
    repaintBand();
  });
  process.on('exit', () => {
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {}
  });

  repaintBand(); // draw the band immediately, before the first frame
}

main().catch((err) => {
  process.stderr.write(`claude-share: ${err?.stack || err}\n`);
  process.exit(1);
});
