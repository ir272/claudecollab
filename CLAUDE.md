# claude-share — project context

Make a Claude Code session multiplayer: host CLI wraps Claude in a PTY, a relay
forwards bytes, guests join from a browser. See README.md for usage/architecture.

## Deployed state (2026-07-11)

- Relay live at **https://claudeshare.fly.dev** (Fly app `claudeshare`, region dfw)
- Host command: `node packages/cli/bin/claude-share.js --relay ssh://claudeshare.fly.dev:2222`
- **Exactly ONE machine, always** (`fly scale count 1`) — rooms live in the relay
  process's memory; Fly auto-adds a second machine on fresh deploys, scale it back
- A redeploy/restart ends all live rooms (hosts drop to solo) — deploy between sessions
- Deploy with `fly deploy` from the repo root; the dashboard's GitHub deployer fails opaquely
- Dedicated IPv4 168.220.81.240 ($2/mo, required for the raw-TCP ssh door) + IPv6
- `HOST_KEY` secret set (regen: `node packages/relay/bin/serve.js --make-key`)

## Dev & testing

- `npm test` — full suite, keep it green
- `scripts/rig.sh` — local relay + host wrapping a FAKE claude (test/fixtures/fake-claude.cjs),
  ports **2226 (ssh) / 8788 (web)**; `scripts/rig-real.sh` — same with the real claude
- Never use ports 2222/8787/8080 for test rigs — those are Ian's live/dev ports
- Verify UI changes by driving a real browser tab against the rig and screenshotting;
  prefer scripted ws clients / synthetic events over typing into real windows

## Conventions

- Fast direct iteration: edit → verify live → screenshot → commit. No heavy orchestration.
- Concise conventional commits. No AI attribution, no Co-Authored-By trailers.
- If something looks broken while working, say so instead of silently working around it.

## Backlog (parked, in priority order)

1. Anthropic ToS/branding check before any public release (repo stays PRIVATE until done;
   "claude" in a public domain name touches their trademark)
2. Buy real domain (`claudeshare.dev`/`.sh`/`.app`; `.re` has EU-residency friction) →
   `fly certs add`, DNS records, update PUBLIC_URL in fly.toml
3. Relay hardening if it goes public: host-side shared secret for room creation
   (maxRooms=50 lid exists); CLI should pin/verify the relay's ssh host key
4. Rust single-binary CLI for `brew install`-style distribution — only if it doesn't
   force an architecture change; port the relay first (protocol tests = spec), the CLI
   port (pty/ssh/hooks/brain) is the heavy half

## Machine-local cleanup owed (Ian's old Mac)

`/etc/hosts` has a pin `168.220.81.240 claudeshare.fly.dev` (ISP DNS had cached an
NXDOMAIN) — remove once DNS resolves naturally. New machines don't need it unless
they hit the same stale resolver.
