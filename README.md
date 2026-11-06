# P2P File Share

A personal, browser-only file share, plus a watch-together mode. Open a room, drop files in
(or pick a video), share the link, and whoever opens it connects straight to your browser.
No accounts, no uploads. The server only introduces the browsers to each other.

- **Share files:** joiners download directly from your tab.
- **Watch together:** you pick a video file (or share a tab/screen); it plays for everyone
  live over WebRTC, with sound. Anyone can play, pause and seek, and there's a chat. Viewers
  don't need the file.

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

Open http://localhost:5173, click **Share files** or **Watch together**, then open the link in
another tab or browser. `npm run dev` starts the signaling server on :8787 and Vite on :5173
(Vite proxies `/ws`). `npm run dev:relay` runs only Vite and signals through the public MQTT
relays, exactly like the Vercel deployment.

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

- **Signaling vs. STUN.** Browsers find their public address with Google's public STUN server
  (`stun:stun.l.google.com:19302`, override with `VITE_ICE_SERVERS`). STUN never carries
  messages between browsers, so the handshake itself goes through signaling: our Node server, or
  public MQTT relays on static hosting.
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

### Watch together

- The host's `<video>` plays the chosen file locally; `captureStream()` turns it into live
  video and audio tracks, which go to every viewer over their own RTCPeerConnection. Sharing a
  tab or screen uses `getDisplayMedia()` instead.
- Each connection has fixed send-only video and audio slots, so switching videos or
  starting/stopping screen sharing is a `replaceTrack`, with no renegotiation.
- Bitrate caps are raised to 8 Mbit/s video and 256 kbit/s stereo Opus (the viewer's answer asks
  for stereo); WebRTC still adapts down on slow links.
- Play, pause and seek from a viewer go to the host over the encrypted control channel; the host
  applies them to its player and broadcasts the new position. Viewers extrapolate the position
  between updates for their progress bar. Chat goes through the host the same way.
- Media is DTLS-SRTP encrypted between the browsers. The DTLS fingerprints travel inside
  signaling messages sealed with the room key, so the signaling server can't swap them and
  sit in the middle.
- Limits: the host needs Chrome, Edge or Firefox (Safari can't capture a video element); viewers
  can use any modern browser. Each viewer gets their own encoded stream, so a laptop host is
  comfortable with a handful of viewers, not dozens. Keep the host tab visible: some browsers
  slow down video decoding in background tabs.

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

**On Vercel (static site, no server of your own).** Vercel can't run the WebSocket server, so
builds there use *relay signaling*: the browsers exchange the handshake through free public MQTT
brokers (EMQX and HiveMQ, both at once for redundancy). Nothing else is needed: no functions,
no database, no environment variables. Import the GitHub repo in Vercel (or `vercel link` +
`vercel deploy --prod`); `vercel.json` sets the build, output folder, room-link rewrite and
security headers.

What the brokers see: a topic name derived from the room id *and* the link key (so the room URL
alone, e.g. from access logs, doesn't reveal it), random peer ids, and handshake payloads that
are already sealed with the room key. They never see file names, keys or content. The host's
browser plays the room-server role (tracking joins), and a broker "last will" message tells
joiners when the host's tab disappears. To use other brokers, set `VITE_RELAY_BROKERS` (comma
separated `wss://` URLs) and update `connect-src` in `vercel.json`. To build any static
deployment this way, set `VITE_SIGNALING_MODE=relay`.

**Option A: one Node process** (simplest self-hosting). The signaling server also serves `web/dist`.

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
signaling/server.js        WebSocket signaling: rooms in memory, limits, optional static hosting
signaling/test.js          smoke test for the room protocol
web/src/lib/engine/        transfer engine (framework-free)
  host.ts                  HostRoom: files, media tracks, approvals, per-peer sender
  join.ts                  JoinRoom: connection state machine, range requests, resume, media
  signaling.ts             transport choice + WebSocket transport
  relaySignaling.ts mqtt.ts  relay transport over public MQTT brokers (tiny MQTT client)
  worker.ts                file reading + AES-GCM off the main thread
  crypto.ts protocol.ts    keys, sealing, frame format, message types
  sinks.ts                 File System Access / service-worker stream / Blob writers
web/src/lib/ui/            Svelte views (HostView, JoinView, WatchHost, WatchView, Chat)
web/public/sw.js           streaming-download service worker
```

## Not built yet

From the plan's nice-to-haves: two-way rooms (joiner adds files) and resume across a page
reload (OPFS buffering). Resume after a dropped connection within the same page works.
For watch-together: subtitles, and a relay (SFU) for larger audiences.
