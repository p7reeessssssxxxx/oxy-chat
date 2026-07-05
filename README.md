# oxy-chat-relay

Global cross-server chat backend for the Oxy hub. Every person running the chat
client connects here, so messages fan out across every Roblox server/game at once —
like a hub-wide public chat.

* **WebSocket** (`/ws`) is the primary path — instant broadcast, presence, history.
* **HTTP** (`/api/*`) is a fallback for executors without a WebSocket API.
* **filter.js** is the source of truth for moderation. The client pre-filters for
  instant feedback, but the server always re-checks — never trust the client.
* **gradients.js** gates the exclusive gradient tags/effects behind roles.

## Deploy (Railway / Render / Fly — plain Node)

```
cd oxy-chat-relay
npm install
npm start          # listens on $PORT (default 8080)
```

On Railway: point a service at this folder, it auto-runs `npm start`. Railway
proxies WebSockets natively, so the client connects to `wss://<your-domain>/ws`.

### Environment variables

| var         | example                                   | meaning |
|-------------|-------------------------------------------|---------|
| `PORT`      | `8080`                                    | set automatically by the host |
| `ROLES`     | `{"12345":"owner","678":"staff","99":"vip"}` | Roblox **UserId → role**. Everyone else is `member`. |
| `OWNER_IDS` | `12345,67890`                             | shortcut: comma-separated UserIds forced to `owner` |
| `ADMIN_SECRET` | `some-long-secret`                     | self-serve admin: a user who types `/admin <secret>` in chat is promoted to `owner` (in-memory, resets on restart). Unset = disabled. |

Roles unlock exclusive gradient tags + effects (see `gradients.js`):

| role   | unlocks                    | effect |
|--------|----------------------------|--------|
| member | ocean, toxic, fire, sunset, grape, mono | none |
| vip    | + aqua, prism              | glow / sparkle |
| staff  | + gold                     | glow |
| owner  | + rainbow                  | animated rainbow |

## Client config

In `oxy chat.lua` set:

```lua
local BACKEND_URL = "https://<your-railway-domain>"   -- no trailing slash
```

The client derives the WebSocket URL (`wss://…/ws`) automatically and falls back
to HTTP polling if the executor has no WebSocket API.

## Name claiming (password)

A display name is reserved to a **password**. The first person to use a name sets
its password; anyone who wants that name again (even on an alt) must supply the same
password, or they're rejected with `name is taken — wrong password`. New names require
a 3+ char password. Claims persist to `claims.json` (survives restarts on the same
instance; a Railway **redeploy** wipes it unless you mount a volume at `CLAIMS_FILE`).

## Admin: deleting messages

`owner`/`staff` roles (see `ROLES`) can delete any message:
* WS: `{type:"delete", id}` from an authed admin socket.
* HTTP: `POST /api/delete {userId, id}` — 403 for non-admins.

The relay removes it from history and broadcasts `{type:"delete", id}`; every client
drops that row. In the client, admins see a trash icon on hover over any message.

## Server-join invites

A user can share the server they're in as a clickable invite (the client's "link"
button in the top bar). The message carries `join: {placeId, jobId}` (validated on the
relay); everyone else sees a **Join server** button that runs
`TeleportService:TeleportToPlaceInstance(placeId, jobId)`. Works for public servers.

## Self-serve admin

If `ADMIN_SECRET` is set, a user typing `/admin <secret>` in chat is promoted to
`owner` and immediately gets delete buttons + all gradient tags. (In-memory; resets on
restart. For permanent admins use `ROLES`/`OWNER_IDS`.)

## Moderation

`filter.js`:
* **CSAM terms** → message rejected + logged as `[FLAG:csam]`. Leet-normalized
  (`ch1ld p0rn`, spacing, etc). Standalone `cp` is blocked (aggressive by design).
* **Racial/hard slurs** → rejected (leet + spacing normalized).
* **Links / discord invites / scam domains** → rejected.
* **Soft profanity** (`fuck`, `shit`, …) → masked with `****`, message still sends.
* **Names** are stricter: 1–18 chars, no slurs/profanity/links/CSAM, safe charset.

## Endpoints (HTTP fallback)

| method | path | body / query | returns |
|--------|------|--------------|---------|
| GET  | `/health` | | `{ok, online, seq}` |
| POST | `/api/hello` | `{userId, name, password, gradientId}` | `{ok, name, role, gradientId, allowed[], online}` |
| POST | `/api/setname` | `{userId, name, password}` | `{ok, name}` or `{ok:false, reason}` |
| POST | `/api/send` | `{userId, name, text, gradientId}` | `{ok, msg}` or `{ok:false, reason, retryMs}` |
| POST | `/api/delete` | `{userId, id}` (admin only) | `{ok}` or `403` |
| GET  | `/api/messages` | `?since=<id>&userId=<id>` | `{ok, messages[], cursor, online}` |
| GET  | `/api/presence` | | `{ok, online, users[]}` |
| GET  | `/` | | live dashboard |

## WebSocket protocol

Client → server: `{type:"hello",userId,name,password,gradientId}`, `{type:"msg",text,gradientId}`,
`{type:"setname",name,password}`, `{type:"delete",id}` (admin), `{type:"hb"}`.

Server → client: `{type:"welcome",...}`, `{type:"history",messages}`,
`{type:"msg",...}` (broadcast), `{type:"delete",id}` (broadcast), `{type:"ack",ok,reason,id}`,
`{type:"presence",online}`, `{type:"nameok"|"nameerr"|"helloerr"}`, `{type:"hb"}`.

History is in-memory (last ~120 messages) and clears on restart.
