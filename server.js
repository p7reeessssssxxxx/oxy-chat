// oxy-chat-relay/server.js
// Global cross-server chat relay for the Oxy hub.
//
//   * WebSocket (/ws)   — primary path: instant broadcast, presence, history.
//   * HTTP  (/api/*)    — fallback for executors without a WebSocket API.
//   * Every message + name passes through filter.js (server is the source of truth).
//   * Roles (owner/staff/vip/member) gate the exclusive gradient tags + effects.
//
// State is in-memory (history ring buffer + presence + profiles). A restart clears
// chat history; that's fine for a live chat. Deploy on Railway/Render/Fly — plain Node.

const express = require("express");
const http = require("http");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const { moderate, moderateName } = require("./filter.js");
const { allowedGradients, resolveGradient, rankOf, ROLE_RANK } = require("./gradients.js");

const PORT = process.env.PORT || 8080;

// ---- name claiming ----------------------------------------------------------
// A name is reserved to a password. Whoever sets the password first owns the
// name; anyone who wants to use it again (even on an alt) must supply the same
// password. Persisted to disk so claims survive restarts on the same instance.
const CLAIMS_FILE = process.env.CLAIMS_FILE || "./claims.json";
let claims = {};                  // nameLower -> { password, userId, name }
try { claims = JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8")); } catch (_) { claims = {}; }
let claimsDirty = false;
function saveClaims() { claimsDirty = true; }
setInterval(() => {
  if (!claimsDirty) return;
  claimsDirty = false;
  try { fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claims)); } catch (_) {}
}, 3000);

// ---- internal user numbers --------------------------------------------------
// Each Roblox account gets a stable sequential "User #N" shown in chat instead of
// their real UserId. Persisted so numbers stay the same across restarts.
const NUMS_FILE = process.env.NUMS_FILE || "./nums.json";
let nums = { seq: 0, map: {} };
try { nums = JSON.parse(fs.readFileSync(NUMS_FILE, "utf8")); } catch (_) { nums = { seq: 0, map: {} }; }
let numsDirty = false;
function saveNums() { numsDirty = true; }
setInterval(() => {
  if (!numsDirty) return;
  numsDirty = false;
  try { fs.writeFileSync(NUMS_FILE, JSON.stringify(nums)); } catch (_) {}
}, 3000);
function numFor(userId) {
  userId = String(userId);
  if (nums.map[userId] == null) { nums.map[userId] = ++nums.seq; saveNums(); }
  return nums.map[userId];
}

// Validate + reserve a name against a password. Returns { ok, name } or { ok:false, reason }.
function claimName(name, password, userId) {
  const nm = moderateName(name);
  if (!nm.ok) return { ok: false, reason: nm.reason };
  const key = nm.name.toLowerCase();
  const pw = String(password == null ? "" : password);
  const existing = claims[key];
  if (existing) {
    if (existing.password !== pw) return { ok: false, reason: "name is taken — wrong password" };
    existing.userId = String(userId); existing.name = nm.name; saveClaims();
    return { ok: true, name: nm.name };
  }
  if (pw.length < 3) return { ok: false, reason: "set a password (3+ chars) to claim this name" };
  claims[key] = { password: pw, userId: String(userId), name: nm.name };
  saveClaims();
  return { ok: true, name: nm.name };
}

// ---- roles ------------------------------------------------------------------
// ROLES env = JSON { "<userId>": "owner"|"staff"|"vip" }.  Everyone else = member.
// OWNER_IDS env = comma-separated userIds forced to owner (convenience).
let ROLES = {};
try { ROLES = JSON.parse(process.env.ROLES || "{}"); } catch (_) { ROLES = {}; }
for (const id of (process.env.OWNER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
  ROLES[id] = "owner";
}
function roleOf(userId) {
  return ROLES[String(userId)] || "member";
}

// Self-serve admin: a user who types the ADMIN_SECRET is promoted to owner.
// Leave ADMIN_SECRET unset to disable. Promotions are in-memory (reset on restart).
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
function tryAdmin(userId, secret) {
  if (!ADMIN_SECRET || String(secret) !== ADMIN_SECRET) return false;
  ROLES[String(userId)] = "owner";
  const prof = profiles.get(String(userId));
  if (prof) prof.role = "owner";
  return true;
}

// ---- state ------------------------------------------------------------------
const HISTORY_MAX = 120;
const history = [];               // ring buffer of broadcast messages
let msgSeq = 0;                   // monotonic message id / cursor

const profiles = new Map();       // userId -> { name, role, gradientId }
const presence = new Map();       // userId -> { name, role, lastSeen, via }
const PRESENCE_TTL = 15000;       // ms a user counts as "online" after last activity
const MSG_COOLDOWN = 1200;        // ms minimum gap between a user's messages
const lastMsgAt = new Map();      // userId -> timestamp

function touchPresence(userId, name, role, via) {
  presence.set(String(userId), { name, role, lastSeen: Date.now(), via });
}
function onlineCount() {
  const now = Date.now();
  let n = 0;
  for (const [, p] of presence) if (now - p.lastSeen < PRESENCE_TTL) n++;
  return n;
}
function onlineList() {
  const now = Date.now();
  const out = [];
  for (const [id, p] of presence) {
    if (now - p.lastSeen < PRESENCE_TTL) {
      const prof = profiles.get(id);
      out.push({ userId: id, num: numFor(id), name: p.name, role: p.role, gradientId: prof ? prof.gradientId : "ocean" });
    }
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

// prune stale presence + rate-limit records
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of presence) if (now - p.lastSeen > PRESENCE_TTL * 2) presence.delete(id);
  for (const [id, t] of lastMsgAt) if (now - t > 60000) lastMsgAt.delete(id);
}, 10000);

// ---- build + record a broadcast message -------------------------------------
function pushMessage(msg) {
  history.push(msg);
  if (history.length > HISTORY_MAX) history.shift();
}

// Validate an optional server-join payload {placeId, jobId} shared in a message.
function sanitizeJoin(join) {
  if (!join || typeof join !== "object") return null;
  const placeId = Number(join.placeId);
  const jobId = String(join.jobId || "");
  if (!placeId || placeId < 1 || !jobId || jobId.length > 80 || !/^[A-Za-z0-9-]+$/.test(jobId)) return null;
  return { placeId, jobId };
}

// Core send path shared by WS + HTTP. Returns { ok, msg?, reason? }.
function handleSend({ userId, name, gradientId, text, join }) {
  userId = String(userId || "");
  if (!userId) return { ok: false, reason: "missing user" };

  // rate limit
  const now = Date.now();
  const last = lastMsgAt.get(userId) || 0;
  if (now - last < MSG_COOLDOWN) {
    return { ok: false, reason: "slow down", retryMs: MSG_COOLDOWN - (now - last) };
  }

  // resolve name (use stored profile, else moderate the supplied one)
  let prof = profiles.get(userId);
  if (!prof) {
    const nm = moderateName(name || ("User" + userId.slice(-4)));
    if (!nm.ok) return { ok: false, reason: nm.reason };
    prof = { name: nm.name, role: roleOf(userId), gradientId: "ocean" };
    profiles.set(userId, prof);
  }
  prof.role = roleOf(userId); // refresh in case ROLES changed

  // moderate the message body
  const mod = moderate(text);
  if (!mod.ok) {
    if (mod.flag === "csam") {
      console.warn(`[FLAG:csam] user=${userId} name=${prof.name} text=${JSON.stringify(String(text).slice(0, 120))}`);
    }
    return { ok: false, reason: mod.reason };
  }

  // resolve gradient against role (downgrade if they can't use it)
  const grad = resolveGradient(gradientId || prof.gradientId, prof.role);
  prof.gradientId = grad.id;

  lastMsgAt.set(userId, now);
  touchPresence(userId, prof.name, prof.role, "send");

  const msg = {
    type: "msg",
    id: ++msgSeq,
    userId,
    num: numFor(userId),
    name: prof.name,
    role: prof.role,
    gradientId: grad.id,
    effect: grad.effect,
    text: mod.text,
    ts: now,
  };
  const j = sanitizeJoin(join);
  if (j) msg.join = j;
  pushMessage(msg);
  broadcast(msg);
  broadcastPresence();
  return { ok: true, msg };
}

// ---- express / http ---------------------------------------------------------
const app = express();
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, online: onlineCount(), seq: msgSeq }));

// Register / update a profile with a claimed (password-protected) name.
app.post("/api/hello", (req, res) => {
  const { userId, name, gradientId, password } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, reason: "missing user" });
  const claim = claimName(name || ("User" + String(userId).slice(-4)), password, userId);
  if (!claim.ok) return res.json({ ok: false, reason: claim.reason });
  const role = roleOf(userId);
  const grad = resolveGradient(gradientId, role);
  profiles.set(String(userId), { name: claim.name, role, gradientId: grad.id });
  touchPresence(userId, claim.name, role, "http");
  broadcastPresence();
  res.json({
    ok: true,
    name: claim.name,
    role,
    num: numFor(userId),
    gradientId: grad.id,
    allowed: allowedGradients(role),
    online: onlineCount(),
  });
});

app.post("/api/setname", (req, res) => {
  const { userId, name, password } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, reason: "missing user" });
  const claim = claimName(name, password, userId);
  if (!claim.ok) return res.json({ ok: false, reason: claim.reason });
  const prof = profiles.get(String(userId)) || { role: roleOf(userId), gradientId: "ocean" };
  prof.name = claim.name;
  prof.role = roleOf(userId);
  profiles.set(String(userId), prof);
  res.json({ ok: true, name: claim.name });
});

// Admin: delete a message (owner/staff only).
function deleteMessage(id) {
  id = Number(id);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].id === id) { history.splice(i, 1); break; }
  }
  broadcast({ type: "delete", id });
}
app.post("/api/delete", (req, res) => {
  const { userId, id } = req.body || {};
  if (rankOf(roleOf(userId)) < ROLE_RANK.staff) return res.status(403).json({ ok: false, reason: "not allowed" });
  deleteMessage(id);
  res.json({ ok: true });
});

app.post("/api/admin", (req, res) => {
  const { userId, secret } = req.body || {};
  if (!userId || !tryAdmin(userId, secret)) return res.json({ ok: false, reason: "wrong secret" });
  const role = roleOf(userId);
  res.json({ ok: true, role, allowed: allowedGradients(role) });
});

app.post("/api/send", (req, res) => {
  const r = handleSend(req.body || {});
  if (!r.ok) return res.json({ ok: false, reason: r.reason, retryMs: r.retryMs });
  res.json({ ok: true, msg: r.msg });
});

// Poll for new messages since a cursor id.
app.get("/api/messages", (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const userId = req.query.userId;
  if (userId) {
    const p = profiles.get(String(userId));
    touchPresence(userId, p ? p.name : "User", p ? p.role : "member", "poll");
  }
  const msgs = history.filter((m) => m.id > since);
  res.json({ ok: true, messages: msgs, cursor: msgSeq, online: onlineCount() });
});

app.get("/api/presence", (_req, res) => res.json({ ok: true, online: onlineCount(), users: onlineList() }));

// ---- dashboard --------------------------------------------------------------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<title>Oxy Global Chat — Relay</title>
<style>
 body{margin:0;background:#0f151f;color:#e6edf7;font:14px/1.5 Segoe UI,system-ui,sans-serif}
 .wrap{max-width:760px;margin:40px auto;padding:0 20px}
 h1{font-size:26px;background:linear-gradient(90deg,#61a6fb,#23d4ef);-webkit-background-clip:text;background-clip:text;color:transparent}
 .card{background:#1f2a3c;border-radius:14px;padding:18px 22px;margin:14px 0;border:1px solid #2a3850}
 .stat{font-size:34px;font-weight:700;color:#7cc0ff}
 code{background:#0c1119;padding:2px 6px;border-radius:5px;color:#8fd0ff}
 .msg{padding:6px 0;border-bottom:1px solid #1c2636}
 .n{font-weight:700}
</style></head><body><div class="wrap">
 <h1>Oxy · Global Chat Relay</h1>
 <div class="card"><div>Online now</div><div class="stat" id="online">–</div></div>
 <div class="card"><div style="margin-bottom:8px;font-weight:700">Recent messages</div><div id="log">loading…</div></div>
 <div class="card">WS endpoint <code>wss://&lt;this-domain&gt;/ws</code> · HTTP <code>/api/send</code>, <code>/api/messages</code></div>
</div>
<script>
 async function tick(){
  try{
   const p = await (await fetch('/api/presence')).json();
   document.getElementById('online').textContent = p.online;
   const m = await (await fetch('/api/messages?since=0')).json();
   document.getElementById('log').innerHTML = (m.messages||[]).slice(-25).map(x=>
     '<div class="msg"><span class="n">'+esc(x.name)+'</span> <span style="opacity:.5">['+x.role+']</span>: '+esc(x.text)+'</div>').join('') || '<i>no messages yet</i>';
  }catch(e){}
 }
 function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
 tick(); setInterval(tick,2000);
</script></body></html>`);
});

// ---- websocket --------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const sockets = new Set();

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) { try { ws.send(data); } catch (_) {} }
  }
}
let lastPresenceBroadcast = 0;
function broadcastPresence() {
  const now = Date.now();
  if (now - lastPresenceBroadcast < 500) return; // debounce
  lastPresenceBroadcast = now;
  broadcast({ type: "presence", online: onlineCount(), users: onlineList() });
}

wss.on("connection", (ws, req) => {
  sockets.add(ws);
  ws.isAlive = true;
  ws.userId = null;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (!m || typeof m !== "object") return;

    if (m.type === "hello") {
      const userId = String(m.userId || "");
      if (!userId) return safeSend(ws, { type: "helloerr", reason: "missing user" });
      const claim = claimName(m.name || ("User" + userId.slice(-4)), m.password, userId);
      if (!claim.ok) return safeSend(ws, { type: "helloerr", reason: claim.reason });
      const role = roleOf(userId);
      const grad = resolveGradient(m.gradientId, role);
      profiles.set(userId, { name: claim.name, role, gradientId: grad.id });
      ws.userId = userId;
      touchPresence(userId, claim.name, role, "ws");
      safeSend(ws, {
        type: "welcome",
        name: claim.name, role, gradientId: grad.id, num: numFor(userId),
        allowed: allowedGradients(role),
        online: onlineCount(),
      });
      safeSend(ws, { type: "history", messages: history.slice(-60) });
      broadcastPresence();
      return;
    }

    if (m.type === "setname") {
      const userId = ws.userId || String(m.userId || "");
      if (!userId) return;
      const claim = claimName(m.name, m.password, userId);
      if (!claim.ok) return safeSend(ws, { type: "nameerr", reason: claim.reason });
      const prof = profiles.get(userId) || { role: roleOf(userId), gradientId: "ocean" };
      prof.name = claim.name; prof.role = roleOf(userId);
      profiles.set(userId, prof);
      safeSend(ws, { type: "nameok", name: claim.name });
      return;
    }

    if (m.type === "delete") {
      const userId = ws.userId || String(m.userId || "");
      if (rankOf(roleOf(userId)) < ROLE_RANK.staff) return safeSend(ws, { type: "ack", ok: false, reason: "not allowed" });
      deleteMessage(m.id);
      return;
    }

    if (m.type === "msg") {
      const userId = ws.userId || String(m.userId || "");
      const prof = profiles.get(userId);
      const r = handleSend({
        userId,
        name: m.name || (prof && prof.name),
        gradientId: m.gradientId,
        text: m.text,
        join: m.join,
      });
      safeSend(ws, { type: "ack", ok: r.ok, reason: r.reason, retryMs: r.retryMs, id: r.ok ? r.msg.id : null });
      return;
    }

    if (m.type === "admin") {
      const userId = ws.userId || String(m.userId || "");
      if (!tryAdmin(userId, m.secret)) return safeSend(ws, { type: "adminerr", reason: "wrong secret" });
      const role = roleOf(userId);
      safeSend(ws, { type: "role", role, allowed: allowedGradients(role) });
      return;
    }

    if (m.type === "hb") {
      if (ws.userId) {
        const p = profiles.get(ws.userId);
        touchPresence(ws.userId, p ? p.name : "User", p ? p.role : "member", "ws");
      }
      safeSend(ws, { type: "hb" });
      return;
    }
  });

  ws.on("close", () => {
    sockets.delete(ws);
    if (ws.userId) presence.delete(ws.userId);
    broadcastPresence();
  });
  ws.on("error", () => { try { ws.close(); } catch (_) {} });
});

// drop dead sockets
setInterval(() => {
  for (const ws of sockets) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} sockets.delete(ws); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 20000);

server.listen(PORT, () => console.log(`oxy-chat-relay listening on :${PORT}`));
