---
name: collab-invite
description: Share, send, or stop a live collab session from inside it. Use when the user says "send my collab invite", "DM my collab link", "who is in my collab", "am I sharing", or "stop sharing".
---

# collab-invite

This session may be wrapped by `collab`, which makes a Claude Code session shareable over a link. This skill tells you how to read the sharing state and act on it.

## How to tell whether sharing is on

Two environment variables describe the session:

| Variable | Meaning |
|---|---|
| `CLAUDE_SHARE_CTL` | Set when the session is wrapped by collab. If it is absent, this session cannot be shared at all. |
| `CLAUDE_SHARE_ROOM_FILE` | Path to a JSON file that EXISTS only while a room is live. Its fields are `room`, `inviteUrl`, and `webUrl`. If the file is missing, sharing is off right now. |

To read the live invite, read the file at `CLAUDE_SHARE_ROOM_FILE` and use its `inviteUrl`. Running `collab status` gives the same answer as text.

## The control commands

Run these with Bash. Each prints human-readable lines you can quote to the user.

| Command | Effect |
|---|---|
| `collab go` | Start sharing. Prints the room name and the invite link. Also accepts `--guests` (viewer or prompter), `--max-guests N`, and `--room-password X`. |
| `collab off` | Stop sharing. The room closes and the link dies. |
| `collab status` | Report whether the session is live and show the invite link. |

## Sending the invite

When the user asks you to send or DM the invite, first make sure sharing is on (run `collab go` if it is not), then look for a messaging tool available in this session (Slack, Gmail, or another connector) and send "Join my collab! <invite link>" to the person they named. If no connector is available, show them the link instead.

## The one hard rule

The invite link is the ONLY thing that is safe to share. Never send, quote, or paste anything containing `host=`. That is the host's private control link, and opening it hands full control of the session to whoever has it. The `inviteUrl` from the room file and the link that `collab go` prints are always safe.
