#!/usr/bin/env node
// claude-share — wrap Claude Code in a PTY and share the session. Post-dogfood
// verdict (design v2): the host terminal is the ENGINE ROOM — plain, native Claude,
// exactly as solo. Host stdin passes straight through to Claude; the only overlay is
// ONE status line pinned to the bottom row (room · people · claude-state · room URL).
//
// The browser is the one multiplayer surface for everyone, host included. On room
// creation the CLI prints (and copies) the room URL with a host token; the host opens
// it in a browser tab and does ALL multiplayer there — admitting knocks, co-writing
// drafts, roles, /pause, /end. Web guests join by URL with the same knock/roles model;
// the ssh guest door remains functional but uninvested.
//
// The brain still lives here (single authority): RoomState tracks
// participants/roles/mode/size; the per-role gate routes every GUEST keystroke to the
// draft composer, to Claude, or to nothing; sent drafts land in the attributed queue
// and drain one-per-idle (fail closed); /role /kick /pause /resume /recap /end are
// wired; joiners get a context card before the mirror; the shared view is clamped to
// the smallest participant (floor 80×24). Browser tabs are views + labeled input
// sources — the host tab's {t:'ui'} admit/deny answers knocks.
//
// Solo mode (`--no-relay`): the host drives Claude directly, no relay, no room URL.

import process from 'node:process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';
import { startPty } from '../src/pty.js';
import { paint, ROLE_GLYPH } from '../src/renderer.js';
import { ScreenSnapshot } from '../src/screen-snapshot.js';
import { installHooks, listenHooks } from '../src/hooks.js';
import { connectRelay, parseRelayUrl, openingMove } from '../src/relay-client.js';
import { createPartitioner } from '../src/term-chatter.js';
import { RoomState, HOST_ID, atLeast } from '../src/brain/state.js';
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
    webPort: 8787, // the relay's browser-door port — the CLI prints it in the room URL
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
    else if (a === '--web-port') opts.webPort = Math.max(1, Number(argv[++i]) || opts.webPort);
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
  // The terminal band is permanently exactly ONE status line, pinned to the bottom
  // row. Claude gets every other row; the child PTY is resized to rows-1 each repaint.
  const BAND_ROWS = 1;
  const multiplayer = opts.relay; // the guest composer/gate + mirror are active only when sharing
  // The host's browser tab authenticates with this token: it knocks with fingerprint
  // `webhost:<token>`, and the brain auto-admits it as host (the one knock answered
  // with no host already present). The token also goes in the room URL we print/copy.
  const hostToken = randomBytes(16).toString('hex');
  // The current live Claude screen, cached so a joiner sees it instantly (finding 1).
  const snapshot = new ScreenSnapshot();

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
  const pointers = new Map(); // userId -> {x, y} normalized 0..1 (browser cursors)
  const claude = { state: 'idle' };
  let armed = false; // true only while a permission ask is pending (hook-armed)
  let pendingKnocks = []; // FIFO of guest {id,name,fp,seen} awaiting the host tab's admit
  let currentUrl = null; // the room URL (with host token) once a room is granted
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
    pty = await startPty({ cmd: opts.cmd, args: childArgs, bandRows: BAND_ROWS });
  } catch (err) {
    process.stderr.write(
      `claude-share: could not start "${opts.cmd}": ${err.message}\n` +
        'If this is a native-module error, run `npm install` in packages/cli (needs node-pty).\n',
    );
    process.exit(1);
  }

  const CLAUDE_STATUS = { busy: '✻ brewing…', idle: '● idle', ask: '⚠ permission ask pending' };

  // ── band rendering (one status line) ─────────────────────────────────────────
  // The engine-room band is a single line. Draft boxes, the queue, knock prompts —
  // all of that moved to the browser (state.knocks / state.drafts). Transient
  // messages fold into the claude-state slot; nothing ever grows past one row.
  const nameOf = (id) => state.nameOf(id) ?? knockInfo.get(id)?.name ?? id;

  // The middle slot of the status line: a live toast wins (folded in temporarily),
  // then pause, then Claude's hook-tracked state, then a plain live/connecting/solo.
  const stateSlot = () => {
    if (ui.toast) return ui.toast;
    if (state.paused) return '⏸ paused';
    if (hooks) return CLAUDE_STATUS[claude.state] ?? claude.state;
    if (state.room) return 'live';
    return relay ? 'connecting…' : 'solo';
  };

  const statusFields = () => ({
    room: state.room,
    people: state.list().length,
    claudeState: stateSlot(),
    url: currentUrl,
  });

  // The coordinate space the band paints into. In a shared session it is the CLAMPED
  // shared size (min of participants, floor 80×24), so every participant — the host
  // included — sees the SAME layout anchored at the same rows (finding 3), and the
  // one painted band can be written to the host and mirrored to guests unchanged.
  // Solo there is no shared view, so we use the host's own terminal.
  const viewSize = () => (multiplayer ? state.clamp() : { cols: stdout.columns || 80, rows: stdout.rows || 24 });

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

  // ── overlay state (the browser multiplayer surface) ──────────────────────────
  // The brain assembles a full snapshot the relay fans out to browser views: who's
  // here (with stable per-fingerprint colors), the shared drafts (cursors+authors),
  // the attributed queue, Claude's state, pause, live pointers, and the pending
  // knocks (the host admits from the browser). Everything is in userId-space —
  // `participants` is the id → {name, role, color} lookup the view joins against.
  const buildState = () => ({
    room: state.room,
    participants: state.list().map((p) => ({ id: p.id, name: p.name, role: p.role, color: p.color })),
    drafts: drafts.snapshot(),
    queue: queue.items.map((it, i) => ({ n: i + 1, author: it.author, text: it.text })),
    claudeState: claude.state,
    paused: state.paused,
    pointers: Object.fromEntries(
      [...pointers]
        .filter(([id]) => state.get(id)) // drop a pointer whose owner has left
        .map(([id, p]) => [id, { x: p.x, y: p.y, name: nameOf(id), color: state.colorOf(id) }]),
    ),
    knocks: pendingKnocks.map((k) => ({ id: k.id, name: k.name, fp: k.fp, seen: k.seen })),
  });

  // Emit at most one state frame per 50ms: fire immediately when outside the window,
  // otherwise coalesce a burst into a single trailing emit at the window's end.
  const STATE_THROTTLE_MS = 50;
  let stateTimer = null;
  let lastStateAt = 0;
  const emitState = () => {
    if (!relay || !multiplayer) return;
    lastStateAt = Date.now();
    relay.sendState(buildState());
  };
  const scheduleState = () => {
    if (!relay || !multiplayer || stateTimer) return;
    const wait = STATE_THROTTLE_MS - (Date.now() - lastStateAt);
    if (wait <= 0) return emitState();
    stateTimer = setTimeout(() => {
      stateTimer = null;
      emitState();
    }, wait);
    stateTimer.unref?.();
  };

  // The child PTY size we last applied. The band height is dynamic, so we resize
  // Claude's region whenever the band or the shared width changes (each resize costs
  // Claude a repaint, so only on an actual change).
  let appliedCols = null;
  let appliedChildRows = null;
  // Ghost-band cleanup state (see repaintBand): the shared rows we last painted at,
  // and whether a clamp shrink still needs its below-region erase delivered.
  let lastPaintRows = null;
  let pendingClearBelow = false;

  // The band is one status line, pinned to the bottom row of the (clamped) shared
  // view. The same painted line goes to the host's stdout and, mirrored, to every
  // eligible ssh guest; browser tabs render their own overlay from state instead.
  // Claude's region is resized to rows-1 so the line can never overlap its output.
  const repaintBand = () => {
    const { cols, rows } = viewSize();
    const band = BAND_ROWS;

    // Keep Claude's region to exactly the rows the band does not occupy, at the
    // shared width — resize the child only when that actually changes.
    const childRows = Math.max(1, rows - band);
    if (cols !== appliedCols || childRows !== appliedChildRows) {
      appliedCols = cols;
      appliedChildRows = childRows;
      try {
        pty.resizeChild(cols, childRows);
      } catch {}
    }

    let painted = paint({ cols, rows, bandRows: band, ...statusFields() });
    // Ghost-band cleanup: when the shared clamp SHRINKS, rows below the new region
    // keep stale band paint on any terminal taller than the new clamp. Erase below
    // the region BEFORE repainting (order matters: on a terminal exactly `rows`
    // tall the erase clips to the band's last row, and the repaint restores it).
    // The flag persists until a repaint actually reaches guests (pause suppresses
    // the mirror, and a ghost must not outlive the pause).
    if (lastPaintRows !== null && rows < lastPaintRows) pendingClearBelow = true;
    lastPaintRows = rows;
    if (pendingClearBelow) {
      painted = `\x1b7\x1b[${rows + 1};1H\x1b[0J\x1b8` + painted;
      if (!state.paused) pendingClearBelow = false;
    }
    if (stdout.isTTY) stdout.write(painted);
    mirror(painted); // mirror() owns the relay/multiplayer/paused checks
    scheduleState(); // repaintBand is the brain's "something changed" chokepoint
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
  // The shared size changed (a join/leave/kick/resize): repaint, which recomputes
  // the clamp, the band height, and Claude's region size in one place.
  const recomputeClamp = () => repaintBand();

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

  // ── roster mutations, targeted by participant id ──────────────────────────────
  // Both the host tab's roster buttons ({t:'ui'} role/kick, carrying the id) and the
  // /role /kick text commands (which resolve a @-mention to an id first) funnel here,
  // so the mutation is identical and never re-parses a claimed name (finding 4). Return
  // false on an unresolved/illegal target so the caller can word its own error.
  function applyRole(actorId, targetId, role) {
    if (!targetId || !state.setRole(targetId, role)) return false; // setRole refuses host/unknown
    const msg = `${nameOf(actorId)} set ${state.nameOf(targetId)} to ${role} ${ROLE_GLYPH[role] ?? ''}`;
    log.event(msg);
    showToast(msg);
    return true;
  }
  function applyKick(actorId, targetId) {
    if (!targetId || targetId === HOST_ID || !state.get(targetId)) return false;
    const name = state.nameOf(targetId);
    relay?.drop(targetId, true); // ban=true blocklists the fingerprint
    state.removeGuest(targetId);
    drafts.removeUser(targetId);
    queue.removeByAuthor(targetId);
    knockInfo.delete(targetId);
    pointers.delete(targetId);
    recomputeClamp();
    const msg = `${name} was kicked`;
    log.event(msg);
    showToast(msg);
    return true;
  }

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
        // Text-command path keeps @-mention resolution (and its name-specific error);
        // the mutation itself is the shared, id-based applyRole (finding 4).
        const targetId = resolveMention(state, parsed.mention);
        if (!applyRole(userId, targetId, parsed.role)) {
          notify(userId, `can't set @${parsed.mention} to ${parsed.role}`);
          return;
        }
        break;
      }
      case 'kick': {
        const targetId = resolveMention(state, parsed.mention);
        if (!applyKick(userId, targetId)) {
          notify(userId, `can't kick @${parsed.mention}`);
          return;
        }
        break;
      }
      case 'pause': {
        state.setPaused(true);
        // Route the hold card through mirrorTargets() like everything else, so a
        // below-floor spectator (already parked on the "make your terminal bigger"
        // hint) is not clobbered with it (finding 5).
        const hold = '\x1b[2J\x1b[H  ⏸ sharing paused — the host will resume shortly\r\n';
        for (const id of state.mirrorTargets()) relay?.sendTo(id, hold);
        log.event(`${by} paused sharing`);
        showToast('sharing paused — guests see a hold card');
        break;
      }
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
        endSession();
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

  // /end — end the room now. The two-step "end? / save?" confirmation is a browser-UI
  // concern (the host tab gates it and fires a single /end); the terminal has no y/n
  // path anymore. We write the attributed session.md then disconnect everyone —
  // defaulting to save preserves the record, since the browser doesn't yet signal a
  // no-save choice (spec §host controls: the log is kept in memory either way).
  function endSession() {
    try {
      log.write(path.join(process.cwd(), 'session.md'));
    } catch {}
    relay?.end();
    cleanup(0);
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
    pointers.delete(id);
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

  // ── relay client ─────────────────────────────────────────────────────────────
  // Resolve a specific pending knock by id. Answered ONLY from the host's browser tab
  // (a {t:'ui'} admit/deny button); state.knocks shows the host all pending knocks.
  // The terminal has no y/n knock path anymore (post-dogfood verdict).
  const answerKnockById = (knockId, admitYes) => {
    const idx = pendingKnocks.findIndex((k) => k.id === knockId);
    if (idx === -1 || !relay) return;
    const [knock] = pendingKnocks.splice(idx, 1);
    if (admitYes) relay.admit(knock.id);
    else {
      relay.deny(knock.id);
      showToast(`declined ${knock.name}`);
    }
    repaintBand();
  };

  // A browser button command from guest `id`, executed AS that sender so the role
  // gate still applies (verdict: browser tabs are labeled input sources; the brain
  // stays the single authority). Admit/deny is a host action; a command runs the
  // exact draft-send path (classify → gate → route).
  const handleUi = (id, action) => {
    if (!action || typeof action !== 'object') return;
    const role = state.roleOf(id) ?? 'viewer';
    if (action.kind === 'admit' || action.kind === 'deny') {
      if (!atLeast(role, 'host')) return notify(id, 'only the host can admit or deny knocks');
      answerKnockById(action.id, action.kind === 'admit');
      return;
    }
    // Roster buttons carry the target's participant id (not a name), so a duplicate or
    // space/unicode name can never mis-target a kick/role change (finding 4).
    if (action.kind === 'role') {
      if (!atLeast(role, 'host')) return notify(id, 'only the host can set roles');
      if (!applyRole(id, action.id, action.role)) notify(id, "can't set that role");
      repaintBand();
      return;
    }
    if (action.kind === 'kick') {
      if (!atLeast(role, 'host')) return notify(id, 'only the host can kick');
      if (!applyKick(id, action.id)) notify(id, "can't kick that participant");
      repaintBand();
      return;
    }
    if (action.kind === 'command') routeSend(id, { text: String(action.text) });
  };

  const { host: RELAY_HOST } = parseRelayUrl(opts.relayUrl);
  // The room URL the host opens in a browser tab (and shares with guests). The `host`
  // token turns this into the host tab; guests visit the same URL without it.
  const roomUrl = (code) => `http://${RELAY_HOST}:${opts.webPort}/${code}?host=${hostToken}`;
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
      currentUrl = roomUrl(code); // pin the URL into the status line
      if (reclaimed) showToast('reconnected — room reclaimed', 6000);
      else {
        // Best-effort clipboard copy (spec: the invite is on the clipboard before
        // Claude finishes booting) — now the room URL, not the ssh invite. macOS
        // only for now; guarded by CLAUDE_SHARE_NO_CLIPBOARD; silent on failure.
        if (process.platform === 'darwin' && !process.env.CLAUDE_SHARE_NO_CLIPBOARD) {
          try {
            const pb = execFile('pbcopy');
            pb.stdin.end(currentUrl);
          } catch {}
        }
        // The URL lives permanently in the status line's URL slot; the toast is just
        // the transient "copied" confirmation (folded into the same one line).
        showToast('room ready · link copied to clipboard', 15000);
      }
    });
    r.onGone(() => {
      // Reclaim refused: the 10-min TTL lapsed or the room truly ended. Nothing to
      // return to — drop the code so onClose won't keep retrying, and finish solo.
      state.setRoom(null);
      showToast('the room expired while disconnected — continuing solo', 8000);
    });
    r.onKnock((knock) => {
      // The host's own browser tab knocks with fp `webhost:<token>`. Auto-admit it as
      // host — it is the one knock answered with no host tab present yet, and it is
      // how the host gets in to answer everyone else's knocks. It never shows up as a
      // pending knock the host has to admit.
      if (knock.fp === `webhost:${hostToken}`) {
        knockInfo.set(knock.id, { name: knock.name, fp: knock.fp, role: 'host' });
        r.admit(knock.id);
        return;
      }
      knockInfo.set(knock.id, { name: knock.name, fp: knock.fp });
      pendingKnocks.push(knock);
      repaintBand();
    });
    r.onJoin((id) => {
      const info = knockInfo.get(id) ?? { name: 'guest', fp: null };
      // addGuest restores the role a returning fingerprint last held this session
      // (spec §identity). The host's browser tab carries role 'host' (set at knock
      // time); a new/keyless guest takes the room default (opts.guests).
      const g = state.addGuest(id, { name: info.name, fp: info.fp, role: info.role ?? opts.guests });
      log.event(`${g.name} joined as ${g.role}`);
      // The join context card lands in the guest's own scrollback before the
      // live mirror attaches (spec §join context card).
      try {
        const card = buildCard(state, log, { joinerId: id, claudeState: claude.state });
        r.sendTo(id, card.replace(/\n/g, '\r\n') + '\r\n');
      } catch {}
      // Right after the card, replay the CURRENT Claude screen so the joiner sees
      // the live screen immediately — not blank space until the next frame. The
      // mirror only forwards frames produced after this join, so without the
      // snapshot a guest admitted while Claude is idle would see nothing (finding 1).
      try {
        if (state.paused) {
          // The snapshot is exactly what /pause promises to hide — a joiner during
          // a pause gets the hold card, and the live screen on /resume.
          r.sendTo(id, '\r\n⏸ sharing is paused — the live screen will appear when the host resumes\r\n');
        } else {
          const snap = snapshot.get();
          if (snap) r.sendTo(id, snap);
        }
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
    r.onPointer(({ id, x, y }) => {
      if (!id || !state.get(id)) return; // only a known participant's cursor
      pointers.set(id, { x, y });
      scheduleState(); // rebroadcast via state.pointers (spec); no band repaint needed
    });
    r.onUi(({ id, action }) => handleUi(id, action));
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
    stdout.write(TERM_RESTORE + '\r\n[claude-share exited]\r\n');
    process.exit(code ?? 0);
  };

  // Undo every terminal mode the child may have enabled on the REAL terminal via
  // passthrough — kitty keyboard, mouse tracking (the "35;138;1M" spam if left on),
  // focus events, bracketed paste — then show the cursor and leave the alt screen.
  // Dying without this leaves the user's shell receiving mouse coordinates.
  const TERM_RESTORE =
    '\x1b[<u' + // pop kitty keyboard flags
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse tracking off
    '\x1b[?1004l' + // focus reporting off
    '\x1b[?2004l' + // bracketed paste off
    '\x1b[?25h' + // cursor visible
    '\x1b[?1049l'; // leave the alternate screen

  // pkill/kill and a closing terminal tab must restore the terminal too — without
  // these handlers, SIGTERM/SIGHUP skip cleanup entirely (dogfood finding).
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => cleanup(0));
  }

  // ── passthrough + broadcast ────────────────────────────────────────────────────
  // Write every Claude frame locally; mirror it to guests unless paused. The band
  // redraws on the frame boundary so it never smears mid-repaint.
  pty.onFrame((chunk) => {
    snapshot.push(chunk); // retain the current screen so a joiner sees it live (finding 1)
    stdout.write(chunk);
    mirror(chunk);
    repaintBand();
  });
  pty.onExit(({ exitCode }) => cleanup(exitCode ?? 0));

  // ── host stdin — STRAIGHT THROUGH to Claude ──────────────────────────────────
  // The terminal is the engine room: the host drives Claude exactly as solo. There
  // is no composer, no gate, and no knock/end y/n on host input anymore — all
  // multiplayer moves happen in the host's browser tab. We still run the chatter
  // partitioner (terminal DA/version replies + mouse reports are the terminal
  // answering Claude); both halves flow to the PTY, so Claude sees every byte.
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const partitionHostInput = createPartitioner();
  stdin.on('data', (d) => {
    const { chatter, human } = partitionHostInput(d);
    if (chatter) pty.write(Buffer.from(chatter, 'binary'));
    if (human) pty.write(Buffer.from(human, 'binary'));
  });

  process.on('SIGWINCH', () => {
    state.setSize(HOST_ID, stdout.columns || 80, stdout.rows || 24);
    recomputeClamp();
    repaintBand();
  });
  process.on('exit', () => {
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
      if (stdout.isTTY) stdout.write(TERM_RESTORE);
    } catch {}
  });

  repaintBand(); // draw the band immediately, before the first frame
}

main().catch((err) => {
  process.stderr.write(`claude-share: ${err?.stack || err}\n`);
  process.exit(1);
});
