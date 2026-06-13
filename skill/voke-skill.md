---
name: voke-alarms
description: >
  Send real, full-screen voice alarms to the user's iPhone via the Voke app —
  at a clock time, after a delay, or right now — to the user themselves or to
  one of their Voke friends, optionally speaking a message with AI TTS
  (ElevenLabs). Use when the user asks to be woken, reminded out loud, nudged,
  or wants an alarm/reminder "on my phone" or sent to a friend.
---

# Voke — set real voice alarms on the user's iPhone

Voke is an iOS alarm app where alarms are **spoken voice messages** that ring
full-screen at system alarm volume — they break through silent mode and Focus,
unlike notifications. This skill lets you, the agent, create those alarms from
the command line: for the user themselves, or for the user's friends.

An alarm = **a voice (or default tone) + a time + a recipient**. You set it; it
lands in the recipient's Voke account; their iPhone schedules it into Apple
AlarmKit and it rings at the set time.

---

## TL;DR

```bash
voke whoami                                              # am I linked? as whom?
voke alarm --in 25m --title "Tea" --say "Your tea is ready."   # self, AI voice
voke alarm --at 07:00 --to @sara --say "Wake up, gym at 7:30!" # to a friend
voke list                                                # what's scheduled
```

If `voke whoami` errors, you are not linked yet — see **Getting access** below.
If `voke` isn't on PATH, run `node <repo>/cli/voke.js …` instead of `voke`.

---

## Getting access (one-time)

The user must have the **Voke iOS app installed and signed in** — that phone is
where alarms ring. Then this machine needs to be authorized. Two ways:

### A. Pairing (recommended for agents) — `voke link`

```bash
voke link --name "Claude (work laptop)"   # prints a code like CB6E-NEGB and waits
```

**Name yourself with `--name`** so the user recognizes you in their list — that
name appears in **Voke → Settings → AI Agents**. Without it, the default is
`CLI on <hostname>`.

Ask the user to open **Voke → Settings → AI Agents → Link an agent**, enter the
code, and tap Approve. The CLI then stores a scoped `vk_…` **agent token** in
`~/.voke.json`.

- **You never see their password.**
- The token lets you act on the user's behalf for everything **except deleting
  their account**: set alarms, manage the sound library (favorite/rename/save/
  delete), manage friends (add/accept/remove/consent), and Voke a friend's phone.
  Friend-graph and send-to-friend actions need the friends scope the user toggled
  on while approving. It can't delete the account (do that in-app).
- The user can **revoke it any time** from that same screen — the next call
  then fails with 401 and you should stop and tell them.

### B. Full login — `voke login`

```bash
voke login           # prompts for the user's email + password
```

Grants a full user session (also in `~/.voke.json`). Only use this if the user
explicitly wants it; it can do everything the app can (including manage
friends). Prefer pairing.

---

## What each mode can do

The CLI auto-detects which credential is present and routes accordingly.

| Capability | Paired agent (`vk_` token) | Full login (session) |
|---|:--:|:--:|
| `voke alarm` to **self** | ✅ | ✅ |
| `voke alarm --to @friend` | ✅ *(if friends-scope granted)* | ✅ |
| attach AI voice / audio file | ✅ | ✅ |
| `voke list` | ✅ | ✅ |
| `voke whoami` | ✅ | ✅ |
| `voke voices` (list saved + received) | ✅ | ✅ |
| reuse a saved sound (`--use`) | ✅ | ✅ |
| favorite / rename / save / delete sounds | ✅ | ✅ |
| `voke cancel <id>` (delete an alarm) | ✅ | ✅ |
| `voke add` / `accept` / `remove` / `friends` | ✅ *(needs friends scope)* | ✅ |
| `voke consent` / `voke ring` | ✅ *(needs friends scope)* | ✅ |
| delete the **account** | ❌ *(never — user does it in-app)* | n/a |

An agent acts on the user's behalf, so a paired token can do **everything the
user can except delete their account** — set alarms, manage the sound library,
manage friends, and Voke a friend's phone. Friend-graph and send-to-friend
actions need the **friends scope** the user toggled on when linking; if it's off,
those calls return 403 — ask the user to re-link with it enabled. Account
deletion is never available to a token; the user must do it in the app.

---

## Setting alarms — full reference

```bash
voke alarm [timing] [voice] [--title "Label"] [--to @username] [--daily]
```

**Timing (pick exactly one):**

```bash
--at 07:30      # a 24-hour clock time today; if already past, rolls to tomorrow
--in 25m        # a delay: 90s / 25m / 2h  (s, m, h)
--now           # ring as soon as the phone next syncs
```

**Voice (pick at most one; omit for the default alarm tone):**

```bash
--say "text"            # speak this via ElevenLabs TTS (needs ELEVENLABS_API_KEY)
--voice ./clip.mp3      # use an existing audio file (mp3 / m4a / wav)
--use "Wake up"         # reuse a sound the user already saved (title or id; see `voke voices`)
```

Prefer `--use` when the user refers to a sound they already have ("use my usual
wake-up voice", "my favorite one") — it reuses the saved clip with no re-upload
or TTS cost. Run `voke voices` first to see titles and which are favorited (★).

**Other flags:**

```bash
--title "Interview"     # names BOTH the alarm and its voice note in the app.
                        # ALWAYS set a clear one. If omitted, the title is
                        # derived from --say (first sentence), the file name,
                        # or falls back to "Reminder".
--to @username          # send to a friend instead of yourself (consent required)
--daily                 # repeat every day at that time
```

**Examples (all verified working end-to-end):**

```bash
# Morning wake-up for the user, spoken, repeating daily:
voke alarm --at 06:30 --daily --title "Wake up" \
  --say "Good morning. It's 6:30 — time to get up for the gym."

# A timed reminder in two hours:
voke alarm --in 2h --title "Leave for airport" \
  --say "Head out now — your flight check-in closes in an hour."

# Nudge a friend (must be an accepted friend who allows your alarms):
voke alarm --at 09:00 --to @sara --title "Standup" \
  --say "Standup in five minutes!"

# Default tone, no voice:
voke alarm --in 10m --title "Pizza"

# Your own pre-recorded clip:
voke alarm --in 45m --voice ./reminder.m4a --title "Call Mom"
```

---

## Saved sounds (the voice library)

Users build up a library of sounds — recorded, imported, AI-generated, or saved
from friends — and can favorite and name them. You can list and reuse them:

```bash
voke voices                       # list saved sounds (★ = favorite) + ones friends sent
voke alarm --in 1h --use "Gym"    # reuse a saved sound by title (or id) — no re-upload
```

`voke voices` lists the user's own sounds (favorites first) and, separately,
voices friends have sent them. **Reuse beats re-generating:** if the user has a
sound that fits ("my favorite wake-up"), `--use` it instead of `--say`.

You act on the user's behalf, so you can manage the library in **either** mode
(paired agent token or full login):

```bash
voke voices fav "Gym"             # favorite (pins it; rings first in pickers)
voke voices unfav "Gym"           # remove from favorites
voke voices rename "note 3" "Fajr adhan"
voke voices save "Rise and shine" # copy a friend's voice into your own library
```

Ownership is enforced server-side: you can only favorite/rename/delete sounds the
user **owns**, and only `save` voices that were actually **sent to** them
(otherwise the call returns 404). Delete a sound with `voke voices delete
"<title>"`. The one thing no token can do is delete the user's **account**.

---

## Friends, consent, and ringing a phone

Works in **both** modes (a paired token needs the friends scope):

```bash
voke add @username        # send a friend request   (or: voke add --email you@x.com)
voke accept @username     # accept an incoming request
voke remove @username     # unfriend (removes both directions)
voke friends              # list friends + pending (incoming and sent)
voke consent @username --alarms on|off --phone on|off   # who may reach the user
voke ring @username       # ring a friend's phone aloud ("Voke my phone")
```

How it works: `voke add` sends a request; the other person `voke accept`s (or
accepts in the app). After that, **either** side can send the other alarms.
`voke add` auto-accepts if that person had already requested the user. Consent is
per-friend: `voke consent @x --alarms off` stops @x sending the user alarms;
`--phone on` lets @x Voke the user's phone. If you `--to` (or `ring`) someone who
hasn't allowed it, the call fails — report it, don't retry.

---

## Inspecting

```bash
voke list      # recent alarms (status, time, title) — for self and received
```

Check `voke list` before creating something that may already exist. Don't spam:
one alarm per actual need.

---

## Rules — follow these

- **Voice ≤ 30 seconds** (~70 words for `--say`). The clip loops while ringing;
  longer audio is rejected.
- **Write `--say` as natural speech** and **include the reason** — that's the
  whole point. "Wake up, your interview starts in 30 minutes" >> "Alarm".
- **Always pass `--title`** (a few words; it's what the user sees in the app).
- **Be honest about delivery** (see below) — don't promise a `--now` alarm will
  ring instantly if their app is closed.
- **Don't retry consent failures.** A `--to` friend who hasn't allowed alarms
  produces a clear error; surface it.
- **Guardrails are enforced server-side — don't fight them:**
  - **No duplicates.** Setting an alarm for the same recipient at the same time
    (within a minute) **edits the existing one** instead of creating a second
    (response has `"updated": true`). To change an alarm, just set it again with
    the new title/voice/time — don't create a near-identical one.
  - **Rate limits (per user, not per agent).** Across *all* of a user's linked
    agents combined: at most **20 new alarms per hour**, **50 scheduled**
    outstanding, and **10 scheduled to any one recipient**. Linking more agents
    does **not** raise the budget. Exceeding any returns **429** — back off,
    don't loop-retry. Editing an existing alarm is always allowed, even at the cap.

---

## Delivery semantics (be honest with the user)

The alarm always lands in the recipient's Voke account immediately. *When it
rings* depends on the recipient's phone:

| Recipient's phone | When it schedules to ring |
|---|---|
| Voke open or backgrounded | instantly (live sync) |
| Voke closed | next iOS background refresh, or next app open — **reliable for alarms hours away** |
| Voke force-quit | next time they open the app |

So for wake-ups and reminders **hours ahead**, delivery is reliable. For `--now`
or lead times under ~15 minutes to a phone that isn't open, tell the user it
"rings when their phone next syncs."

---

## TTS voice

- `--say` uses ElevenLabs; set `ELEVENLABS_API_KEY` in the environment.
  Default voice is "Rachel" — override with `VOKE_TTS_VOICE_ID=<id>`.
- No key? Use `--voice file.mp3` (synthesize with any provider yourself first),
  or omit voice for the default tone.

---

## Agent API (REST — no CLI install needed)

With a `vk_` agent token you can hit the endpoint directly (same thing the CLI
does). Useful from languages/environments without the CLI.

```
POST https://lgmgsaoaqqzuhxqoqsrc.supabase.co/functions/v1/agent-api
Content-Type: application/json
```

```jsonc
{ "token": "vk_…", "action": "whoami" }
{ "token": "vk_…", "action": "list" }
{ "token": "vk_…", "action": "voices" }   // → { voices:[{id,title,duration,is_favorite}], received:[{id,title,duration}] }
{ "token": "vk_…", "action": "favorite", "voice_id": "<uuid>", "favorite": true }
{ "token": "vk_…", "action": "rename",   "voice_id": "<uuid>", "title": "Fajr adhan" }
{ "token": "vk_…", "action": "save_voice", "voice_id": "<received uuid>" }   // save a friend's voice
{ "token": "vk_…", "action": "delete_voice", "voice_id": "<uuid>" }
{ "token": "vk_…", "action": "delete_alarm", "alarm_id": "<uuid>" }   // ids come from "list"
{ "token": "vk_…", "action": "friends" }
{ "token": "vk_…", "action": "add_friend",    "username": "sara" }   // or accept_friend / remove_friend
{ "token": "vk_…", "action": "set_consent",   "username": "sara", "can_send_alarms": true, "can_voke_phone": false }
{ "token": "vk_…", "action": "voke_phone",    "username": "sara" }
{ "token": "vk_…", "action": "alarm",
  "title": "Interview",
  "at": "2026-06-13T07:30:00Z",      // OR "in_seconds": 1500  OR "right_now": true
  "repeat": "once",                   // or "daily"
  "to_username": "sara",              // optional — needs the friends scope
  "voice_id": "<uuid>",               // reuse a saved sound from "voices"…
  "voice_b64": "<base64 audio>",      // …OR attach a new clip ≤ 30s
  "voice_format": "mp3"               // mp3 | m4a | wav (with voice_b64)
}
```

Pass an owned `id` back as `voice_id` to ring the user with a saved sound, or to
`favorite`/`rename` it; pass a `received` id to `save_voice`. Ownership is
enforced — favorite/rename require a voice the user owns, save_voice a voice
actually sent to them; otherwise **404**.

Responses are JSON. Errors: **401** invalid/revoked token · **403** friends
scope not granted · **400** consent missing or bad input · **429** rate limit
(per user, across all their agents: 20 new/hour, 50 scheduled, 10 per recipient
— back off, don't retry).
A repeat alarm to the same recipient at the same time returns
`{ "ok": true, "updated": true }` — it edited the existing one instead of duplicating.

---

## REST fallback (password sessions only — avoid if a `vk_` token exists)

Voke's backend is Supabase; the anon key is public and every request is gated by
Row Level Security. Full reference: `website/api.html` in the repo. Summary:

```
BASE    https://lgmgsaoaqqzuhxqoqsrc.supabase.co
APIKEY  header: apikey: <anon key from website/api.html>
AUTH    header: Authorization: Bearer <user access_token>

1) POST /auth/v1/token?grant_type=password   {email,password} -> access_token
2) POST /storage/v1/object/voice-notes/{uid}/{uuid}.mp3   (raw audio bytes)
3) POST /rest/v1/voice_notes   {id, owner_id, title, storage_path, duration}
4) POST /rest/v1/alarms        {owner_id, recipient_id, voice_note_id, title,
                                scheduled_time (ISO-8601), is_right_now,
                                repeat_type:"once"|"daily", type:"sent",
                                status:"scheduled"}
```

Self-alarm → `recipient_id = owner_id` (the JWT `sub`). **Lowercase the UUIDs**
in the storage path. To find a friend's id by handle:
`GET /rest/v1/users?username=eq.<name>&select=id` (emails aren't queryable;
use the `find_user_by_email` RPC for that).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `voke whoami` errors / `not logged in` | Not linked. Run `voke link` (or `voke login`) and have the user approve. |
| `agent access is paused…` (401) | The user paused or revoked this agent (Voke → Settings → AI Agents). Stop; ask them to **resume** it there — a paused agent re-enables instantly, no re-linking. Run `voke link` again only if it was deleted. |
| `--say needs ELEVENLABS_API_KEY` | Export the key, or use `--voice file.mp3`, or omit voice. |
| `that friend hasn't allowed you to send them alarms` | Recipient must accept the user as a friend and keep "Can send me alarms" on. Don't retry. |
| `no Voke user @name found` | Wrong handle. Confirm with the user; usernames are case-insensitive, no `@` stored. |
| Friend/`ring` call returns **403** | The token lacks the friends scope. Ask the user to re-link the agent with "can send to friends" enabled (Voke → Settings → AI Agents). |
| Asked to delete the user's account | Not possible via a token by design. Tell the user to do it in Voke → Settings → Delete Account. |
| Alarm in `voke list` but it didn't ring | Phone hadn't synced before the fire time (app closed + short lead). Use longer lead times or ask the user to open Voke. |
| `alarm failed (401)` in login mode | Session expired and refresh failed → `voke login` again. |
