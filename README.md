# ✦ claudecollab

**Use Claude Code with your friends.** You run one command. Your friends open a link and can collaborate with the same Claude as you.

```
   You                 a helper server            Your friends
(you run Claude)  <-->  (passes messages)   <-->  (open a link)
```

Before you go live, your terminal is *exactly* normal Claude — nothing added. The moment you go live, one status line shows up at the bottom, and all the sharing itself happens in the web browser.

## Start a session

```bash
npx @claudecollab/cli        # one-time setup (~20s): adds /collab to Claude Code
```

That's the whole install. It shows a short setup screen, then from that day on you
just use `claude` like you always have — type `/collab` whenever you want company.

Want it to start faster? Install the engine globally (optional):

```bash
npm install -g @claudecollab/cli
```

Without this, `claude` still works — it just takes a few extra seconds to start
while npx fetches the engine each time.

Run `collab` instead of `claude`. It looks and works **exactly** like Claude — because at this point it *is* just Claude. It is not sharing anything yet. You go live only when you decide to.

## The first time you run it

The very first time you run `collab`, you'll see a quick one-screen setup. You only see it once. It does two things for you:

1. Adds the `/collab` command to Claude Code — this is the whole point; it's how you go live.
2. Makes your normal `claude` command shareable too, so you can just keep typing `claude` and still get `/collab`.

It also asks one optional thing: do you want `/collab @name` to deliver your join link through **Slack**, **Gmail**, or **Discord**? Pick any, or none. You turn these on in your Claude account (at `claude.ai/customize/connectors`) — the screen tells you how, and you can change your mind anytime.

Then it starts Claude like normal.

Changed your mind, or want to run it again?

- `collab setup` — show the setup screen again.
- `collab setup --undo` — put your normal `claude` back (removes the shim and the plugin).
- `collab --yes` — skip the setup screen this time (or set `CLAUDE_SHARE_SKIP_SETUP=1`).

## Go live with `/collab`

The first-run setup already added `/collab` for you. (Skipped it? Add it by hand:)

```
/plugin marketplace add ir272/claudecollab
/plugin install collab@claudecollab
```

Whenever you want people to join, just type this inside your session:

```
/collab
```

Claude opens a room and hands you the invite link to share. A few handy shortcuts:

- `/collab @sam` — go live *and* DM the link to Sam (if you have a messaging tool like Slack connected).
- `/collab viewer` or `/collab max 3` or `/collab password hunter2` — set the guest role, a size limit, or a join password.
- `/collab off` — stop sharing. The room closes and the link dies.
- `/collab status` — check whether you're live and see the link again.

Prefer to be live the second you start (no plugin needed)? Run `collab --live` and it makes the room right away. `collab off` stops it.

### The two links

Once you're live you get two links — **don't mix them up**:

- A **private link** — your control panel (you let people in and manage them). Stays on your own screen.
- A **share link** — this is the one you send. `/collab` prints it and the Invite button copies it.

Your friends just open the share link in a browser. They don't install anything.

## Works on

macOS and Linux (Windows counts too, if you use WSL). Native Windows isn't tested yet — if you try it, please open an issue and tell us how it went.

You need Node 22 or newer. If you installed Claude Code with its native installer (not npm), you might not have Node yet — install it first.

## Two links — don't mix them up

| Link | Who it's for |
|---|---|
| the one ending in `?host=…` | **Just you.** Opening it makes you the boss of the room. |
| the plain one | **Share this.** Friends use it to ask to join. |

The Invite button adds the plain one to your clipboard.

Want an extra guardrail? Start with `collab --room-password <pw>`. Then friends have to type the password before they can even ask to join. You still choose who gets admitted.

## Roles

| Role | Can watch | Can type | Can run the room |
|---|---|---|---|
| 👁 viewer | yes | no | no |
| ✎ prompter *(normal)* | yes | yes | no |
| ★ host *(you)* | yes | yes | yes |

"Run the room" means let people in, remove them, pause, or end it.

## How it works

- Everyone who can type gets their own little box at the bottom to write in. Type there and press Enter to send. Your box stays open, so you can keep going. If Claude is busy, your message will get queued.
- Want to write a message *together* with someone? Click **+ draft** to open a shared box you both type in.
- You can **paste or drag an image** into a box (or onto the terminal). It shows up as `[image]`; when you send, Claude sees it.
- To talk to Claude directly (to approve y/n questions, answer questions, etc) click Claude's CLI text line.
- Everyone sees the same screen, and scrolling is shared.

## Important note

When a friend types something, **it runs on your computer, as if you typed it.** So only let in people you trust. You can hit **Pause** anytime, or **End** to close the room.

## Run your own server (optional)

By default, `collab` uses our free server at claudecollab.org. Want to run your own instead? The same install includes it:

```bash
collab relay                              # start your own server
collab --relay ssh://127.0.0.1:2222       # use it
```

To put your server online for good (on Fly.io or any host — see `fly.toml`):

```bash
fly launch --no-deploy
fly secrets set HOST_KEY="$(collab relay --make-key)"
fly secrets set ROOM_SECRET="$(openssl rand -hex 16)"   # optional lock (see below)
fly deploy
```

Two safety features come built in:

- **Room password** (`ROOM_SECRET`) — if you set this, only people who know it can *start* rooms on your server. People *joining* a room don't need it.
- **Server ID check** the first time you connect, the app remembers your server's ID. If it ever changes, it stops and warns you, so nobody can pretend to be your server.

## All the options

| Option | What it does |
|---|---|
| `--relay <url>` | which server to use; defaults to ours |
| `--live` | go live at startup instead of waiting for `/collab` |
| `--no-relay` | go solo — just Claude, no room, no sharing (and no `/collab`) |
| `--room-password <pw>` | friends must type this before they can ask to join |
| `--guests <role>` | what new people can do when let in (default: prompter) |
| `--secret <s>` | the password for a locked server (or use `CLAUDE_SHARE_SECRET`) |
| `--fingerprint <fp>` | lock onto a specific server's ID |
| `--cmd <program>` | run something other than `claude` |
| `--yes` | skip the first-run setup screen |
| `-- <args…>` | anything after `--` is passed to the program you're running |

<details>
<summary>How it's built</summary>

Three parts, plain JavaScript, no build step:

```
packages/shared/   the messages the app and server send each other
packages/relay/    the server (one door for terminals, one for browsers)
packages/cli/      the main program you run — the brain
```

</details>

## Support this project

It's free and open source, and the community server costs a little to keep running. If it saved you some time, please consider chipping in — every bit helps keep it open ♥

**[github.com/sponsors/ir272](https://github.com/sponsors/ir272)**

## License

[MIT](LICENSE) — free to use and change. This is an independent project, not made or approved by Anthropic.

Contributions are welcome! Please open a PR and add @ir272 as a reviewer.