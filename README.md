# ✦ claudecollab

**Use Claude Code with your friends.** You run one command. Your friends open a link and can collaborate with the same Claude as you.

```
   You                 a helper server            Your friends
(you run Claude)  <-->  (passes messages)   <-->  (open a link)
```

Your terminal looks like normal Claude, just one extra line at the bottom. All the sharing happens in the web browser.

## Start a session

```bash
npm install -g @claudecollab/cli
collab
```

That's it. Run `collab` instead of `claude`. It works the same, but now it makes two links:

- A **private link** — that's your control panel (you let people in and manage them).
- A **share link** — this one gets copied for you. Send it to your friends.

Your friends just open the share link in a browser. They don't install anything.

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
- To talk to Claude directly (to approve y/n questions, answer questions, etc) click Claude's CLI text line.
- Everyone sees the same screen, and scrolling is shared.

## Important note

When a friend types something, **it runs on your computer, as if you typed it.** So only let in people you trust. You can hit **Pause** anytime, or **End** to close the room.

## Run your own server (optional)

By default, `collab` uses our free server at claudecollab.org. Want to run your own instead? The same install includes it:

```bash
collab-relay                              # start your own server
collab --relay ssh://127.0.0.1:2222       # use it
```

To put your server online for good (on Fly.io or any host — see `fly.toml`):

```bash
fly launch --no-deploy
fly secrets set HOST_KEY="$(collab-relay --make-key)"
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
| `--no-relay` | go solo — just Claude, no room, no sharing |
| `--room-password <pw>` | friends must type this before they can ask to join |
| `--guests <role>` | what new people can do when let in (default: prompter) |
| `--secret <s>` | the password for a locked server (or use `CLAUDE_SHARE_SECRET`) |
| `--fingerprint <fp>` | lock onto a specific server's ID |
| `--cmd <program>` | run something other than `claude` |
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

## License

[MIT](LICENSE) — free to use and change. This is an independent project, not made or approved by Anthropic.

Contributions are welcome! Please open a PR and add @ir272 as a reviewer.