# P2P File Share

A personal, browser-only file share. Open a room, drop files in, share the link, and
whoever opens it downloads straight from your browser. No accounts, no database, no
uploads. The server only introduces the two browsers to each other.

- **Peer to peer.** File bytes only travel between the two browsers (WebRTC data channels).
- **No auth.** The unguessable link is the access control; the host approves each joiner.
- **End-to-end encrypted.** On top of WebRTC's DTLS, every chunk, the file list and all
  signaling messages are sealed with AES-256-GCM using a key that lives only in the link's
  `#fragment`, which browsers never send to a server.
- **Trade-off:** the host's tab has to stay open while people download.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:5173, click **New room**, then open the link in another tab or browser.
`npm run dev` starts the signaling server on :8787 and Vite on :5173 (Vite proxies `/ws`).

### Testing on your phone

Phones on `http://192.168.x.x` are not a *secure context*, so WebCrypto and service workers
are switched off there. Use the HTTPS dev mode and accept the self-signed certificate:

```bash
npm run dev:lan
```

For the test the plan calls for (laptop on Wi-Fi, phone on 4G) you need a public URL: deploy
it (below) or put a tunnel such as `cloudflared tunnel --url http://localhost:5173` in front.

### Checks

```bash
npm run check
npm run build
npm run test -w signaling
```

`npm run check` type-checks the web app. The signaling test needs the server running (`npm start` or `npm run dev`).

## How it works

```
 host browser                signaling server (Node + ws)             joiner browser
 ────────────                ───────────────────────────             ──────────────
 New room ── create ──────▶  rooms: Map<id, {host, peers}>
                             ◀──────────────────────────── join ──── opens /r/<id>#k=<key>
           ◀── peer-joined ─
           ◀── signal(hello, sealed) ─────────────────────────────── proves it holds the key
 "Allow?"  ── signal(welcome, offer, ice; sealed) ─────────────────▶
           ◀──────────────────────────────── signal(answer, ice) ───
 ═══════════════ direct WebRTC connection (DTLS + AES-GCM per chunk) ═══════════════
 manifest (sealed) ───────────────────────────────────────────────▶ picks files
           ◀────────────────────────────────── want {file, from, to}
 encrypted chunks on 3 data channels ─────────────────────────────▶ decrypt, reorder, write
```

- The **receiver drives** the transfer by requesting byte ranges. That one choice gives flow
  control (at most 8 MB outstanding per file), retry, and resume after a reconnect.
- The **sender** reads and encrypts chunks in a Web Worker and respects `bufferedAmount`
  backpressure on each channel (pauses above 4 MB, resumes on `bufferedamountlow`).
- **Chunk size** follows the negotiated SCTP `maxMessageSize`: up to 240 KB where allowed,
  smaller on browsers with lower limits.
- **Writing to disk:**

  | Browser | Strategy |
  | --- | --- |
  | Chromium desktop, one big file | Save dialog, streamed with File System Access |
  | Chromium desktop, several files | Pick a folder; sub-folders are recreated |
  | Firefox, Safari, Android, files ≥ 32 MB | Service-worker streaming download (`public/sw.js`) |
  | Small files, anything else | In-memory Blob |

- **Integrity:** each chunk is AES-GCM authenticated, and its file id and byte offset are bound
  in as additional data, so chunks can't be swapped, moved or forged by anyone without the key.
  The receiver knows each file's exact size from the manifest. Together that rules out
  corruption, truncation and reordering, so there is no separate whole-file hash: WebCrypto
  can't hash a stream, and hashing up front would mean reading every file twice.

### Resilience

- Network change (Wi-Fi to 4G): the host tries an ICE restart. If that doesn't recover within
  15 s, the joiner reconnects as a new peer, is let back in without a second prompt (same tab),
  and resumes every download from the last byte written.
- No direct connection after 15 s: the joiner sees a clear message (strict NAT or firewall)
  with a retry button, not an endless spinner.
- If the host's signaling connection drops, existing transfers continue; the host reconnects
  and reclaims the same room id with a secret token.
- Screen Wake Lock while someone is connected (host) or downloading (joiner), plus a
  `beforeunload` warning before closing a tab that's mid-transfer.

### Security

- Room id: 96 random bits. Link key: 256 random bits (`crypto.getRandomValues`).
- Joiners prove they hold the key before the host is even asked: their `hello` is sealed with
  it. Wrong key means the server kicks them; the host never sees a prompt.
- Optional room password: the room key becomes PBKDF2-SHA256(password, salt = link key,
  600k iterations), so you need both the link and the password.
- Host approval per joiner (on by default), "Disconnect" per person, and optional
  auto-close after the first completed download. The room is gone when the host leaves.
- Strict CSP in production builds (`script-src 'self'`, no third-party code), `no-referrer`.
- Signaling server: 64 KB message cap, 200 messages per 10 s per socket, 30 sockets and
  60 new connections per minute per IP, 20 peers per room, idle sockets dropped after 30 s,
  heartbeat to clear dead hosts. `ALLOWED_ORIGINS` restricts which sites may connect.

## Deploy

**Option A: one Node process** (simplest). The signaling server also serves `web/dist`.

```bash
npm ci && npm run build
ALLOWED_ORIGINS=https://share.example.nl TRUST_PROXY=1 npm start
```

Put Caddy or nginx in front for TLS. Caddy is a two-liner:

```
share.example.nl {
  reverse_proxy localhost:8787
}
```

Or build the included `Dockerfile` and run it on a small VPS or Fly.io (behind TLS).

**Option B: static site + separate signaling.** Host `web/dist` on Cloudflare Pages or Netlify
(`_headers` and `_redirects` are included) and run the signaling server elsewhere:

```bash
VITE_SIGNALING_URL=wss://signal.example.nl/ws npm run build
```

Then add that origin to `connect-src` in `web/public/_headers`, and set
`ALLOWED_ORIGINS=https://share.example.nl` on the signaling server.

### Server environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port (`--port` overrides) |
| `HOST` | `0.0.0.0` | Listen address |
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated page origins allowed to open the WebSocket |
| `TRUST_PROXY` | off | Set to `1` behind a proxy so rate limits use `X-Forwarded-For` |
| `STATIC_DIR` | `../web/dist` | Built web app to serve; skipped if missing |

### Build-time variables (web)

See `web/.env.example`: `VITE_SIGNALING_URL` and `VITE_ICE_SERVERS` (add your own TURN relay
here if strict networks keep failing; note that bytes then pass through that relay, still
encrypted end to end).

## Project layout

```
signaling/server.js        rooms in memory, relay, limits, optional static hosting
signaling/test.js          smoke test for the room protocol
web/src/lib/engine/        transfer engine (framework-free)
  host.ts                  HostRoom: files, approvals, per-peer sender with backpressure
  join.ts                  JoinRoom: connection state machine, range requests, resume
  worker.ts                file reading + AES-GCM off the main thread
  crypto.ts protocol.ts    keys, sealing, frame format, message types
  sinks.ts                 File System Access / service-worker stream / Blob writers
web/src/lib/ui/            Svelte views (HostView, JoinView)
web/public/sw.js           streaming-download service worker
```

## Not built yet

From the plan's nice-to-haves: two-way rooms (joiner adds files) and resume across a page
reload (OPFS buffering). Resume after a dropped connection within the same page works.
