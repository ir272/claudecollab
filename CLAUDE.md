# claudecollab — project context

Make a Claude Code session multiplayer: the host CLI wraps Claude in a PTY, a relay
forwards bytes, guests join from a browser link. See README.md for usage.

## Architecture (the one invariant)

The relay is a dumb byte router — it stamps sender ids and forwards, stores nothing
durable, and understands nothing. ALL product intelligence lives in the host CLI (the
"brain"): roles, the per-keystroke gate, drafts, the attributed queue (drains one
prompt per idle, confirmed by Claude's hooks), knock/admit, pause, host-seat binding.
Browser tabs are views + labeled input sources; the brain is the single authority.

```
packages/shared/   wire protocol (JSON lines; HELLO carries v — see protocol.js)
packages/relay/    the server: one ssh door (terminals) + one web door (browsers)
packages/cli/      the collab command — wrapper, brain, control socket, first-run
plugin/            the /collab Claude Code plugin (+ root .claude-plugin/marketplace.json)
```

## How sharing works (since 0.2.0)

`collab` starts Claude with sharing OFF — no relay dialed, pixel-identical to plain
claude. Going live happens from INSIDE the session: `/collab` (plugin) or `collab go`,
over the control socket (`CLAUDE_SHARE_CTL`; `collab go|off|status`). The live room's
invite link is exposed to the wrapped Claude via `CLAUDE_SHARE_ROOM_FILE` (invite URL
only — the host token never reaches the file, the socket, or any guest surface).
`--live` dials at startup (rigs/tests use this). The first interactive run shows a
one-screen setup (plugin install + `claude` shim); `collab setup --undo` reverses it.

## Deployed state

- Relay: **https://claudecollab.org** (Fly app `claudeshare`, region dfw). Community
  relay — no room secret; abuse lids are maxRooms + per-IP knock limits
  (`CLAUDE_SHARE_TRUST_PROXY=1` makes those work behind Fly's proxy) + optional
  per-room passwords + the knock/admit gate.
- **Exactly ONE machine, always** (`fly scale count 1`) — rooms live in the relay
  process's memory; Fly auto-adds a second machine on deploys, scale it back.
- A redeploy/restart ends all live rooms — deploy between sessions.
- Relay ssh fingerprint (pin/verify): `SHA256:K2JkcwxqpWo5F+CP5q5Ke7RGTZYgjJ7tE/ajEajxdxY`
- Hosts pin the relay key on first connect (`~/.claude-share/known_relays.json`, TOFU);
  rotating HOST_KEY makes every host refuse until they clear the pin — rotate deliberately.

## Dev & testing

- `npm test` — full suite, keep it green at every commit.
- Test policy: tests for MONEY PATHS only (security boundaries, fs/shell mutation,
  wire/socket protocols, state machines). UI/layout is verified against the rig with
  a real browser + screenshots, not unit tests.
- `scripts/rig.sh` — local relay + host wrapping a FAKE claude (test/fixtures/
  fake-claude.cjs), ports **2226 (ssh) / 8788 (web)**; `rig-real.sh` = real claude.
- Never use ports 2222/8787/8080 for test rigs.
- Rig/e2e host spawns need `CLAUDE_SHARE_SKIP_SETUP=1` (or the first-run screen eats
  the PTY) and `--live` (or no room is created).
- node-pty spawn-helper exec bit: startPty() self-heals at runtime
  (`ensureSpawnHelperExecutable()` in pty.js) — installers that skip build scripts
  ship it non-executable.

## Conventions

- Fast direct iteration: edit → verify live → screenshot → commit.
- Concise conventional commits. No AI attribution, no Co-Authored-By trailers.
- Brand stays out of code: binaries, env vars (`CLAUDE_SHARE_*`), protocol strings,
  and config paths never carry "claudecollab".
- If something looks broken while working, say so instead of silently working around it.

## Security model (decided, don't relitigate casually)

- The host token (`?host=` URL) grants the host seat; it never leaves the host's own
  terminal/tab. Host-seat binding: the first browser's minted seat secret claims the
  seat; a leaked host LINK alone is refused (Ctrl-G in the host terminal hands off).
- Guests are gated per keystroke by role (viewer/prompter/host); prompts are
  escape-sanitized at display boundaries (join card, log, session.md) — pty-bound
  text stays raw. The wrapper scrubs CLAUDE_SHARE_SECRET from the child env.
- Deliberately deferred (revisit if the threat model changes): durable bans (no
  account system to bind to), giant single-line protocol payloads (decoder only caps
  newline-free buffers), ssh-door PROXY protocol (browsers are the stranger surface).

## Backlog (parked)

- Agent door: expose the guest protocol as a machine interface (MCP server) so an
  external agent can supervise a session — join like any guest (knock/admit, prompter
  at most), legible in the attributed queue, kickable. Bar to clear: genuinely more
  useful than subagents/Stop-hooks, framed as supervision with a human veto.
- Session replay; mobile push notifications; landing page + demo clip at
  claudecollab.org (currently the web client serves there directly).
- `rust/` workspace: a spec-port of protocol.js kept as a restart point if a
  single-binary distribution ever becomes the bottleneck.
