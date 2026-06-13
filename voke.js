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
 *   voke alarm --in 1h --use "Wake up"   reuse a saved/favorited sound
 *   voke voices                          list saved sounds (★ favorites) + received
 *   voke voices fav|unfav|rename|save|delete   manage your sound library
 *   voke add / accept / remove / friends / consent / ring   friend management
 *   voke list                            recent alarms (with ids)
 *   voke cancel <alarm_id>               delete an alarm
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

// ----------------------------------------------------------- voice library

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => UUID_RE.test(String(s || ""));

function fmtDuration(seconds) {
  const t = Math.round(Number(seconds) || 0);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** My saved sounds, favorites first then newest. */
async function ownedVoices(token, userID) {
  const r = await api(
    "GET",
    `/rest/v1/voice_notes?owner_id=eq.${userID}&order=is_favorite.desc,created_at.desc&select=id,title,duration,is_favorite,saved_from`,
    { token }
  );
  return r.json || [];
}

/** Voices friends sent me (RLS only returns ones from alarms addressed to me),
 *  minus any I've already saved into my own library. */
async function receivedVoices(token, userID, owned) {
  const r = await api(
    "GET",
    `/rest/v1/voice_notes?owner_id=neq.${userID}&order=created_at.desc&select=id,title,duration`,
    { token }
  );
  const savedFrom = new Set((owned || []).map((v) => v.saved_from).filter(Boolean));
  const seen = new Set();
  return (r.json || []).filter((v) => {
    if (savedFrom.has(v.id) || seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });
}

/** Resolve a voice reference (a UUID, or a case-insensitive title substring)
 *  against a list. Dies with a helpful message on no/ambiguous match. */
function pickVoice(list, ref, { kind = "sound" } = {}) {
  if (!ref) die(`which ${kind}? pass a title or id (see them with \`voke voices\`)`);
  const hits = isUUID(ref)
    ? list.filter((v) => v.id.toLowerCase() === ref.toLowerCase())
    : list.filter((v) => (v.title || "").toLowerCase().includes(ref.toLowerCase()));
  if (!hits.length) die(`no ${kind} matches "${ref}" — list them with \`voke voices\``);
  if (hits.length > 1) {
    const names = hits.map((v) => `“${v.title || "Voice note"}”`).join(", ");
    die(`"${ref}" matches ${hits.length} ${kind}s (${names}) — be more specific or use the id`);
  }
  return hits[0];
}

// ----------------------------------------------------------------- commands

// ------------------------------------------------- agent-token mode (vk_…)

/** Calls the deployed agent-api edge function with the stored vk_ token. */
async function agentCall(action, params = {}) {
  const creds = readCreds();
  const r = await api("POST", "/functions/v1/agent-api", {
    body: { token: creds.agent_token, action, ...params },
  });
  if (r.status === 401) die("agent access is paused, revoked, or invalid — resume it in the Voke app (Settings → AI Agents), or run `voke link` again");
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

/** Resolve {username|email} params for an agent-api social call from flags. */
function socialParams(flags) {
  if (flags.email) return { email: flags.email };
  return { username: String(flags._[0] || flags.to || "").replace(/^@/, "") };
}

/** Send a friend request (or auto-accept if they already requested you). */
async function cmdAdd(flags) {
  const creds = readCreds();
  if (creds?.agent_token) {
    const r = await agentCall("add_friend", socialParams(flags));
    console.log(r.accepted
      ? `You're now friends with @${r.friend}.`
      : `Friend request sent to @${r.friend}.`);
    return;
  }
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
  const creds = readCreds();
  if (creds?.agent_token) {
    const r = await agentCall("accept_friend", socialParams(flags));
    console.log(`You're now friends with @${r.friend}.`);
    return;
  }
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
  const creds = readCreds();
  if (creds?.agent_token) {
    const r = await agentCall("friends");
    const has = r.friends?.length || r.incoming?.length || r.outgoing?.length;
    if (!has) return console.log("no friends yet — add one with `voke add @username`");
    if (r.friends?.length) { console.log("Friends:"); r.friends.forEach((u) => console.log(`  @${u}`)); }
    if (r.incoming?.length) { console.log("Incoming requests (accept with `voke accept @name`):"); r.incoming.forEach((u) => console.log(`  @${u}`)); }
    if (r.outgoing?.length) { console.log("Sent (waiting):"); r.outgoing.forEach((u) => console.log(`  @${u}`)); }
    return;
  }
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

/** Unfriend someone (removes the friendship both directions). */
async function cmdRemove(flags) {
  const creds = readCreds();
  if (creds?.agent_token) {
    const r = await agentCall("remove_friend", socialParams(flags));
    console.log(`Removed @${r.removed}.`);
    return;
  }
  const { token, user } = await session();
  const target = await resolveUser(token, { handle: flags._[0] || flags.to, email: flags.email });
  const r = await api(
    "DELETE",
    `/rest/v1/trusted_contacts?or=(and(user_id.eq.${user.id},contact_user_id.eq.${target.id}),and(user_id.eq.${target.id},contact_user_id.eq.${user.id}))`,
    { token, prefer: "return=minimal" }
  );
  if (r.status >= 300) die(`couldn't remove (${r.status}): ${r.text.slice(0, 200)}`);
  console.log(`Removed @${target.username}.`);
}

const onOff = (v) => (v === undefined ? undefined : /^(on|true|yes|1|allow)$/i.test(v));

/** Per-friend consent: who can send YOU alarms / Voke YOUR phone.
 *  voke consent @user --alarms on|off --phone on|off */
async function cmdConsent(flags) {
  const alarms = onOff(flags.alarms);
  const phone = onOff(flags.phone);
  if (alarms === undefined && phone === undefined) {
    die("set --alarms on|off and/or --phone on|off  (e.g. voke consent @sara --alarms on --phone off)");
  }
  const creds = readCreds();
  if (creds?.agent_token) {
    const params = socialParams(flags);
    if (alarms !== undefined) params.can_send_alarms = alarms;
    if (phone !== undefined) params.can_voke_phone = phone;
    const r = await agentCall("set_consent", params);
    console.log(`Updated consent for @${r.friend}.`);
    return;
  }
  const { token, user } = await session();
  const target = await resolveUser(token, { handle: flags._[0], email: flags.email });
  const patch = {};
  if (alarms !== undefined) patch.can_send_alarms = alarms;
  if (phone !== undefined) patch.can_voke_phone = phone;
  const r = await api("PATCH", `/rest/v1/trusted_contacts?user_id=eq.${user.id}&contact_user_id=eq.${target.id}`, {
    token, prefer: "return=minimal", body: patch,
  });
  if (r.status >= 300) die(`consent update failed (${r.status}): ${r.text.slice(0, 200)}`);
  console.log(`Updated consent for @${target.username}.`);
}

/** Ring a friend's phone aloud ("Voke my phone"). Consent enforced server-side. */
async function cmdRing(flags) {
  const creds = readCreds();
  if (creds?.agent_token) {
    const r = await agentCall("voke_phone", socialParams(flags));
    console.log(`Ringing @${r.ringing}'s phone…`);
    return;
  }
  const { token, user } = await session();
  const target = await resolveUser(token, { handle: flags._[0] || flags.to, email: flags.email });
  const r = await api("POST", "/rest/v1/phone_finder_requests", {
    token, prefer: "return=minimal",
    body: { from_user_id: user.id, to_user_id: target.id, status: "pending" },
  });
  if (r.status >= 300) {
    const m = r.text.includes("not allowed") ? "they haven't allowed you to Voke their phone" : r.text.slice(0, 200);
    die(`couldn't ring (${r.status}): ${m}`);
  }
  console.log(`Ringing @${target.username}'s phone…`);
}

/** Block a user so they can no longer reach the user. */
async function cmdBlock(flags) {
  const creds = readCreds();
  if (creds?.agent_token) {
    const r = await agentCall("block", socialParams(flags));
    console.log(`Blocked @${r.blocked}.`);
    return;
  }
  const { token, user } = await session();
  const target = await resolveUser(token, { handle: flags._[0] || flags.to, email: flags.email });
  const r = await api("POST", "/rest/v1/trusted_contacts?on_conflict=user_id,contact_user_id", {
    token, prefer: "resolution=merge-duplicates,return=minimal",
    body: { user_id: user.id, contact_user_id: target.id, status: "blocked", can_send_alarms: false, can_voke_phone: false },
  });
  if (r.status >= 300) die(`couldn't block (${r.status}): ${r.text.slice(0, 200)}`);
  console.log(`Blocked @${target.username}.`);
}

/** Report a user (and block them, unless --no-block). */
async function cmdReport(flags) {
  const reason = flags.reason || "other";
  const block = flags["no-block"] !== true;
  const creds = readCreds();
  if (creds?.agent_token) {
    const r = await agentCall("report", { ...socialParams(flags), reason, block });
    console.log(`Reported @${r.reported}${r.blocked ? " and blocked them" : ""}.`);
    return;
  }
  const { token, user } = await session();
  const target = await resolveUser(token, { handle: flags._[0] || flags.to, email: flags.email });
  const r = await api("POST", "/rest/v1/reports", {
    token, prefer: "return=minimal",
    body: { reporter_id: user.id, reported_id: target.id, reason },
  });
  if (r.status >= 300) die(`couldn't report (${r.status}): ${r.text.slice(0, 200)}`);
  if (block) {
    await api("POST", "/rest/v1/trusted_contacts?on_conflict=user_id,contact_user_id", {
      token, prefer: "resolution=merge-duplicates,return=minimal",
      body: { user_id: user.id, contact_user_id: target.id, status: "blocked", can_send_alarms: false, can_voke_phone: false },
    });
  }
  console.log(`Reported @${target.username}${block ? " and blocked them" : ""}.`);
}

/** Delete an alarm you own (cancel it). */
async function cmdCancel(flags) {
  const id = flags._[0];
  if (!id) die("usage: voke cancel <alarm_id>  (see ids in `voke list`)");
  const creds = readCreds();
  if (creds?.agent_token) {
    await agentCall("delete_alarm", { alarm_id: id });
    console.log(`Deleted alarm ${id}.`);
    return;
  }
  const { token, user } = await session();
  const r = await api("DELETE", `/rest/v1/alarms?id=eq.${id}&owner_id=eq.${user.id}`, {
    token, prefer: "return=representation",
  });
  if (!r.json?.length) die("no alarm with that id that you own");
  console.log(`Deleted alarm ${id}.`);
}

// ----------------------------------------------------------- voice commands

/**
 * voke voices                       list your saved sounds + ones friends sent you
 * voke voices fav    <title|id>     favorite a sound (favorites ring first / pin)
 * voke voices unfav  <title|id>     remove from favorites
 * voke voices rename <title|id> "New name"
 * voke voices save   <title|id>     save a friend's voice into your own library
 *
 * Works in both modes — a paired agent acts on the user's behalf, so it can
 * manage the library too (via the scoped agent-api), as well as a full login.
 */
async function cmdVoices(flags) {
  const sub = (flags._[0] || "list").toLowerCase();

  // Agent-token mode: route through the scoped agent-api (same capabilities).
  const creds = readCreds();
  if (creds?.agent_token) {
    if (sub === "list") {
      const { voices, received } = await agentCall("voices");
      const favs = (voices || []).filter((v) => v.is_favorite);
      const rest = (voices || []).filter((v) => !v.is_favorite);
      if (!voices?.length && !received?.length) return console.log("no saved sounds yet");
      if (favs.length) {
        console.log("Favorites:");
        favs.forEach((v) => console.log(`  ★ ${fmtDuration(v.duration).padEnd(6)} ${v.title || "Voice note"}`));
      }
      if (rest.length) {
        console.log(favs.length ? "More sounds:" : "Your sounds:");
        rest.forEach((v) => console.log(`    ${fmtDuration(v.duration).padEnd(6)} ${v.title || "Voice note"}`));
      }
      if (received?.length) {
        console.log("From friends (save one with `voke voices save \"<title>\"`):");
        received.forEach((v) => console.log(`    ${fmtDuration(v.duration).padEnd(6)} ${v.title || "Voice note"}`));
      }
      return;
    }
    if (["fav", "favorite", "unfav", "unfavorite"].includes(sub)) {
      const on = sub === "fav" || sub === "favorite";
      const { voices } = await agentCall("voices");
      const v = pickVoice(voices || [], flags._[1]);
      await agentCall("favorite", { voice_id: v.id, favorite: on });
      console.log(`${on ? "★ Favorited" : "Removed from favorites"}: “${v.title || "Voice note"}”`);
      return;
    }
    if (sub === "rename") {
      const { voices } = await agentCall("voices");
      const v = pickVoice(voices || [], flags._[1]);
      const newTitle = (flags._.slice(2).join(" ") || flags.title || "").trim();
      if (!newTitle) die(`give a new name: voke voices rename "<current>" "New name"`);
      await agentCall("rename", { voice_id: v.id, title: newTitle });
      console.log(`Renamed “${v.title || "Voice note"}” → “${newTitle}”`);
      return;
    }
    if (sub === "save") {
      const { received } = await agentCall("voices");
      const v = pickVoice(received || [], flags._[1], { kind: "received voice" });
      await agentCall("save_voice", { voice_id: v.id });
      console.log(`Saved “${v.title || "Voice note"}” to your sounds. Reuse it with: voke alarm --use "${v.title || ""}"`);
      return;
    }
    if (sub === "delete" || sub === "rm") {
      const { voices } = await agentCall("voices");
      const v = pickVoice(voices || [], flags._[1]);
      await agentCall("delete_voice", { voice_id: v.id });
      console.log(`Deleted “${v.title || "Voice note"}”.`);
      return;
    }
    die(`unknown: voke voices ${sub}. Use: list | fav | unfav | rename | save | delete`);
  }

  const { token, user } = await session();
  const userID = user.id;

  if (sub === "list") {
    const owned = await ownedVoices(token, userID);
    const received = await receivedVoices(token, userID, owned);
    if (!owned.length && !received.length) {
      return console.log("no sounds yet — record or import one in the app, or set an alarm with --say/--voice");
    }
    const favs = owned.filter((v) => v.is_favorite);
    const rest = owned.filter((v) => !v.is_favorite);
    if (favs.length) {
      console.log("Favorites:");
      favs.forEach((v) => console.log(`  ★ ${fmtDuration(v.duration).padEnd(6)} ${v.title || "Voice note"}`));
    }
    if (rest.length) {
      console.log(favs.length ? "More sounds:" : "Your sounds:");
      rest.forEach((v) => console.log(`    ${fmtDuration(v.duration).padEnd(6)} ${v.title || "Voice note"}`));
    }
    if (received.length) {
      console.log("From friends (save one with `voke voices save \"<title>\"`):");
      received.forEach((v) => console.log(`    ${fmtDuration(v.duration).padEnd(6)} ${v.title || "Voice note"}`));
    }
    return;
  }

  if (sub === "fav" || sub === "favorite" || sub === "unfav" || sub === "unfavorite") {
    const on = sub === "fav" || sub === "favorite";
    const owned = await ownedVoices(token, userID);
    const v = pickVoice(owned, flags._[1]);
    const r = await api("PATCH", `/rest/v1/voice_notes?id=eq.${v.id}`, {
      token, prefer: "return=minimal", body: { is_favorite: on },
    });
    if (r.status >= 300) die(`couldn't update favorite (${r.status}): ${r.text.slice(0, 200)}`);
    console.log(`${on ? "★ Favorited" : "Removed from favorites"}: “${v.title || "Voice note"}”`);
    return;
  }

  if (sub === "rename") {
    const owned = await ownedVoices(token, userID);
    const v = pickVoice(owned, flags._[1]);
    const newTitle = (flags._.slice(2).join(" ") || flags.title || "").trim();
    if (!newTitle) die(`give a new name: voke voices rename "<current>" "New name"`);
    const r = await api("PATCH", `/rest/v1/voice_notes?id=eq.${v.id}`, {
      token, prefer: "return=minimal", body: { title: newTitle },
    });
    if (r.status >= 300) die(`rename failed (${r.status}): ${r.text.slice(0, 200)}`);
    console.log(`Renamed “${v.title || "Voice note"}” → “${newTitle}”`);
    return;
  }

  if (sub === "save") {
    const owned = await ownedVoices(token, userID);
    const received = await receivedVoices(token, userID, owned);
    const v = pickVoice(received, flags._[1], { kind: "received voice" });
    // Copy the audio into my own storage, then record an owned voice note that
    // remembers where it came from (so it won't show up to re-save again).
    const meta = await api("GET", `/rest/v1/voice_notes?id=eq.${v.id}&select=storage_path,duration`, { token });
    const srcPath = meta.json?.[0]?.storage_path;
    if (!srcPath) die("couldn't read that voice — it may no longer be shared with you");
    const dl = await fetch(`${SUPABASE_URL}/storage/v1/object/voice-notes/${srcPath}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!dl.ok) die(`couldn't download that voice (${dl.status})`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const ext = (srcPath.split(".").pop() || "m4a").toLowerCase();
    const types = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/mp4", caf: "audio/x-caf" };
    const id = crypto.randomUUID();
    const destPath = `${userID.toLowerCase()}/${id.toLowerCase()}.${ext}`;
    const up = await api("POST", `/storage/v1/object/voice-notes/${destPath}`, {
      token, raw: bytes, contentType: types[ext] || "audio/mp4",
    });
    if (up.status !== 200 && up.status !== 201) die(`save failed on upload (${up.status}): ${up.text.slice(0, 200)}`);
    const row = await api("POST", "/rest/v1/voice_notes", {
      token,
      body: {
        id, owner_id: userID, title: v.title || "Voice note",
        storage_path: destPath, duration: meta.json?.[0]?.duration || 0,
        saved_from: v.id,
      },
    });
    if (row.status !== 201) die(`save failed (${row.status}): ${row.text.slice(0, 200)}`);
    console.log(`Saved “${v.title || "Voice note"}” to your sounds. Reuse it with: voke alarm --use "${v.title || ""}"`);
    return;
  }

  if (sub === "delete" || sub === "rm") {
    const v = pickVoice(await ownedVoices(token, userID), flags._[1]);
    const meta = await api("GET", `/rest/v1/voice_notes?id=eq.${v.id}&select=storage_path`, { token });
    const sp = meta.json?.[0]?.storage_path;
    await api("DELETE", `/rest/v1/voice_notes?id=eq.${v.id}`, { token, prefer: "return=minimal" });
    if (sp) await api("DELETE", `/storage/v1/object/voice-notes/${sp}`, { token });
    console.log(`Deleted “${v.title || "Voice note"}”.`);
    return;
  }

  die(`unknown: voke voices ${sub}. Use: list | fav | unfav | rename | save | delete`);
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
    if (flags.use) {
      let vid = flags.use;
      if (!isUUID(flags.use)) {
        const { voices } = await agentCall("voices");
        const v = pickVoice(voices || [], flags.use);
        vid = v.id;
        if (!flags.title && v.title) params.title = v.title;
      }
      params.voice_id = vid;
    } else if (flags.say) {
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
  let title = deriveTitle(flags);

  // Resolve the voice (reuse saved > TTS > file > none/default tone).
  let voiceNoteID = null;
  if (flags.use) {
    const v = pickVoice(await ownedVoices(token, userID), flags.use);
    voiceNoteID = v.id;
    if (!flags.title && !flags.say && v.title) title = v.title; // inherit the saved name
  } else if (flags.say) {
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

function printAlarm(a) {
  const t = a.is_right_now ? "right-now" : new Date(a.scheduled_time).toLocaleString();
  console.log(`${(a.status || "?").padEnd(10)} ${t.padEnd(22)} ${(a.title || "").padEnd(20)} ${a.id || ""}`);
}

async function cmdList() {
  const creds = readCreds();
  if (creds?.agent_token) {
    const { alarms } = await agentCall("list");
    if (!alarms?.length) return console.log("no alarms yet");
    alarms.forEach(printAlarm);
    console.log("\nCancel one with: voke cancel <id>");
    return;
  }
  const { token, user } = await session();
  const r = await api(
    "GET",
    `/rest/v1/alarms?or=(owner_id.eq.${user.id},recipient_id.eq.${user.id})&order=created_at.desc&limit=15&select=id,title,scheduled_time,status,type,is_right_now`,
    { token }
  );
  if (!r.json?.length) return console.log("no alarms yet");
  r.json.forEach(printAlarm);
  console.log("\nCancel one with: voke cancel <id>");
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
    if (a === "--now" || a === "--daily" || a === "--no-block") flags[a.slice(2)] = true;
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
  voke remove @username       unfriend (remove both directions)
  voke friends                list friends & pending requests
  voke consent @username      who can reach you: --alarms on|off --phone on|off
  voke ring @username         ring a friend's phone aloud ("Voke my phone")
  voke block @username        block a user (they can no longer reach you)
  voke report @username       report a user (--reason <r>; also blocks unless --no-block)
  voke alarm [options]        set an alarm
      --at HH:MM              ring at a time (24h; rolls to tomorrow if past)
      --in 10m | 2h           ring after a duration
      --now                   ring as soon as the phone syncs
      --say "text"            AI voice via ElevenLabs (needs ELEVENLABS_API_KEY)
      --voice file.mp3        use an audio file (mp3/m4a/wav, ≤30s)
      --use "title"|id        reuse a saved sound (see \`voke voices\`)
      --title "Label"         alarm label
      --to @username          send to a friend (they must allow it)
      --daily                 repeat daily
  voke voices                 list your saved sounds + ones friends sent you
      voices fav "title"      favorite a sound (favorites pin / ring first)
      voices unfav "title"    remove from favorites
      voices rename "t" "new" rename a sound
      voices save "title"     save a friend's voice into your library
      voices delete "title"   delete a saved sound
  voke list                   recent alarms (with ids)
  voke cancel <alarm_id>      delete an alarm you set
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
      case "remove": case "unfriend": return await cmdRemove(flags);
      case "friends": return await cmdFriends();
      case "consent": return await cmdConsent(flags);
      case "ring": return await cmdRing(flags);
      case "block": return await cmdBlock(flags);
      case "report": return await cmdReport(flags);
      case "alarm": return await cmdAlarm(flags);
      case "cancel": return await cmdCancel(flags);
      case "voices": case "voice": return await cmdVoices(flags);
      case "list": return await cmdList();
      case "skill": return cmdSkill(flags);
      default: console.log(HELP);
    }
  } catch (e) {
    die(e.message || String(e));
  }
})();
