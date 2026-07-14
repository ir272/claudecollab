---
description: Go live and share this Claude Code session, or stop or check sharing. Optionally DM the invite to a teammate.
argument-hint: "[@name] [viewer|prompter] [max N] [password <pw>]"
allowed-tools: Bash
disable-model-invocation: true
---

You are running INSIDE a Claude Code session that may be wrapped by `collab`. Your job is to share this exact session using the `collab` control commands.

## Step 1: confirm this session can be shared

Check the environment variable `CLAUDE_SHARE_CTL`. If it is NOT set, this session was not started with `collab`, so it cannot be shared. Tell the user: "This session is not running under collab. Quit and reopen it shareable with: collab -- --resume", then stop here.

## Step 2: read the arguments

Parse `$ARGUMENTS`:

| In the arguments | Meaning |
|---|---|
| a word starting with `@` (like `@sam`) | the teammate to DM the invite to |
| `viewer` or `prompter` | the role new guests get, maps to `--guests <role>` |
| `max N` (a number) | the guest limit, maps to `--max-guests N` |
| `password X` | a join password, maps to `--room-password X` |
| `off` | stop sharing (see Step 5) |
| `status` | report the sharing state (see Step 5) |

## Step 3: go live

Run `collab go` with the mapped flags using Bash. Example: `collab go --guests prompter --max-guests 3`. It prints the room name and the invite link. Quote the invite link back to the user.

## Step 4: DM the invite (only if an @name was given)

If the user named a teammate with `@name`, look through the messaging tools available in this session (for example Slack, Gmail, or any connector the user has). Pick one and send the message "Join my collab! <invite link>" to that person, then confirm delivery. If no messaging connector is available, say so and show the invite link instead.

## Step 5: off and status

If `$ARGUMENTS` is `off`, run `collab off` and tell the user sharing stopped. If it is `status`, run `collab status` and report whether the session is live and its invite link.

## The one hard rule

Only ever share the invite link that `collab go` prints. Never share anything containing `host=`: that is the host's own control link, and opening it hands control of the session to whoever has it.
