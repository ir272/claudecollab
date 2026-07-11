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
- **ROOM_SECRET not yet set on Fly** — room creation is still open until
  `fly secrets set ROOM_SECRET=…` + redeploy (ends live rooms — do it between
  sessions). Hosts then need `CLAUDE_SHARE_SECRET` (or `--secret`)
- The CLI pins the relay's ssh fingerprint on first connect
  (`~/.claude-share/known_relays.json`, TOFU; `--fingerprint` pins explicitly;
  loopback exempt). Rotating HOST_KEY makes every host refuse until they clear
  the pin — rotate deliberately

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

1. Rename + ToS check before any public release (repo stays PRIVATE until done).
   Researched 2026-07-11: CLAUDE is a registered mark (USPTO #7645254) and Anthropic
   enforces even phonetic near-misses (Clawdbot→Moltbot→OpenClaw, Jan 2026), so NO
   "claude" in the name/domain — claudecollab.co rejected on these grounds. Tagline
   may say "multiplayer for Claude Code" (nominative use); the brand may not.
   Candidates: partyline, coterm, co-op/coop, mob*, backseat, seance. Also keep
   marketing framed as "collaborate on a live session" — never "share your Claude
   subscription" (consumer-terms account-sharing gray zone).
2. Buy real domain (blocked on #1's name pick) → `fly certs add`, DNS records,
   update PUBLIC_URL in fly.toml
3. Relay hardening — DONE in code (HELLO room secret + relay-key pinning, 2026-07-11);
   what's left is ops: set ROOM_SECRET on Fly (see deployed state above)
4. Rust single-binary CLI for `brew install`-style distribution — only if it doesn't
   force an architecture change; port the relay first (protocol tests = spec), the CLI
   port (pty/ssh/hooks/brain) is the heavy half
5. Agent door: expose the guest protocol as a machine interface (MCP server —
   join_room / read_screen / wait_for_idle / send_prompt / answer_ask) so an
   EXTERNAL agent can supervise a session as an outer loop: independent judge
   holding the goal, re-prompting on idle until machine-checkable done-criteria
   pass (tests green, spec ticked), able to /clear or re-anchor a rotted session
   from outside. Agents join like any guest (knock/admit, prompter at most, never
   host; pause/kick apply) and browsers stay the human-watching surface — agents
   speak the protocol, not screenshots. MUST be explicit host opt-in and framed/
   defaulted as supervision, not unattended automation: continuous agent-driven
   prompting on a Pro/Max-billed session is the OpenClaw pattern Anthropic banned
   (Apr 2026) — steer this mode toward API-key billing. Free spin-off already true
   today, just needs saying on the landing page: solo remote access (open your own
   room from your phone, answer asks from anywhere).

## Machine-local cleanup owed (Ian's old Mac)

`/etc/hosts` has a pin `168.220.81.240 claudeshare.fly.dev` (ISP DNS had cached an
NXDOMAIN) — remove once DNS resolves naturally. New machines don't need it unless
they hit the same stale resolver.
