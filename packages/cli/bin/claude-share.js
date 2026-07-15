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
import { stripShimDir } from '../src/shim.js';
import { shouldRunSetup, runSetup, setupMain } from '../src/setup-actions.js';
import { startCtl } from '../src/ctl.js';
import { ctlMain } from '../src/ctl-client.js';
import { writeRoomFile, clearRoomFile } from '../src/room-file.js';
import { paint, ROLE_GLYPH } from '../src/renderer.js';
import { ScreenSnapshot } from '../src/screen-snapshot.js';
import { installHooks, listenHooks } from '../src/hooks.js';
import { connectRelay, parseRelayUrl, openingMove } from '../src/relay-client.js';
import { createPinCheck } from '../src/known-relays.js';
import { hostUrl, inviteUrl, readyToast } from '../src/invite.js';
import { createPartitioner } from '../src/term-chatter.js';
import { RoomState, HOST_ID, atLeast, FLOOR_COLS, FLOOR_ROWS } from '../src/brain/state.js';
import { Queue } from '../src/brain/queue.js';
import { Log } from '../src/brain/log.js';
import { Drafts } from '../src/brain/drafts.js';
import { History } from '../src/brain/history.js';
import { extractLatestResponse } from '../src/brain/transcript.js';
import { dispatch, classifySend, sendAllowed } from '../src/brain/gate.js';
import { parse as parseCommand, permitted as commandPermitted, resolveMention } from '../src/brain/commands.js';
import { build as buildCard, recapCard } from '../src/brain/card.js';
import { foldKnock } from '../src/brain/knocks.js';

function parseArgs(argv) {
  const opts = {
    relay: true,
    // Lazy by default (spec phase 5a): a fresh `collab` starts pixel-identical to
    // plain claude and does NOT dial the relay until go-live (`collab go`). --live
    // restores the old behavior — dial at startup — for rigs, tests, and anyone who
    // wants a room immediately. --no-relay still means never share.
    live: false,
    // Default to the community relay so a fresh `collab` needs zero setup; dev
    // rigs and tests always pass --relay explicitly (ssh://127.0.0.1:2222).
    relayUrl: 'ssh://claudecollab.org:2222',
    webPort: 8787, // the relay's browser-door port — the CLI prints it in the room URL
    cmd: 'claude',
    hooks: true,
    guests: 'prompter', // default role for a newly admitted guest (spec default)
    // Room-creation credential — required by a relay running with ROOM_SECRET.
    // Env beats a flag for real use (a flag shows in `ps`); the flag wins if both.
    secret: process.env.CLAUDE_SHARE_SECRET || undefined,
    fingerprint: undefined, // explicit relay key pin (SHA256:…); default is TOFU
    roomPassword: undefined, // optional join password guests must present before knocking
    cap: undefined, // optional requested room size (--max-guests); the relay clamps it
    yes: false, // --yes: skip the first-run setup screen (for scripts / non-interactive)
    childArgs: [],
  };
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-relay') opts.relay = false;
    else if (a === '--live') opts.live = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--relay') opts.relayUrl = argv[++i] ?? opts.relayUrl;
    else if (a === '--no-hooks') opts.hooks = false;
    else if (a === '--web-port') opts.webPort = Math.max(1, Number(argv[++i]) || opts.webPort);
    else if (a === '--cmd') opts.cmd = argv[++i];
    else if (a === '--guests') opts.guests = argv[++i] ?? opts.guests;
    else if (a === '--secret') opts.secret = argv[++i] ?? opts.secret;
    else if (a === '--fingerprint') opts.fingerprint = argv[++i] ?? opts.fingerprint;
    else if (a === '--room-password') opts.roomPassword = argv[++i] ?? opts.roomPassword;
    else if (a === '--max-guests') {
      const n = Math.floor(Number(argv[++i]));
      if (Number.isFinite(n) && n > 0) opts.cap = n; // a bad value is ignored (relay default stands)
    } else if (a === '--') {
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

  // ── first run: the one-screen setup (installs /collab + shims `claude`) ────────
  // Shown ONCE, only on a real interactive run. The bold hazard: rigs/tests spawn
  // interactive PTYs, so this MUST be gated off for them — every rig/e2e host spawn
  // sets CLAUDE_SHARE_SKIP_SETUP=1 (shouldRunSetup honors it), or the suite hangs
  // here at the picker. runSetup writes the shown-once marker when it completes.
  if (shouldRunSetup({ stdinTTY: stdin.isTTY, stdoutTTY: stdout.isTTY, skipEnv: process.env.CLAUDE_SHARE_SKIP_SETUP, yes: opts.yes })) {
    try {
      await runSetup({ input: stdin, output: stdout });
    } catch {
      /* setup is best-effort — never block the session on it */
    }
  }
  // The terminal band is permanently exactly ONE status line, pinned to the bottom
  // row. Claude gets every other row; the child PTY is resized to rows-1 each repaint.
  const BAND_ROWS = 1;
  const multiplayer = opts.relay; // the guest composer/gate + mirror are active only when sharing
  // Lazy sharing (spec phase 5a): pre-live, the wrapper is pixel-identical to plain
  // claude — the relay is not dialed and the band paints ZERO rows, so the child owns
  // every terminal row. wantLive flips exactly once, at go-live (--live at startup, or
  // `collab go` over the control socket). isLive() gates every sharing-shaped behavior
  // (band height, the shared-size clamp); bandRows() is the one height source.
  let wantLive = opts.live;
  const isLive = () => multiplayer && wantLive;
  const bandRows = () => (isLive() ? BAND_ROWS : 0);
  // The host's browser tab authenticates with this token: it knocks with fingerprint
  // `webhost:<token>:<seat>`, and the brain auto-admits it as host. The token goes in
  // the room URL we print/copy; the SEAT does not — the browser mints it locally, so
  // possessing the (leak-prone) URL is not enough to take the host seat.
  const hostToken = randomBytes(16).toString('hex');
  const HOST_FP_PREFIX = `webhost:${hostToken}`;
  // The room file the wrapped Claude reads to learn its own invite link. Its PATH is
  // ALWAYS exported (CLAUDE_SHARE_ROOM_FILE, below) so "running under collab" is
  // detectable; the file only EXISTS while a room is live (written on grant/reclaim,
  // removed on gone/give-up/exit). Whitelisted: the host token never reaches it.
  const roomFile = path.join(os.tmpdir(), `claude-share-room-${process.pid}.json`);
  // The control socket the wrapped Claude drives with `collab go|off|status` (spec
  // phase 5a). Its PATH is exported as CLAUDE_SHARE_CTL for every spawn; the socket
  // itself is created below (0600, same-user only) and unlinked in cleanup(). The
  // host URL/token NEVER crosses it — replies carry room + inviteUrl only.
  const ctlPath = path.join(os.tmpdir(), `claude-share-ctl-${process.pid}.sock`);
  // The seat this session is bound to: the first host browser's seat secret claims
  // it; later browsers presenting the token with a different/absent seat are refused
  // (leaked-link defense). Reset by a host-terminal Ctrl-G handoff (see below).
  let boundSeat = null;
  // Parse a knock fingerprint: null ⇒ not a host tab; '' ⇒ host token but NO seat
  // (a raw link opened without our client, or a forgery) ⇒ refused; else the seat.
  const hostSeatOf = (fp) => {
    if (typeof fp !== 'string' || !fp.startsWith(HOST_FP_PREFIX)) return null;
    const rest = fp.slice(HOST_FP_PREFIX.length);
    return rest.startsWith(':') ? rest.slice(1) : '';
  };
  // Is this fingerprint the bound host tab (or the first to claim the empty seat)?
  const isBoundHost = (fp) => {
    const seat = hostSeatOf(fp);
    return seat !== null && seat !== '' && seat === boundSeat;
  };
  // Handoff window: after a mismatched host attempt is refused, pressing Ctrl-G in
  // the host TERMINAL (which no remote participant can reach) releases the seat so
  // the next device claims it. Armed briefly and only then; zero interception else.
  let handoffTimer = null;
  const armHandoff = () => {
    clearTimeout(handoffTimer);
    handoffTimer = setTimeout(() => {
      handoffTimer = null;
    }, 60_000);
    handoffTimer.unref?.();
  };
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
  const history = new History(); // per-turn who-typed-what + Claude's response
  const toasted = new Set(); // userIds already shown the viewer toast
  const knockInfo = new Map(); // id -> {name, fp} captured at knock time
  const pointers = new Map(); // userId -> {x, y} normalized 0..1 (browser cursors)
  // The host's own browser tab(s): connection ids that authenticated with the host
  // token. They are the HOST, not separate participants (finding 4) — mapped to
  // HOST_ID for input attribution and never counted as a second roster entry.
  const hostTabIds = new Set();
  const hostTabSizes = new Map(); // host-tab connection id -> {cols, rows} capacity
  // Fingerprints admitted this session. A returning fp walks back in without a
  // second admit (a reload shouldn't cost a knock); kicks remove the fp AND ban
  // it at the relay, so a kicked guest can never ride this back in.
  const admittedFps = new Set();
  const claude = { state: 'idle' };
  let armed = false; // true only while a permission ask is pending (hook-armed)
  let pendingKnocks = []; // FIFO of guest {id,name,fp,seen} awaiting the host tab's admit
  let currentUrl = null; // the host-tab URL (WITH host token) — host's own terminal only
  let inviteUrlStr = null; // the token-free invite URL — safe to show guests in the mirror
  const ui = { toast: null, toastTimer: null, notice: null, noticeSeq: 0 };
  // Throttle for the "no draft focused" nudge a prompter gets when their typed
  // text is dropped (drafts are created explicitly — never by stray typing).
  const nudgedAt = new Map();
  let relay = null;
  let ctl = null; // the control-socket server (started below; closed in cleanup)
  let exited = false;
  // Reconnect-with-reclaim state (spec §failure-behavior: the relay holds the code
  // 10 min after a host drop). On a lost connection we reconnect and RECLAIM the
  // room we still hold, rather than abandoning it.
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 8;
  // A terminal relay verdict (REFUSED hello, or its ssh identity changed). Not
  // transient — retrying is pointless (secret) or dangerous (impersonation), so
  // this flag stops the reconnect loop for the rest of the run.
  let relayVetoed = false;

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
      process.stderr.write(`collab: hook setup failed (${err.message}); state detection off\n`);
      hooks = null;
    }
  }

  let pty;
  try {
    // CLAUDE_SHARE_ROOM_FILE is set for EVERY spawn, solo included: its presence
    // tells the child it's running under collab; the file at that path appears only
    // once a room is live (phase 5's skill relies on that live-vs-not distinction).
    const childEnv = { CLAUDE_SHARE_ROOM_FILE: roomFile, CLAUDE_SHARE_CTL: ctlPath };
    // Recursion guard: when the wrapped command is `claude`, strip the shim dir from
    // the child's PATH so it resolves to the REAL claude, never back to the shim that
    // execs us (stripShimDir is spike-proven; see src/shim.js). Any other --cmd keeps
    // PATH untouched.
    if (opts.cmd === 'claude') childEnv.PATH = stripShimDir(process.env.PATH, os.homedir());
    pty = await startPty({ cmd: opts.cmd, args: childArgs, bandRows: bandRows(), env: childEnv });
  } catch (err) {
    process.stderr.write(
      `collab: could not start "${opts.cmd}": ${err.message}\n` +
        'A "posix_spawnp failed" here usually means node-pty\'s spawn-helper lost its execute bit\n' +
          '(package managers that skip install scripts do this). Fix:\n' +
          '  chmod +x "$(npm root -g)/@claudecollab/cli/node_modules/node-pty/prebuilds/"*/spawn-helper\n' +
          'Otherwise check that the wrapped command exists on your PATH.\n',
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

  // The status line's fields. The host's OWN terminal shows the host-tab URL (carries
  // the token); the MIRRORED variant sent to guests shows only the token-free invite
  // URL — the host token must NEVER leave the host's own stdout (finding 1).
  const statusFields = (mirror = false) => ({
    room: state.room,
    people: state.list().length,
    claudeState: stateSlot(),
    url: mirror ? inviteUrlStr : currentUrl,
  });

  // The host's own browser tab is the host, not a separate participant (finding 4):
  // map its connection id to HOST_ID so its keystrokes/pointer/ui are attributed to
  // the host and it never shows up as a second roster entry (or inflates the count).
  const actorOf = (id) => (hostTabIds.has(id) ? HOST_ID : id);

  // The coordinate space the band paints into. In a shared session it is the CLAMPED
  // shared size (min of participants, floor 80×24), so every participant — the host
  // included — sees the SAME layout anchored at the same rows (finding 3), and the
  // one painted band can be written to the host and mirrored to guests unchanged.
  // The host TAB is not a roster participant (finding 4) but it IS a size
  // participant: folding its capacity in makes the shared view browser-shaped from
  // the start — solo, the clamp used to carry only the host TERMINAL's aspect, so
  // the mirror letterboxed until the first guest join reshaped it.
  // Solo with no tab there is no shared view, so we use the host's own terminal.
  const viewSize = () => {
    // Pre-live (and solo) the child owns the real terminal exactly — no floor clamp,
    // no resize theft. The shared-size clamp only governs once we are actually live.
    if (!isLive()) return { cols: stdout.columns || 80, rows: stdout.rows || 24 };
    let { cols, rows } = state.clamp();
    for (const s of hostTabSizes.values()) {
      cols = Math.min(cols, s.cols);
      rows = Math.min(rows, s.rows);
    }
    return { cols: Math.max(FLOOR_COLS, cols), rows: Math.max(FLOOR_ROWS, rows) };
  };

  // Send a shared-view frame to the guests who should see it. When everyone is at or
  // above the 80×24 floor this is a single broadcast; when at least one guest is below
  // the floor we deliver per-guest to the eligible ones only, so a below-floor guest
  // stays parked on the spectate hint instead of receiving a mirror sized for bigger
  // terminals (spec §renderer clamp). Suppressed while paused.
  const mirror = (data) => {
    if (!relay || !multiplayer || state.paused) return;
    if (state.spectators().length === 0) {
      relay.sendScreen(data); // broadcast reaches every live guest AND the host tab
    } else {
      for (const id of state.mirrorTargets()) relay.sendTo(id, data);
      // The host's own tab is not a roster participant (finding 4), so it isn't in
      // mirrorTargets — deliver to it explicitly so its mirror never freezes when a
      // below-floor spectator forces the per-guest path.
      for (const id of hostTabIds) relay.sendTo(id, data);
    }
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
    history: history.snapshot(),
    claudeState: claude.state,
    paused: state.paused,
    pointers: Object.fromEntries(
      [...pointers]
        .filter(([id]) => state.get(id)) // drop a pointer whose owner has left
        .map(([id, p]) => [id, { x: p.x, y: p.y, name: nameOf(id), color: state.colorOf(id) }]),
    ),
    knocks: pendingKnocks.map((k) => ({ id: k.id, name: k.name, fp: k.fp, seen: k.seen })),
    // The latest per-user notice, addressed by id. Browser tabs show it as a toast
    // when it's theirs; injecting bytes into the mirror (the ssh-guest channel) is
    // invisible there because Claude's TUI repaints right over them.
    notice: ui.notice,
    // The shared clamp — the ONE size every mirrored frame is painted at. Browser
    // tabs must render their xterm at exactly this size (scaling visually to fit)
    // or wide frames wrap into garbage; a tab's own container size is only its
    // CAPACITY, reported via resize and folded into this clamp.
    view: viewSize(),
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
    const band = bandRows(); // 0 pre-live (paint() no-ops, child keeps every row), 1 once live

    // Keep Claude's region to exactly the rows the band does not occupy, at the
    // shared width — resize the child only when that actually changes.
    const childRows = Math.max(1, rows - band);
    if (cols !== appliedCols || childRows !== appliedChildRows) {
      const reclamp = appliedCols !== null;
      appliedCols = cols;
      appliedChildRows = childRows;
      try {
        pty.resizeChild(cols, childRows);
      } catch {}
      // A shared-size change reflows the mirrors' old-size content into ghost text
      // (Claude repaints its region on SIGWINCH, but never the rows above it).
      // Erase screen+scrollback IN the byte stream so it is ordered BEFORE the
      // repaint frames — a client-side clear can't be ordered against frames.
      if (reclamp) mirror('\x1b[2J\x1b[3J\x1b[H');
    }

    // Paint TWO variants of the one status line from the SAME layout: the host's own
    // terminal gets the host-tab URL (with its token); guests get a token-free variant
    // (the invite URL) so the host token can never leak through the mirror (finding 1).
    let hostPaint = paint({ cols, rows, bandRows: band, ...statusFields(false) });
    let mirrorPaint = paint({ cols, rows, bandRows: band, ...statusFields(true) });
    // Ghost-band cleanup: when the shared clamp SHRINKS, rows below the new region
    // keep stale band paint on any terminal taller than the new clamp. Erase below
    // the region BEFORE repainting (order matters: on a terminal exactly `rows`
    // tall the erase clips to the band's last row, and the repaint restores it).
    // The flag persists until a repaint actually reaches guests (pause suppresses
    // the mirror, and a ghost must not outlive the pause).
    if (lastPaintRows !== null && rows < lastPaintRows) pendingClearBelow = true;
    lastPaintRows = rows;
    if (pendingClearBelow) {
      const clear = `\x1b7\x1b[${rows + 1};1H\x1b[0J\x1b8`;
      hostPaint = clear + hostPaint;
      mirrorPaint = clear + mirrorPaint;
      if (!state.paused) pendingClearBelow = false;
    }
    if (stdout.isTTY) stdout.write(hostPaint);
    mirror(mirrorPaint); // mirror() owns the relay/multiplayer/paused checks
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

  // The throttled "your typing went nowhere" nudge (default: explicit-draft copy).
  const nudge = (userId, msg = 'no draft focused — hit + draft (or double-click the terminal) to compose') => {
    const now = Date.now();
    if (now - (nudgedAt.get(userId) ?? 0) < 8000) return;
    nudgedAt.set(userId, now);
    notify(userId, msg);
  };

  // A message meant for one participant: an addressed state.notice (browser tabs
  // render it as a header chip), surfaced in the host's band too so moderation
  // stays visible. Never injected as raw bytes — Claude's TUI repaints over them
  // on an ssh terminal and they smear ABOVE the band in a web mirror.
  const notify = (userId, msg) => {
    ui.notice = { id: userId, msg, seq: ++ui.noticeSeq };
    showToast(msg); // repaints the band, which also schedules a state emit
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
  // A split write (text, then \r 120ms later) briefly owns the pty; pumping a
  // prompt into that gap would interleave bytes into the half-typed line. The
  // lock defers the pump past the gap and retries.
  let ptyLockUntil = 0;

  // pump()'s busy is OPTIMISTIC — only real once the UserPromptSubmit hook
  // confirms the prompt actually submitted. Claude's paste heuristic sometimes
  // swallows a trailing Enter (timing-dependent), leaving the text unsent in the
  // input while the room shows "brewing" forever. Watchdog: re-press Enter once
  // at 2s; if still unconfirmed at 8s, fall back to idle so the room can't wedge.
  let submitTimers = [];
  const clearSubmitWatch = () => {
    for (const t of submitTimers) clearTimeout(t);
    submitTimers = [];
  };
  const armSubmitWatch = () => {
    clearSubmitWatch();
    const retry = setTimeout(() => {
      try {
        pty.write('\r');
      } catch {}
    }, 2000);
    const bail = setTimeout(() => {
      if (claude.state === 'busy') {
        claude.state = 'idle';
        showToast('a prompt may not have submitted — check the input line', 8000);
        repaintBand();
      }
    }, 8000);
    retry.unref?.();
    bail.unref?.();
    submitTimers = [retry, bail];
  };

  // An interrupt — a lone Esc reaching the pty while a turn runs — aborts the
  // turn, but Claude fires NO Stop hook for it (verified live), so the room would
  // stick "brewing" until a manual resync. If no hook of any kind lands shortly
  // after the Esc, trust the interrupt and return to idle. Esc during an 'ask'
  // dismisses the ask the same hookless way, so any non-idle state qualifies.
  let lastHookAt = 0;
  const sniffInterrupt = (bytes) => {
    if (bytes !== '\x1b' || !hooks || claude.state === 'idle') return;
    const sentAt = Date.now();
    const t = setTimeout(() => {
      if (claude.state !== 'idle' && lastHookAt < sentAt) {
        claude.state = 'idle';
        armed = false;
        pump();
        repaintBand();
      }
    }, 1500);
    t.unref?.();
  };

  // Claude's response to the turn that just finished, read from the session
  // transcript the Stop hook hands us (`transcript_path`). We read only the tail —
  // the latest turn is at the end — so a long session's transcript stays cheap, and
  // a truncated leading line is tolerated by the extractor. Any failure → '' (the
  // window still shows the prompt; the response just stays blank).
  const RESPONSE_TAIL_BYTES = 256 * 1024;
  const captureResponse = (payload) => {
    const file = payload && typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
    if (!file) return '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const { size } = fs.fstatSync(fd);
        const start = Math.max(0, size - RESPONSE_TAIL_BYTES);
        const len = size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return extractLatestResponse(buf.toString('utf8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  };

  const pump = () => {
    if (Date.now() < ptyLockUntil) {
      const retry = setTimeout(pump, 160);
      retry.unref?.();
      return;
    }
    if (!hooks || claude.state !== 'idle') return; // no drain unless known-idle
    const item = queue.drain('idle');
    if (!item) return;
    // Split write, same as slash sends: written as one atomic chunk, Claude's
    // paste heuristic can treat the trailing \r as a pasted newline and the
    // prompt sits unsent (dogfood: intermittent stuck-in-queue wedge).
    ptyLockUntil = Date.now() + 150;
    pty.write(item.text);
    const enter = setTimeout(() => {
      try {
        pty.write('\r');
      } catch {}
    }, 120);
    enter.unref?.();
    claude.state = 'busy'; // optimistic; the UserPromptSubmit hook confirms
    history.start(item.author, item.text); // open a turn; Stop closes it with the response
    armSubmitWatch();
    repaintBand();
  };

  // ── routing a sent draft ─────────────────────────────────────────────────────
  const routeSend = (userId, send) => {
    const role = state.roleOf(userId) ?? 'viewer';
    const text = send.text;
    const cls = classifySend(text);

    if (cls.kind === 'command') return handleCommand(userId, text);

    // Pause must freeze EVERY guest path to Claude, not just raw keystrokes
    // (onKey already bails on pause). A crafted {ui,command} rides the one channel
    // left open during pause — handleUi allows kind:'command' so the host can
    // /resume — and those management commands returned above via handleCommand.
    // Anything still here is Claude-bound (prompt / claude-slash / bash) and must
    // be frozen, or a prompter could keep driving Claude while sharing reads paused.
    if (state.paused) {
      notify(userId, 'sharing is paused — the host will resume shortly');
      return;
    }

    if (!sendAllowed(cls.kind, role)) {
      const what = cls.kind === 'bash' ? 'run bash' : cls.kind === 'claude-slash' ? 'use slash commands' : 'send that';
      notify(userId, `you can't ${what} — ask the host for a role that can type`);
      return;
    }
    // Bound for Claude. Log by display name (card is display-only); attribute the
    // queue by userId (permission + purge on leave).
    log.prompt(nameOf(userId), text);
    if (!hooks) {
      pty.write(text + '\r'); // no state tracking → send immediately
      return;
    }
    // Claude slash commands and ! bash never fire hooks, so a busy→idle round trip
    // can't confirm them. Queueing one flips the room 'busy' forever and wedges the
    // queue (dogfood: /model froze the room). Fire them only while Claude is
    // known-idle, and leave the state alone — no hook will ever clear it.
    if (cls.kind === 'claude-slash' || cls.kind === 'bash') {
      if (claude.state !== 'idle') {
        notify(userId, `Claude is ${claude.state} — slash and bash fire only while it's idle`);
        return;
      }
      // Type like a human: the text, then Enter as its own keystroke a beat later.
      // Written as one atomic chunk, Claude's paste heuristic can treat the trailing
      // \r as a pasted newline and the command submits as a plain chat message.
      // ponytail: two slash sends inside the gap could interleave; humans don't.
      ptyLockUntil = Date.now() + 150; // keep pump() out of the split-write gap
      pty.write(text);
      const enter = setTimeout(() => {
        try {
          pty.write('\r');
        } catch {}
      }, 120);
      enter.unref?.();
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
    const fp = state.get(targetId)?.fp;
    if (fp) admittedFps.delete(fp); // no auto-readmit for the kicked
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
        // deletes their own queued item; the host deletes any. Per-item rights
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
        endSession(parsed.save);
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
      broadcast(recapCard(by, summary, { cols: viewSize().cols }));
      showToast('recap posted to the room', 6000);
    });
  }

  // /end — end the room now. The two-step "end? / save?" confirmation is a browser-UI
  // concern (the host tab gates it and fires a single /end); the terminal has no y/n
  // path anymore. The browser's "Save & end" sends `/end` (save) and "Just end" sends
  // `/end nosave` (skip). `save` defaults to true so a bare host-typed /end still keeps
  // the record; a nosave never touches disk (so it can't overwrite an existing file).
  function endSession(save = true) {
    if (save) {
      try {
        log.write(path.join(process.cwd(), 'session.md'));
      } catch {}
    }
    relay?.end();
    cleanup(0);
  }

  // Free a guest's seat and purge their footprint — draft boxes, queued items, any
  // stale knock — then re-clamp the shared view and announce the departure. Shared
  // by a relay-signaled LEFT (wifi drop / natural disconnect) and a self-detach.
  const forgetGuest = (id) => {
    const wasParticipant = !!state.get(id); // an admitted guest (not just a pending knock)
    const name = nameOf(id);
    state.removeGuest(id);
    drafts.removeUser(id);
    queue.removeByAuthor(id);
    pendingKnocks = pendingKnocks.filter((k) => k.id !== id);
    knockInfo.delete(id);
    pointers.delete(id);
    recomputeClamp(); // repaints + refreshes the roster/count either way
    // Only announce a departure for someone who actually joined — a superseded pending
    // knock (deduped reconnect / timeout) or a closing host tab never "left" (finding 3).
    if (wasParticipant) {
      log.event(`${name} left`);
      showToast(`${name} left`);
    }
  };

  // ── input effect application (host + guests, one table via the gate) ─────────
  const applyInput = (userId, eff) => {
    switch (eff.kind) {
      case 'pty':
        sniffInterrupt(eff.data);
        pty.write(eff.data);
        break;
      case 'draft': {
        // Drafts are created EXPLICITLY (the + draft chip / a double-click send
        // Ctrl+N) — stray typing with no focused box is dropped, with a nudge when
        // it looked like real text (only viewers' strays reach here now).
        if (!drafts.activeBox(userId) && !String(eff.bytes).includes('\x0e')) {
          if (/^[^\x00-\x1f\x7f]/.test(String(eff.bytes))) nudge(userId);
          break;
        }
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
  // Admit a knock AND send its catch-up in ONE synchronous burst (finding 2): the
  // join context card, then the CURRENT screen snapshot, straight after ADMIT. Because
  // nothing awaits between them, no pty frame can interleave — so on the wire the order
  // is ADMIT, card, snapshot, then any live frame the host mirrors afterward. The
  // joiner therefore applies the snapshot BEFORE any queued live frame and sees exactly
  // one clean copy of the screen (the old code sent the catch-up a round-trip later, in
  // onJoin, so live frames emitted during that window slipped in first — the garble).
  const admitAndCatchUp = (r, knock) => {
    r.admit(knock.id);
    // The host's own tab IS the host, not a room member (finding 4): no roster entry,
    // no context card. It still mirrors the live screen, so it does get the snapshot.
    if (isBoundHost(knock.fp)) {
      hostTabIds.add(knock.id);
      knockInfo.set(knock.id, { name: knock.name, fp: knock.fp, role: 'host' });
      if (!state.paused) {
        try {
          const snap = snapshot.get();
          if (snap) r.sendTo(knock.id, snap);
        } catch {}
      }
      return;
    }
    const info = knockInfo.get(knock.id) ?? { name: knock.name, fp: knock.fp };
    // addGuest restores the role a returning fingerprint last held this session
    // (spec §identity); a new/keyless guest takes the room default (opts.guests).
    const g = state.addGuest(knock.id, { name: info.name, fp: info.fp, role: info.role ?? opts.guests });
    if (info.fp) admittedFps.add(info.fp); // reloads re-enter without a second admit
    log.event(`${g.name} joined as ${g.role}`);
    // The join context card lands in the guest's own scrollback first (spec §join card).
    try {
      const card = buildCard(state, log, { joinerId: knock.id, claudeState: claude.state });
      r.sendTo(knock.id, card.replace(/\n/g, '\r\n') + '\r\n');
    } catch {}
    // Then the CURRENT Claude screen so the joiner sees it live immediately.
    try {
      if (state.paused) {
        // The snapshot is exactly what /pause promises to hide — a joiner during a
        // pause gets the hold card, and the live screen on /resume.
        r.sendTo(knock.id, '\r\n⏸ sharing is paused — the live screen will appear when the host resumes\r\n');
      } else {
        const snap = snapshot.get();
        if (snap) r.sendTo(knock.id, snap);
      }
    } catch {}
    showToast(`${g.name} joined as ${g.role} ${ROLE_GLYPH[g.role] ?? ''}`);
    recomputeClamp();
  };

  // Resolve a specific pending knock by id. Answered ONLY from the host's browser tab
  // (a {t:'ui'} admit/deny button); state.knocks shows the host all pending knocks.
  // The terminal has no y/n knock path anymore (post-dogfood verdict).
  const answerKnockById = (knockId, admitYes) => {
    const idx = pendingKnocks.findIndex((k) => k.id === knockId);
    if (idx === -1 || !relay) return;
    const [knock] = pendingKnocks.splice(idx, 1);
    if (admitYes) admitAndCatchUp(relay, knock);
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
    // While paused, only room management stays live (resume/end/admit/roles);
    // draft edits, scrolling, and queue changes are frozen with the mirror.
    if (state.paused && !['admit', 'deny', 'kick', 'role', 'command', 'resync'].includes(action.kind)) return;
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
    // A mouse click inside a draft box: place that user's caret there (joining the
    // box if it isn't theirs). Composing is prompter+, same as typing into it.
    if (action.kind === 'caret') {
      if (!atLeast(role, 'prompter')) return;
      if (drafts.placeCaret(id, action.id, action.offset)) repaintBand();
      return;
    }
    // A drag-selection being deleted (or typed over — the replacement char follows
    // as an ordinary key). Same bar as typing: prompter and up.
    if (action.kind === 'delrange') {
      if (!atLeast(role, 'prompter')) return;
      if (drafts.deleteRange(id, action.id, action.start, action.end)) repaintBand();
      return;
    }
    // Move/resize a draft — SHARED: everyone sees the box travel live. Placement
    // is stage-fraction coordinates; home:true snaps it back above the input line.
    // No band repaint — the terminal status line doesn't carry draft geometry.
    if (action.kind === 'place') {
      if (!atLeast(role, 'prompter')) return;
      const spot = action.home ? null : { x: action.x, y: action.y, w: action.w };
      if (drafts.placeBox(action.id, spot)) scheduleState();
      return;
    }
    // "Edit" on a queued item: pull it OUT of the queue and back into a fresh
    // draft box, focused on the requester. Author-only, like /queue edit.
    if (action.kind === 'unqueue') {
      const item = queue.items[Math.trunc(action.n) - 1];
      if (!item) return notify(id, `no queued item #${action.n}`);
      if (item.author !== id) return notify(id, 'you can only edit your own queued item');
      queue.remove(item.id, id, role);
      drafts.seedDraft(id, item.text);
      log.event(`${nameOf(id)} pulled queued item back to a draft`);
      repaintBand();
      return;
    }
    // The ✕ on a draft box: authors delete their own; the host, any.
    if (action.kind === 'deldraft') {
      if (!atLeast(role, 'prompter')) return;
      const box = drafts.boxes.find((b) => b.id === action.id);
      if (!box) return;
      const mine = box.authors.has(id) || box.cursors.has(id);
      if (!mine && !atLeast(role, 'host')) return notify(id, "you can only delete a draft you're part of");
      if (drafts.deleteBox(action.id)) repaintBand();
      return;
    }
    // Wheel over the mirror. Claude owns transcript scrolling — it enables mouse
    // tracking and scrolls internally on wheel reports; the terminal never receives
    // scrollback lines (verified: history stays 0 even solo). So the browser wheel
    // becomes Claude's own scroll, typed into the pty and shared like any input.
    if (action.kind === 'scroll') {
      if (!atLeast(role, 'prompter')) return;
      const n = Math.min(8, Math.abs(action.lines | 0));
      if (!n) return;
      const btn = action.lines < 0 ? 64 : 65; // SGR wheel up / down
      const { cols, rows } = viewSize();
      pty.write(`\x1b[<${btn};${Math.max(1, cols >> 1)};${Math.max(1, rows >> 1)}M`.repeat(n));
      return;
    }
    // The host's escape hatch for a wedged state machine: if a hook was missed
    // (observed once after declining a permission ask), the room sticks 'busy' and
    // the queue holds forever. Clicking the state chip forces idle and drains.
    if (action.kind === 'resync') {
      if (!atLeast(role, 'host')) return;
      claude.state = 'idle';
      armed = false;
      log.event('host resynced claude state to idle');
      showToast('state resynced to idle');
      pump();
      repaintBand();
      return;
    }
    if (action.kind === 'command') routeSend(id, { text: String(action.text) });
  };

  const { host: RELAY_HOST, port: RELAY_PORT } = parseRelayUrl(opts.relayUrl);
  // Relay identity pinning (TOFU, like ssh known_hosts; --fingerprint pins
  // explicitly). Loopback is exempt unless a fingerprint was given: dev relays
  // regenerate their key every boot, and loopback MITM is outside the threat
  // model — a real relay is never at 127.0.0.1.
  const RELAY_LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(RELAY_HOST);
  const PIN_FILE = path.join(os.homedir(), '.claude-share', 'known_relays.json');
  // Two URLs, deliberately kept apart (see src/invite.js). The host opens the hostUrl
  // (carries the token → auto-admit as host); the token-free inviteUrl is the safe link
  // to hand a friend. The status line shows the hostUrl (the host's own private
  // terminal); the clipboard + the host tab's "copy invite" button use the inviteUrl.
  // A deployed relay advertises its public https origin in the room grant; links
  // then print https://domain/room. Localhost dev has none → http://host:webPort.
  let publicBase = null;
  const hostRoomUrl = (code) => hostUrl({ base: publicBase, host: RELAY_HOST, port: opts.webPort, code, token: hostToken });
  const inviteRoomUrl = (code) => inviteUrl({ base: publicBase, host: RELAY_HOST, port: opts.webPort, code });

  // Best-effort clipboard copy of the INVITE (never the host URL). Only reports success
  // once pbcopy has actually exited cleanly — macOS-only, opt-out via the env var, and
  // failures no longer masquerade as a copy (finding 5).
  const copyInvite = (text, done) => {
    if (process.platform !== 'darwin' || process.env.CLAUDE_SHARE_NO_CLIPBOARD) return done(false);
    try {
      const pb = execFile('pbcopy', (err) => done(!err));
      pb.stdin.on('error', () => {}); // a broken pipe surfaces via the exec callback
      pb.stdin.end(text);
    } catch {
      done(false);
    }
  };
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
    // A superseded instance (off() tore it down mid-dial, or a reconnect replaced
    // it) must never mutate room state: a stale late ROOM grant would resurrect a
    // session the user just turned off, and a stale REFUSED would veto future gos.
    // onClose below already carries the same guard.
    const current = () => r === relay;
    r.onRoom((code, webUrl) => {
      if (!current()) return;
      reconnectAttempts = 0;
      publicBase = webUrl || null; // a deployed relay's public https origin (or none)
      const reclaimed = state.room === code; // we already held this exact code → reclaim
      state.setRoom(code);
      currentUrl = hostRoomUrl(code); // the host's own tab URL lives in the status line
      inviteUrlStr = inviteRoomUrl(code); // the token-free variant the mirror shows guests
      // Expose the live room's INVITE link to the wrapped Claude (whitelist drops the
      // token-bearing host URL). Runs on create AND reclaim — a reclaim may carry a
      // fresh publicBase, so the file is always rewritten from the current values.
      writeRoomFile(roomFile, { room: code, inviteUrl: inviteUrlStr, webUrl: publicBase ?? undefined });
      if (reclaimed) {
        showToast('reconnected — room reclaimed', 6000);
        return;
      }
      // Copy the SAFE invite (token-free); the host reaches their own tab via the
      // status-line URL. Claim the copy only if it actually happened (finding 5).
      copyInvite(inviteRoomUrl(code), (copied) => showToast(readyToast(copied), 15000));
    });
    r.onGone(() => {
      if (!current()) return;
      // Reclaim refused: the 10-min TTL lapsed, the relay restarted (fresh
      // registry), or the room truly ended. Nothing to return to — drop the code
      // AND its links (a dead URL on the band reads as a live room), finish solo.
      state.setRoom(null);
      currentUrl = null;
      inviteUrlStr = null;
      clearRoomFile(roomFile); // the room is gone — the child must not read a dead link
      showToast('the room expired while disconnected — continuing solo', 8000);
      repaintBand();
    });
    r.onRefused((reason) => {
      if (!current()) return;
      // The relay rejected our HELLO outright. 'secret' = it requires a room
      // secret we didn't present (or ours is wrong); 'version' = it speaks a newer
      // protocol than we do (update the CLI). Terminal, not transient.
      relayVetoed = true;
      let msg;
      if (reason === 'secret') msg = 'relay requires a room secret — set CLAUDE_SHARE_SECRET (or --secret) and restart. running solo';
      else if (reason === 'version') msg = 'relay speaks a newer protocol — update with: npm update -g @claudecollab/cli. running solo';
      else msg = `relay refused the connection (${reason}) — running solo`;
      // A refusal means sharing never began — after the explanatory toast has had
      // its 15s on the band, return the session to fully invisible (band gone, the
      // child reclaims the row) instead of sticking a dead live-band on a solo
      // session. goLiveStarted resets so a later `go` (fixed secret) can redial.
      showToast(msg, 15000);
      const invis = setTimeout(() => {
        wantLive = false;
        goLiveStarted = false;
        repaintBand();
      }, 15000);
      invis.unref?.();
      repaintBand();
    });
    r.onKnock((knock) => {
      // The host's own browser tab knocks with fp `webhost:<token>:<seat>`. The seat
      // binds the host seat to the FIRST browser to present one; later browsers with
      // the token but a different/absent seat are refused (a leaked host LINK carries
      // the token but not the seat). This is the one knock answered with no ui action.
      const hostSeat = hostSeatOf(knock.fp);
      if (hostSeat !== null) {
        if (boundSeat === null && hostSeat !== '') {
          boundSeat = hostSeat; // first claim wins
          log.event('host seat claimed');
        }
        if (isBoundHost(knock.fp)) {
          admitAndCatchUp(r, knock);
          return;
        }
        // Token but wrong/empty seat: refuse host access. Arm a handoff so the real
        // host — if it IS them on a new device — can release the seat with Ctrl-G.
        r.deny(knock.id);
        armHandoff();
        showToast('⚠ a device opened your host link but is not your bound host — refused. If it is you, press Ctrl-G here to hand over the host seat.', 20000);
        log.event('refused a host-link opener with the wrong seat');
        return;
      }
      // A guest admitted earlier this session (same browser token) walks straight
      // back in — a reload or network blip shouldn't cost them a second admit.
      // Kicked fps were removed above AND banned at the relay, so they never reach here.
      if (knock.fp && admittedFps.has(knock.fp)) {
        knockInfo.set(knock.id, { name: knock.name, fp: knock.fp });
        admitAndCatchUp(r, knock);
        return;
      }
      // Dedup by fingerprint: a WS reconnect during the join flow re-knocks with a new
      // connection id but the SAME fp — replace the stale card, don't stack a duplicate
      // (finding 3). Deny the superseded connection so it can't be admitted later.
      const { pending, replaced } = foldKnock(pendingKnocks, knock);
      pendingKnocks = pending;
      for (const staleId of replaced) {
        r.deny(staleId);
        knockInfo.delete(staleId);
      }
      knockInfo.set(knock.id, { name: knock.name, fp: knock.fp });
      repaintBand();
    });
    r.onJoin(() => {
      // The admit action (admitAndCatchUp) already added the participant and sent the
      // catch-up (card + snapshot) synchronously, so the snapshot is guaranteed to be
      // on the wire before any live frame (finding 2). JOINED is just the relay's
      // confirmation; the RESIZE that follows it drives the clamp (see onResize).
    });
    r.onLeave((id) => {
      guestPartitioners.delete(id);
      hostTabIds.delete(id); // a host tab closing is not a roster departure
      hostTabSizes.delete(id); // …but its capacity leaves the clamp
      forgetGuest(id);
    });
    r.onKey(({ id, data }) => {
      // Guests' terminals also answer mirrored queries and emit mouse reports.
      // Claude already gets the HOST terminal's answers; guest chatter is
      // dropped (v1: guest mouse doesn't drive the shared session).
      const { human } = guestPartitioner(id)(data);
      if (!human) return;
      // Paused = the room is frozen for every browser/ssh participant (the host's
      // own terminal still works): no typing, no draft edits, until resume.
      if (state.paused) return;
      const actor = actorOf(id); // a host tab drives Claude AS the host (finding 4)
      const role = state.roleOf(actor) ?? 'viewer';
      const composing = drafts.activeBox(actor) !== null;
      // Anyone who can prompt and has no draft focused is AT the terminal: keys go
      // raw to Claude (composing is opt-in) — asks, modes, everything (prompter and
      // host are the two typing roles now). Two keys stay ours even then: Ctrl+C
      // (an ssh guest's "leave the room") and Ctrl+N (the + draft chip).
      if (!composing && atLeast(role, 'prompter') && human !== '\x03' && human !== '\x0e') {
        sniffInterrupt(human);
        return pty.write(human);
      }
      applyInput(actor, dispatch(actor, role, Buffer.from(human, 'binary'), { armed, toasted, composing }));
    });
    r.onPointer(({ id, x, y }) => {
      const actor = actorOf(id);
      if (!actor || !state.get(actor)) return; // only a known participant's cursor
      pointers.set(actor, { x, y });
      scheduleState(); // rebroadcast via state.pointers (spec); no band repaint needed
    });
    r.onUi(({ id, action }) => handleUi(actorOf(id), action));
    r.onResize(({ id, cols, rows }) => {
      if (hostTabIds.has(id)) {
        // The host's own tab: a size participant, not a roster one (see viewSize).
        // The relay announces a placeholder 80×24 for every web rec at admit,
        // BEFORE the tab has measured itself — folding that in crashes the clamp
        // to the floor for a beat and Claude reflows its transcript twice (the
        // wrap garbage guests then see). 80×24 IS the clamp floor, so a real
        // report that size carries no information — skip both.
        if (cols !== FLOOR_COLS || rows !== FLOOR_ROWS) hostTabSizes.set(id, { cols, rows });
      } else {
        state.setSize(id, cols, rows);
        if (state.belowFloor(id)) {
          r.sendTo(id, '\x1b[2J\x1b[H  your terminal is below 80×24 — make it bigger to join the shared view\r\n');
        }
      }
      recomputeClamp();
      repaintBand();
    });
    r.onClose(() => {
      if (exited || r !== relay) return; // a superseded instance's close is not ours
      relay = null;
      if (relayVetoed) return; // refused/identity-mismatch — already explained, never retry
      scheduleReconnect();
    });
    r.onError(() => {}); // transport errors surface via onClose; never crash
  }

  // Open (or reopen) the relay connection. On ready, hello for a fresh room or
  // RECLAIM the one we still hold (spec §failure-behavior) — this is the reclaim the
  // CLI was missing. Failures on a held room retry within the TTL; an initial
  // failure just runs solo.
  function openRelay() {
    // wantLive is the invariant: only a live-intending session may dial. Guards any
    // stray timer/callback that survives an off() teardown (belt to off's braces).
    if (exited || relayVetoed || !wantLive) return;
    // Fresh pin check per attempt (it re-reads the store, picking up a pin the
    // previous attempt just made). null = loopback dev relay, no verification.
    const pin =
      opts.fingerprint || !RELAY_LOOPBACK
        ? createPinCheck({ key: `${RELAY_HOST}:${RELAY_PORT}`, file: PIN_FILE, expected: opts.fingerprint })
        : null;
    let r;
    try {
      r = connectRelay({
        url: opts.relayUrl,
        privateKey: loadHostKey(),
        secret: opts.secret,
        roomPass: opts.roomPassword,
        cap: opts.cap,
        verifyHostKey: pin ? pin.verify : undefined,
      });
    } catch (err) {
      if (state.room) return scheduleReconnect();
      process.stderr.write(`collab: relay setup failed (${err.message}); running solo\n`);
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
        if (pin?.outcome() === 'mismatch') {
          // The relay presented a key that doesn't match our pin. Either the
          // operator rotated it on purpose, or someone is impersonating the
          // relay — refuse loudly either way and never auto-retry.
          relayVetoed = true;
          process.stderr.write(
            `collab: RELAY IDENTITY CHANGED — refusing to connect.\n` +
              `collab: pinned ${pin.expected()}, but ${RELAY_HOST}:${RELAY_PORT} presented ${pin.seen()}.\n` +
              `collab: if the relay key was rotated on purpose, delete the "${RELAY_HOST}:${RELAY_PORT}"\n` +
              `collab: entry in ${PIN_FILE} and restart. otherwise DO NOT connect.\n`
          );
          showToast('relay identity changed — refusing to connect (details in terminal). running solo', 15000);
          return;
        }
        if (state.room) scheduleReconnect(); // lost a held room — keep trying within TTL
        else process.stderr.write(`collab: relay unavailable (${err.message}); running solo\n`);
      });
  }

  // A dropped connection: if we still hold a room, back off and reconnect to reclaim
  // it; otherwise there is nothing to return to, so go solo.
  function scheduleReconnect() {
    if (exited) return;
    if (!state.room) return showToast('relay disconnected — running solo', 8000);
    if (reconnectAttempts >= MAX_RECONNECT) {
      clearRoomFile(roomFile); // gave up reclaiming — the room is no longer reachable
      return showToast('could not reconnect to the relay — continuing solo', 8000);
    }
    reconnectAttempts++;
    showToast(`relay disconnected — reconnecting to reclaim the room (${reconnectAttempts}/${MAX_RECONNECT})…`, 8000);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(openRelay, reconnectAttempts === 1 ? 300 : 1500);
    reconnectTimer.unref?.();
  }

  // Go live on demand: dial the relay and flip wantLive so the band appears and the
  // child shrinks by one row (via repaintBand's resize path). Idempotent — the guard
  // makes it callable exactly once, whether from --live at startup or `collab go`
  // mid-session over the control socket. --no-relay can never go live.
  let goLiveStarted = false;
  function goLive() {
    if (goLiveStarted || exited || !opts.relay) return;
    goLiveStarted = true;
    wantLive = true;
    openRelay();
    repaintBand(); // band appears; the child is resized to rows-1
  }
  if (opts.relay && opts.live) goLive();

  // ── control socket: `collab go|off|status` drives the room lifecycle ──────────
  // The wrapped Claude connects here (CLAUDE_SHARE_CTL) to go live / stop / query
  // WITHOUT restarting. Replies carry room + inviteUrl only — never the host URL or
  // token (those stay on the host's own terminal / room file whitelist).
  ctl = startCtl({
    path: ctlPath,
    handlers: {
      // Go live: apply any valid overrides, dial the relay, and resolve on the FIRST
      // of room-granted / relay-refused / 15s timeout. Idempotent when already live.
      go: async (req) => {
        if (!opts.relay) return { ok: false, error: 'sharing disabled (--no-relay)' };
        if (state.room) return { ok: true, room: state.room, inviteUrl: inviteUrlStr ?? undefined };
        // Overrides (each validated; a bad value is ignored so the current setting stands).
        if (req.guests === 'viewer' || req.guests === 'prompter') opts.guests = req.guests;
        if (Number.isFinite(req.max) && Math.floor(req.max) > 0) opts.cap = Math.floor(req.max);
        if (typeof req.pass === 'string' && req.pass.length) opts.roomPassword = req.pass;
        goLive();
        if (!relay) return { ok: false, error: 'sharing unavailable' };
        // One-shot waiter over the live relay instance — do not restructure wireRelay,
        // just resolve on whichever event lands first. wireRelay's own onRoom runs
        // before this one (subscribed earlier), so inviteUrlStr is set by the time
        // we read it. onClose covers a dead/vetoed relay so `go` can't hang 15s.
        return await new Promise((resolve) => {
          let done = false;
          let offRoom, offRefused, offClose, timer;
          const finish = (v) => {
            if (done) return;
            done = true;
            offRoom?.();
            offRefused?.();
            offClose?.();
            clearTimeout(timer);
            resolve(v);
          };
          offRoom = relay.onRoom((code) => finish({ ok: true, room: code, inviteUrl: inviteUrlStr ?? inviteRoomUrl(code) }));
          offRefused = relay.onRefused((reason) => finish({ ok: false, error: `relay refused (${reason})` }));
          offClose = relay.onClose(() => finish({ ok: false, error: relayVetoed ? 'relay refused the connection' : 'relay unavailable' }));
          timer = setTimeout(() => finish({ ok: false, error: 'relay timeout' }), 15000);
          timer.unref?.();
        });
      },
      // Stop sharing: end the room, tear down the relay, clear the links + room file,
      // drop the band (repaint), and let a later `go` dial again. Idempotent.
      off: async () => {
        if (state.room || relay) {
          const r = relay;
          relay = null; // null first so the instance's onClose sees r !== relay (no reconnect)
          try {
            r?.end();
          } catch {}
          try {
            r?.close();
          } catch {}
          // Disarm any pending reclaim: a reconnect timer left ticking would dial
          // openRelay() after this teardown and HELLO a brand-new room with the band
          // hidden — an invisibly-live room, the one thing off() must make impossible.
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
          reconnectAttempts = 0;
          state.setRoom(null);
          currentUrl = null;
          inviteUrlStr = null;
          clearRoomFile(roomFile);
          wantLive = false;
          goLiveStarted = false;
          // Purge every participant footprint — the process now OUTLIVES the room, so
          // stale guests would haunt the next go (wrong count, crushed size clamp,
          // orphaned drafts/queue items). forgetGuest also logs each departure.
          for (const g of [...state.guests()]) forgetGuest(g.id);
          pendingKnocks = [];
          knockInfo.clear();
          pointers.clear();
          hostTabIds.clear();
          hostTabSizes.clear();
          guestPartitioners.clear();
          repaintBand(); // band disappears; the child reclaims the row
        }
        return { ok: true };
      },
      // Query without changing anything. inviteUrl only — never the host URL/token.
      status: async () => ({
        ok: true,
        live: !!state.room,
        room: state.room ?? undefined,
        inviteUrl: inviteUrlStr ?? undefined,
      }),
    },
  });

  // ── hook events → brain ───────────────────────────────────────────────────────
  if (hooks) {
    hooks.on('busy', () => {
      lastHookAt = Date.now();
      clearSubmitWatch(); // the submission is confirmed — the optimistic busy is real
      claude.state = 'busy';
      armed = false;
      repaintBand();
    });
    hooks.on('idle', (payload) => {
      lastHookAt = Date.now();
      clearSubmitWatch();
      claude.state = 'idle';
      armed = false;
      // Close the open turn with Claude's response, read cleanly from the session
      // transcript the Stop hook points us at (never scraped from the TUI).
      if (history.open) history.finish(captureResponse(payload));
      pump();
      repaintBand();
    });
    hooks.on('ask', () => {
      lastHookAt = Date.now();
      clearSubmitWatch();
      claude.state = 'ask';
      armed = true; // the ONLY thing that arms a composing-side y/n → Claude (spec: gate on events)
      repaintBand();
    });
    hooks.on('tool', (p) => {
      lastHookAt = Date.now();
      clearSubmitWatch(); // any hook activity proves Claude took the prompt
      // Tool activity proves a turn is running. A slash command's UserPromptSubmit
      // is dropped (it may never Stop — see mapHookEvent), so a slash that DOES run
      // a real turn flips busy here instead; its Stop still returns to idle.
      if (claude.state === 'idle') claude.state = 'busy';
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
    try {
      ctl?.close(); // close the control socket and unlink its file
    } catch {}
    for (const f of [settingsFile, socketPath]) {
      if (f) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
    }
    clearRoomFile(roomFile); // the session is over — the link is dead (covers /end, exit, signals)
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
    if (human) {
      // Ctrl-G (BEL) releases the bound host seat — but ONLY while a handoff is
      // armed (right after a blocked device tried to claim), so a stray BEL never
      // gets eaten during normal use. This lives on host stdin, which no remote
      // participant can reach — that is what makes the release host-only.
      if (handoffTimer && human.includes('\x07')) {
        clearTimeout(handoffTimer);
        handoffTimer = null;
        boundSeat = null;
        showToast('host seat released — reload your other device to claim it', 12000);
        log.event('host released the seat via Ctrl-G handoff');
        const stripped = human.split('\x07').join('');
        if (stripped) pty.write(Buffer.from(stripped, 'binary'));
        return;
      }
      sniffInterrupt(human); // the host's own Esc interrupt is hookless too
      pty.write(Buffer.from(human, 'binary'));
    }
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

// `collab relay [args]` IS the relay (single-bin: npx resolves one bin). serve.js
// runs on import and reads process.argv — splice ours out so its args line up.
let run;
const sub = process.argv[2];
if (sub === 'relay') {
  process.argv.splice(2, 1);
  run = import('../../relay/bin/serve.js');
} else if (sub === 'go' || sub === 'off' || sub === 'status') {
  // Run INSIDE a wrapped session: drive it via the control socket (CLAUDE_SHARE_CTL)
  // and print a human-readable result. ctlMain owns its own exit code.
  run = ctlMain(sub, process.argv.slice(3));
} else if (sub === 'setup') {
  // Re-run the first-run screen + actions ignoring the marker; `--undo` reverses the
  // shim + plugin. setupMain owns its own exit code.
  run = setupMain(process.argv.slice(3));
} else {
  run = main();
}
run.catch((err) => {
  process.stderr.write(`collab: ${err?.stack || err}\n`);
  process.exit(1);
});
