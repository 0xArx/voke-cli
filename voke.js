#!/usr/bin/env node
/**
 * voke — CLI for the Voke voice-alarm app.
 *
 * Sign in once (like `vercel login`), then you — or your AI agent — can send
 * real alarms to your iPhone, optionally with an AI-generated voice (TTS).
 *
 *   voke signup                          create an account
 *   voke login                           sign in (stores token in ~/.voke.json)
 *   voke logout / voke whoami
 *   voke alarm --at 07:30 --say "Wake up, interview today!" --title "Interview"
 *   voke alarm --in 25m --voice ./note.mp3
 *   voke alarm --now --say "Stand up and stretch."
 *   voke alarm --at 06:00 --to @username --say "Fajr time."   (friends only)
 *   voke list                            recent alarms
 *
 * TTS: set ELEVENLABS_API_KEY (optional VOKE_TTS_VOICE_ID). Without a key,
 * --say is unavailable; --voice <file> and silent (default-tone) alarms work.
 *
 * Zero dependencies. Node >= 18.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");

const SUPABASE_URL = "https://lgmgsaoaqqzuhxqoqsrc.supabase.co";
// The anon key is public by design (same one shipped inside the iOS app);
// all access is enforced by Row Level Security on the server.
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxnbWdzYW9hcXF6dWh4cW9xc3JjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5ODIzODcsImV4cCI6MjA5NjU1ODM4N30.YYl0gtzYsq80QWO1Wo2zTiXno-8UhziEmRbfXoAZ6iM";

const CRED_FILE = path.join(os.homedir(), ".voke.json");
const MAX_SECONDS = 30; // alarm voices are capped at 30s (AlarmKit limit)

// fetch fallback for Node < 18 (keeps the CLI zero-dependency everywhere)
if (typeof fetch === "undefined") {
  const https = require("node:https");
  globalThis.fetch = (url, { method = "GET", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => buf.toString("utf8"),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          });
        });
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
}

// ---------------------------------------------------------------- utilities

function die(msg) {
  console.error(`voke: ${msg}`);
  process.exit(1);
}

function readCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")); } catch { return null; }
}
function writeCreds(c) {
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Hide input only on a real terminal; piped/scripted input reads plainly.
    if (!hidden || !process.stdin.isTTY) {
      return rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    let buf = "";
    const onData = (chunk) => {
      for (const c of chunk.toString()) {
        if (c === "\n" || c === "\r") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          return resolve(buf);
        }
        if (c === "\u0003") process.exit(1); // ctrl-c
        else if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function api(method, p, { token, body, raw, contentType, prefer } = {}) {
  const headers = { apikey: ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  let payload;
  if (raw) { headers["Content-Type"] = contentType || "application/octet-stream"; payload = raw; }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${SUPABASE_URL}${p}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

/** Returns a valid access token, refreshing (and persisting) if needed. */
async function session() {
  const creds = readCreds();
  if (!creds?.access_token) die("not connected — run `voke link` to pair this machine (or `voke login` for full access)");
  // quick validity probe
  const me = await api("GET", "/auth/v1/user", { token: creds.access_token });
  if (me.status === 200) return { token: creds.access_token, user: me.json };
  // refresh
  const r = await api("POST", "/auth/v1/token?grant_type=refresh_token", {
    body: { refresh_token: creds.refresh_token },
  });
  if (r.status !== 200) die("session expired — run `voke login` again");
  writeCreds({ email: creds.email, access_token: r.json.access_token, refresh_token: r.json.refresh_token });
  return { token: r.json.access_token, user: r.json.user };
}

// ------------------------------------------------------------ time parsing

function parseWhen(flags) {
  if (flags.now) return { rightNow: true, date: new Date(Date.now() + 5000) };
  if (flags.in) {
    const m = /^(\d+)\s*(m|min|minutes?|h|hours?|s|secs?|seconds?)$/i.exec(flags.in.trim());
    if (!m) die(`can't parse --in "${flags.in}" (try 10m, 2h, 90s)`);
    const n = parseInt(m[1], 10);
    const unit = m[2][0].toLowerCase();
    const ms = unit === "h" ? n * 3600e3 : unit === "m" ? n * 60e3 : n * 1e3;
    return { rightNow: false, date: new Date(Date.now() + ms) };
  }
  if (flags.at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(flags.at.trim());
    if (!m) die(`can't parse --at "${flags.at}" (use 24h HH:MM, e.g. 07:30)`);
    const d = new Date();
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1); // roll to tomorrow
    return { rightNow: false, date: d };
  }
  die("when should it ring? use --at HH:MM, --in 10m, or --now");
}

// ----------------------------------------------------------- alarm naming

/** A clean, human title from spoken text: first sentence / ~8 words, no trailing punctuation. */
function titleFromSpeech(text) {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] || text;
  let t = firstSentence.trim().split(/\s+/).slice(0, 8).join(" ").replace(/[\s,;:!?.]+$/, "");
  if (t.length > 50) t = t.slice(0, 50).replace(/\s+\S*$/, "") + "…";
  return t || "Reminder";
}

/** Pick a proper alarm/voice title: explicit --title > derived from speech > file name > default. */
function deriveTitle(flags) {
  if (flags.title) return flags.title;
  if (flags.say) return titleFromSpeech(flags.say);
  if (flags.voice) return path.basename(flags.voice, path.extname(flags.voice));
  return "Reminder";
}

// -------------------------------------------------------------------- TTS

async function ttsToBuffer(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) die("--say needs ELEVENLABS_API_KEY in the environment (get one at elevenlabs.io)");
  if (text.length > 600) console.error("voke: warning — long text; alarm voices are capped at 30 seconds");
  const voiceID = process.env.VOKE_TTS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceID}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    }
  );
  if (!res.ok) die(`TTS failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------- voice upload

async function uploadVoice({ token, userID, bytes, ext, contentType, title }) {
  const id = crypto.randomUUID();
  const storagePath = `${userID.toLowerCase()}/${id.toLowerCase()}.${ext}`;
  const up = await api("POST", `/storage/v1/object/voice-notes/${storagePath}`, {
    token, raw: bytes, contentType,
  });
  if (up.status !== 200 && up.status !== 201) die(`voice upload failed (${up.status}): ${up.text.slice(0, 200)}`);
  const row = await api("POST", "/rest/v1/voice_notes", {
    token,
    body: { id, owner_id: userID, title: title || null, storage_path: storagePath, duration: 0 },
  });
  if (row.status !== 201) die(`voice record failed (${row.status}): ${row.text.slice(0, 200)}`);
  return id;
}

// ----------------------------------------------------------------- commands

// ------------------------------------------------- agent-token mode (vk_…)

/** Calls the deployed agent-api edge function with the stored vk_ token. */
async function agentCall(action, params = {}) {
  const creds = readCreds();
  const r = await api("POST", "/functions/v1/agent-api", {
    body: { token: creds.agent_token, action, ...params },
  });
  if (r.status === 401) die("agent token invalid or revoked — run `voke link` again");
  if (r.status >= 400) die(r.json?.error || `agent-api error (${r.status})`);
  return r.json;
}

/** Pair this machine with the user's Voke app — no password ever touches the agent. */
async function cmdLink(flags) {
  const name = flags.name || `CLI on ${os.hostname()}`;
  const start = await api("POST", "/rest/v1/rpc/link_request_create", { body: { p_name: name } });
  if (start.status !== 200) die(`couldn't start pairing: ${start.text.slice(0, 200)}`);
  const { id, code, poll_secret } = start.json;

  console.log("");
  console.log(`  Pairing code:   ${code}`);
  console.log("");
  console.log("  On your iPhone: Voke → Settings → AI Agents → Link an agent");
  console.log(`  Enter the code above to approve “${name}”.`);
  console.log("");
  process.stdout.write("  Waiting for approval");

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r2) => setTimeout(r2, 2500));
    process.stdout.write(".");
    const poll = await api("POST", "/rest/v1/rpc/link_request_claim", {
      body: { p_id: id, p_secret: poll_secret },
    });
    if (poll.status !== 200) continue;
    if (poll.json.status === "approved") {
      const prev = readCreds() || {};
      writeCreds({ ...prev, agent_token: poll.json.token, agent_name: name });
      console.log("\n\n  ✅ Linked! This machine can now set alarms on your phone.");
      console.log("     Try: voke alarm --in 10m --title \"It works\"");
      return;
    }
    if (poll.json.status === "expired") die("\npairing code expired — run `voke link` again");
  }
  die("\ntimed out waiting for approval — run `voke link` again");
}

async function cmdSignup(flags = {}) {
  const email = flags.email || (await ask("email: "));
  const password = flags.password || (await ask("password (min 6 chars): ", { hidden: true }));
  const r = await api("POST", "/auth/v1/signup", { body: { email, password } });
  if (r.status !== 200) die(`signup failed: ${r.text.slice(0, 200)}`);
  writeCreds({ email, access_token: r.json.access_token, refresh_token: r.json.refresh_token });
  console.log(`Welcome to Voke, ${email}. You're signed in on this machine.`);
  console.log("Sign into the iOS app with the same account to receive alarms.");
}

async function cmdLogin(flags) {
  const email = flags.email || (await ask("email: "));
  const password = flags.password || (await ask("password: ", { hidden: true }));
  const r = await api("POST", "/auth/v1/token?grant_type=password", { body: { email, password } });
  if (r.status !== 200) die(`login failed: ${r.json?.error_description || r.text.slice(0, 200)}`);
  writeCreds({ email, access_token: r.json.access_token, refresh_token: r.json.refresh_token });
  console.log(`Logged in as ${email} (credentials in ~/.voke.json)`);
}

function cmdLogout() {
  try { fs.unlinkSync(CRED_FILE); } catch {}
  console.log("Logged out.");
}

async function cmdWhoami() {
  const creds = readCreds();
  if (creds?.agent_token) {
    const me = await agentCall("whoami");
    console.log(`agent “${me.agent_name}” for @${me.username ?? "?"} (user ${me.user_id})`);
    console.log(`can send to friends: ${me.can_send_to_friends ? "yes" : "no"}`);
    return;
  }
  const { token, user } = await session();
  const prof = await api("POST", "/rest/v1/rpc/get_my_profile", { token, body: {} });
  const uname = prof.json?.[0]?.username;
  console.log(`${user.email}${uname ? `  @${uname}` : ""}  (id: ${user.id})`);
}

async function resolveRecipient(token, userID, handle) {
  return (await resolveUser(token, { handle })).id;
}

/** Resolve a Voke user by @username or by --email (privacy-safe RPC). */
async function resolveUser(token, { handle, email }) {
  if (email) {
    const r = await api("POST", "/rest/v1/rpc/find_user_by_email", { token, body: { q: email } });
    if (!r.json?.length) die(`no Voke user with email ${email}`);
    return r.json[0];
  }
  if (!handle) die("who? pass a @username or --email");
  const uname = String(handle).replace(/^@/, "").toLowerCase();
  const r = await api("GET", `/rest/v1/users?username=eq.${encodeURIComponent(uname)}&select=id,username,name`, { token });
  if (!r.json?.length) die(`no Voke user @${uname} found`);
  return r.json[0];
}

/** Map a list of user ids to {id: username}. */
async function usernamesFor(token, ids) {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return {};
  const r = await api("GET", `/rest/v1/users?id=in.(${uniq.join(",")})&select=id,username`, { token });
  const map = {};
  for (const u of r.json || []) map[u.id] = u.username;
  return map;
}

// ---------------------------------------------------------- friends (social)

/** Send a friend request (or auto-accept if they already requested you). */
async function cmdAdd(flags) {
  const { token, user } = await session();
  const target = await resolveUser(token, { handle: flags._[0] || flags.to, email: flags.email });
  if (target.id === user.id) die("you can't add yourself as a friend");

  // If they already sent ME a request, adding them = accepting it.
  const inc = await api(
    "GET",
    `/rest/v1/trusted_contacts?contact_user_id=eq.${user.id}&user_id=eq.${target.id}&status=eq.pending&select=id`,
    { token }
  );
  if (inc.json?.length) return acceptEdge(token, user.id, target, inc.json[0].id);

  const r = await api("POST", "/rest/v1/trusted_contacts?on_conflict=user_id,contact_user_id", {
    token, prefer: "resolution=merge-duplicates,return=minimal",
    body: { user_id: user.id, contact_user_id: target.id, status: "pending", can_send_alarms: true, can_voke_phone: false },
  });
  if (r.status >= 300) die(`couldn't send request (${r.status}): ${r.text.slice(0, 200)}`);
  console.log(`Friend request sent to @${target.username}. They accept with: voke accept @<your handle>`);
}

/** Accept an incoming friend request. */
async function cmdAccept(flags) {
  const { token, user } = await session();
  const target = await resolveUser(token, { handle: flags._[0] || flags.to, email: flags.email });
  const inc = await api(
    "GET",
    `/rest/v1/trusted_contacts?contact_user_id=eq.${user.id}&user_id=eq.${target.id}&status=eq.pending&select=id`,
    { token }
  );
  if (!inc.json?.length) die(`no pending request from @${target.username}`);
  await acceptEdge(token, user.id, target, inc.json[0].id);
}

/** Accept their edge and create the reciprocal one (mirrors the app's accept). */
async function acceptEdge(token, myID, target, edgeID) {
  const up = await api("PATCH", `/rest/v1/trusted_contacts?id=eq.${edgeID}`, {
    token, prefer: "return=minimal", body: { status: "accepted" },
  });
  if (up.status >= 300) die(`accept failed (${up.status}): ${up.text.slice(0, 200)}`);
  const recip = await api("POST", "/rest/v1/trusted_contacts?on_conflict=user_id,contact_user_id", {
    token, prefer: "resolution=merge-duplicates,return=minimal",
    body: { user_id: myID, contact_user_id: target.id, status: "accepted", can_send_alarms: true, can_voke_phone: false },
  });
  if (recip.status >= 300) die(`reciprocal failed (${recip.status}): ${recip.text.slice(0, 200)}`);
  console.log(`You're now friends with @${target.username}. You can send each other alarms.`);
}

/** List accepted friends and pending requests (both directions). */
async function cmdFriends() {
  const { token, user } = await session();
  const accepted = await api("GET", `/rest/v1/trusted_contacts?user_id=eq.${user.id}&status=eq.accepted&select=contact_user_id`, { token });
  const incoming = await api("GET", `/rest/v1/trusted_contacts?contact_user_id=eq.${user.id}&status=eq.pending&select=user_id`, { token });
  const outgoing = await api("GET", `/rest/v1/trusted_contacts?user_id=eq.${user.id}&status=eq.pending&select=contact_user_id`, { token });

  const ids = [
    ...(accepted.json || []).map((r) => r.contact_user_id),
    ...(incoming.json || []).map((r) => r.user_id),
    ...(outgoing.json || []).map((r) => r.contact_user_id),
  ];
  const names = await usernamesFor(token, ids);
  const tag = (id) => `@${names[id] || id}`;

  const acc = accepted.json || [], inc = incoming.json || [], out = outgoing.json || [];
  if (!acc.length && !inc.length && !out.length) return console.log("no friends yet — add one with `voke add @username`");
  if (acc.length) { console.log("Friends:"); acc.forEach((r) => console.log(`  ${tag(r.contact_user_id)}`)); }
  if (inc.length) { console.log("Incoming requests (accept with `voke accept @name`):"); inc.forEach((r) => console.log(`  ${tag(r.user_id)}`)); }
  if (out.length) { console.log("Sent (waiting):"); out.forEach((r) => console.log(`  ${tag(r.contact_user_id)}`)); }
}

async function cmdAlarm(flags) {
  // Agent-token mode: everything goes through the scoped agent-api.
  const creds = readCreds();
  if (creds?.agent_token) {
    const when = parseWhen(flags);
    const params = {
      title: deriveTitle(flags),
      repeat: flags.daily ? "daily" : "once",
    };
    if (when.rightNow) params.right_now = true;
    else params.at = when.date.toISOString();
    if (flags.to) params.to_username = flags.to.replace(/^@/, "");
    if (flags.say) {
      process.stderr.write("voke: generating voice…\n");
      params.voice_b64 = (await ttsToBuffer(flags.say)).toString("base64");
      params.voice_format = "mp3";
    } else if (flags.voice) {
      if (!fs.existsSync(flags.voice)) die(`no such file: ${flags.voice}`);
      const ext = path.extname(flags.voice).slice(1).toLowerCase();
      if (!["mp3", "m4a", "wav"].includes(ext)) die(`unsupported format .${ext} (mp3/m4a/wav)`);
      params.voice_b64 = fs.readFileSync(flags.voice).toString("base64");
      params.voice_format = ext;
    }
    const res = await agentCall("alarm", params);
    const timing = when.rightNow ? "right now" : when.date.toLocaleString();
    console.log(`⏰ Alarm set for ${flags.to || "you"} — ${timing} (${res.voice})`);
    console.log("It rings when the iPhone next syncs (app open, background refresh, or next launch).");
    return;
  }

  const { token, user } = await session();
  const userID = user.id;
  const when = parseWhen(flags);

  // A proper title shared by the alarm and its voice note.
  const title = deriveTitle(flags);

  // Resolve the voice (TTS > file > none/default tone).
  let voiceNoteID = null;
  if (flags.say) {
    process.stderr.write("voke: generating voice…\n");
    const bytes = await ttsToBuffer(flags.say);
    voiceNoteID = await uploadVoice({
      token, userID, bytes, ext: "mp3", contentType: "audio/mpeg", title,
    });
  } else if (flags.voice) {
    const file = flags.voice;
    if (!fs.existsSync(file)) die(`no such file: ${file}`);
    const ext = path.extname(file).slice(1).toLowerCase() || "m4a";
    const types = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/mp4" };
    if (!types[ext]) die(`unsupported audio format .${ext} (use mp3, m4a, wav, or aac)`);
    voiceNoteID = await uploadVoice({
      token, userID, bytes: fs.readFileSync(file), ext, contentType: types[ext], title,
    });
  }

  const recipient = flags.to ? await resolveRecipient(token, userID, flags.to) : userID;

  const r = await api("POST", "/rest/v1/alarms", {
    token, prefer: "return=representation",
    body: {
      owner_id: userID,
      recipient_id: recipient,
      voice_note_id: voiceNoteID,
      title,
      scheduled_time: when.date.toISOString(),
      is_right_now: !!when.rightNow,
      repeat_type: flags.daily ? "daily" : "once",
      type: "sent",
      status: "scheduled",
    },
  });
  if (r.status !== 201) {
    const msg = r.text.includes("not allowed")
      ? `that friend hasn't allowed you to send them alarms`
      : r.text.slice(0, 300);
    die(`alarm failed (${r.status}): ${msg}`);
  }

  const target = flags.to ? flags.to : "you";
  const timing = when.rightNow ? "right now" : when.date.toLocaleString();
  console.log(`⏰ Alarm set for ${target} — ${timing}${voiceNoteID ? " (with voice)" : " (default tone)"}`);
  if (recipient === userID) {
    console.log("It rings when your iPhone next syncs (app open, background refresh, or next launch).");
  }
}

async function cmdList() {
  const creds = readCreds();
  if (creds?.agent_token) {
    const { alarms } = await agentCall("list");
    if (!alarms?.length) return console.log("no alarms yet");
    for (const a of alarms) {
      const t = a.is_right_now ? "right-now" : new Date(a.scheduled_time).toLocaleString();
      console.log(`${(a.status || "?").padEnd(10)} ${t.padEnd(22)} ${a.title || ""}`);
    }
    return;
  }
  const { token, user } = await session();
  const r = await api(
    "GET",
    `/rest/v1/alarms?or=(owner_id.eq.${user.id},recipient_id.eq.${user.id})&order=created_at.desc&limit=15&select=title,scheduled_time,status,type,is_right_now`,
    { token }
  );
  if (!r.json?.length) return console.log("no alarms yet");
  for (const a of r.json) {
    const t = a.is_right_now ? "right-now" : new Date(a.scheduled_time).toLocaleString();
    console.log(`${(a.status || "?").padEnd(10)} ${t.padEnd(22)} ${a.title || ""}`);
  }
}

// ------------------------------------------------------------------- skill

// The agent skill ships alongside the CLI in this repo.
const SKILL_FILE = path.join(__dirname, "skill", "voke-skill.md");

/**
 * `voke skill`          → print the skill markdown (pipe it anywhere).
 * `voke skill install`  → drop it into the agent's skills dir so it loads it.
 *                          Defaults to Claude Code (~/.claude/skills); override
 *                          the destination with --dir <path>.
 */
function cmdSkill(flags) {
  let md;
  try { md = fs.readFileSync(SKILL_FILE, "utf8"); }
  catch { die(`skill file not found next to the CLI (${SKILL_FILE}). Reinstall from https://github.com/0xArx/voke-cli`); }

  if (flags._[0] !== "install") { process.stdout.write(md); return; }

  const dir = flags.dir || path.join(os.homedir(), ".claude", "skills", "voke-alarms");
  const dest = path.join(dir, "SKILL.md");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, md);
  console.log(`Installed the Voke skill → ${dest}`);
  console.log("Your AI agent can now set alarms. Pair it first with: voke link");
}

// -------------------------------------------------------------------- main

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--now" || a === "--daily") flags[a.slice(2)] = true;
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags._.push(a);
  }
  return flags;
}

const HELP = `voke — send real voice alarms to your iPhone (and let your AI do it too)

  voke link                   pair with your Voke app (recommended for agents —
                              approve a code in the app; no password needed)
  voke signup                 create an account
  voke login                  sign in with email/password
  voke logout | voke whoami
  voke add @username          send a friend request (or --email you@x.com)
  voke accept @username       accept an incoming friend request
  voke friends                list friends & pending requests
  voke alarm [options]        set an alarm
      --at HH:MM              ring at a time (24h; rolls to tomorrow if past)
      --in 10m | 2h           ring after a duration
      --now                   ring as soon as the phone syncs
      --say "text"            AI voice via ElevenLabs (needs ELEVENLABS_API_KEY)
      --voice file.mp3        use an audio file (mp3/m4a/wav, ≤30s)
      --title "Label"         alarm label
      --to @username          send to a friend (they must allow it)
      --daily                 repeat daily
  voke list                   recent alarms
  voke skill                  print the AI-agent skill (this CLI ships with it)
  voke skill install          install it into your agent (~/.claude/skills)

Voices are capped at 30 seconds. Docs: https://github.com/0xArx/voke-cli`;

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    switch (cmd) {
      case "link": return await cmdLink(flags);
      case "signup": return await cmdSignup(flags);
      case "login": return await cmdLogin(flags);
      case "logout": return cmdLogout();
      case "whoami": return await cmdWhoami();
      case "add": return await cmdAdd(flags);
      case "accept": return await cmdAccept(flags);
      case "friends": return await cmdFriends();
      case "alarm": return await cmdAlarm(flags);
      case "list": return await cmdList();
      case "skill": return cmdSkill(flags);
      default: console.log(HELP);
    }
  } catch (e) {
    die(e.message || String(e));
  }
})();
