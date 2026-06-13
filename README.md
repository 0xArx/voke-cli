# voke CLI

Send real, full-screen voice alarms to your iPhone from the terminal — or let
your **AI agent** do it, with an AI-generated voice. Powered by the
[Voke](https://voke-0xarx.vercel.app) iOS app.

> This is the **public, open-source CLI** for Voke. The iOS app is a separate
> project. Nothing here contains private keys — the only embedded credential is
> Voke's public anon key, which is safe to ship and is gated by row-level
> security on the server.

```bash
voke link                       # pair this machine with your phone (recommended)
voke alarm --at 07:30 --say "Wake up, interview today!" --title "Interview"
voke alarm --in 25m --voice ./note.mp3
voke alarm --now --say "Stand up and stretch."
voke alarm --at 06:00 --to @friend --say "We leave at seven."
voke list
```

## Install

No published npm package yet — install straight from this repo:

```bash
git clone https://github.com/0xArx/voke-cli && cd voke-cli
npm link        # puts `voke` on your PATH (or just run: node voke.js …)
```

Zero dependencies. Works on any Node (built-in `fetch` fallback for Node < 18).

## Connect (no password needed)

```bash
voke link --name "My laptop"    # prints a code; approve it in the Voke app
```

Open **Voke → Settings → AI Agents → Link an agent**, enter the code, tap
Approve. The CLI receives a **scoped, revocable token** stored in `~/.voke.json`
— it can only set alarms and never sees your password. Revoke it any time from
the app. (`voke login` with email/password also works and grants full access.)

## Friends

```bash
voke add @username            # send a friend request (or: --email you@x.com)
voke accept @username         # accept an incoming request
voke friends                  # list friends + pending (both directions)
```

`voke add` auto-accepts if that person already requested you. Once you're
friends, either side can `voke alarm --to @them …` (the recipient can turn this
off per-friend in the app).

## AI voice (TTS)

`--say "text"` speaks via ElevenLabs. Set `ELEVENLABS_API_KEY` in your
environment (optionally `VOKE_TTS_VOICE_ID`, default is Rachel). Or bring any
audio with `--voice file.mp3` (mp3 / m4a / wav, **max 30 seconds**), or omit
voice for the default alarm tone.

## For AI agents

The agent **skill ships with this CLI** — one command installs it into your
agent so it knows how to set alarms:

```bash
voke skill install     # → ~/.claude/skills/voke-alarms/SKILL.md (Claude Code)
                       #   or: voke skill install --dir <your agent's skills dir>
voke skill             # or just print it to pipe anywhere
```

The skill ([`skill/voke-skill.md`](skill/voke-skill.md)) documents every command
plus the REST API, so the agent can set alarms on the user's behalf. Agents can
also skip the CLI entirely and call `POST /functions/v1/agent-api` directly —
see the skill file.

## Delivery semantics

- App open / backgrounded → schedules instantly (rings at the set time).
- App closed → schedules at the next iOS background refresh or app open;
  reliable for alarms hours away, not for `--now` to a closed phone.
- Sending to a friend requires they enabled **"Can send me alarms"** for you.

## Safety & limits

Server-enforced, per user (across all of a user's linked agents): max 20 new
alarms/hour, 50 scheduled outstanding, 10 per recipient; duplicate alarms (same
recipient + time) are edited in place rather than piled up. Agents can be
revoked instantly from the app.

## License

MIT — see [LICENSE](LICENSE).
