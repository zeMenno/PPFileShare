// Signaling server: introduces browsers to each other, then gets out of the way.
// Rooms live in memory only. A room disappears the moment its host disconnects.
// Everything relayed between peers is encrypted by the browsers, so this server
// never sees file names, SDP or ICE candidates in the clear.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const portArg = process.argv.indexOf('--port');
const PORT = Number((portArg > 0 && process.argv[portArg + 1]) || process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Comma-separated list of allowed page origins, e.g. "https://share.example.nl".
// Empty means any origin may connect (fine for local development).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const STATIC_DIR = resolve(process.env.STATIC_DIR || fileURLToPath(new URL('../web/dist', import.meta.url)));

const LIMITS = {
  maxPayload: 64 * 1024, // bytes per message
  maxPeersPerRoom: 20,
  maxSocketsPerIp: 30,
  newSocketsPerIpPerMinute: 60,
  messagesPerSocketPer10s: 200,
  helloTimeoutMs: 30_000, // a socket must create or join a room within this time
};

const ROOM_ID = /^[A-Za-z0-9_-]{10,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** @type {Map<string, {host: import('ws').WebSocket, token: string, peers: Map<string, import('ws').WebSocket>}>} */
const rooms = new Map();
/** @type {Map<string, {open: number, recent: number[]}>} */
const ipStats = new Map();

let nextPeer = 1;
const newPeerId = () => `p${(nextPeer++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function admitIp(ip) {
  const now = Date.now();
  const s = ipStats.get(ip) || { open: 0, recent: [] };
  s.recent = s.recent.filter((t) => now - t < 60_000);
  if (s.open >= LIMITS.maxSocketsPerIp || s.recent.length >= LIMITS.newSocketsPerIpPerMinute) return false;
  s.open++;
  s.recent.push(now);
  ipStats.set(ip, s);
  return true;
}

function releaseIp(ip) {
  const s = ipStats.get(ip);
  if (!s) return;
  s.open--;
  if (s.open <= 0 && s.recent.length === 0) ipStats.delete(ip);
}

// Drop idle IP entries once a minute so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of ipStats) {
    s.recent = s.recent.filter((t) => now - t < 60_000);
    if (s.open <= 0 && s.recent.length === 0) ipStats.delete(ip);
  }
}, 60_000).unref();

function closeRoom(roomId, room) {
  rooms.delete(roomId);
  for (const peer of room.peers.values()) {
    send(peer, { type: 'room-closed' });
    peer.close(1000, 'room closed');
  }
}

function onMessage(ws, msg) {
  const st = ws.state;
  switch (msg.type) {
    case 'create': {
      if (st.role) return send(ws, { type: 'error', code: 'bad-request' });
      if (!ROOM_ID.test(msg.room) || !TOKEN.test(msg.token)) return send(ws, { type: 'error', code: 'bad-request' });
      const existing = rooms.get(msg.room);
      if (existing) {
        // The host may reconnect after a network blip before we noticed the old socket died.
        if (existing.token !== msg.token) return send(ws, { type: 'error', code: 'room-exists' });
        existing.host.state.role = null;
        existing.host.close(1000, 'replaced');
        existing.host = ws;
      } else {
        rooms.set(msg.room, { host: ws, token: msg.token, peers: new Map() });
      }
      st.role = 'host';
      st.room = msg.room;
      return send(ws, { type: 'created' });
    }
    case 'join': {
      if (st.role) return send(ws, { type: 'error', code: 'bad-request' });
      const room = ROOM_ID.test(msg.room) ? rooms.get(msg.room) : undefined;
      if (!room) return send(ws, { type: 'error', code: 'no-room' });
      if (room.peers.size >= LIMITS.maxPeersPerRoom) return send(ws, { type: 'error', code: 'room-full' });
      st.role = 'peer';
      st.room = msg.room;
      st.id = newPeerId();
      room.peers.set(st.id, ws);
      send(ws, { type: 'joined', id: st.id });
      return send(room.host, { type: 'peer-joined', id: st.id });
    }
    case 'signal': {
      const room = rooms.get(st.room);
      if (!room || msg.data === undefined) return;
      if (st.role === 'host') {
        const peer = room.peers.get(msg.to);
        if (peer) send(peer, { type: 'signal', from: 'host', data: msg.data });
      } else if (st.role === 'peer') {
        send(room.host, { type: 'signal', from: st.id, data: msg.data });
      }
      return;
    }
    case 'kick': {
      if (st.role !== 'host') return;
      const room = rooms.get(st.room);
      const peer = room?.peers.get(msg.id);
      if (!peer) return;
      send(peer, { type: 'kicked', reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 32) : 'denied' });
      peer.close(1000, 'kicked');
      return;
    }
    default:
      return send(ws, { type: 'error', code: 'bad-request' });
  }
}

function onClose(ws) {
  const st = ws.state;
  releaseIp(st.ip);
  clearTimeout(st.helloTimer);
  const room = st.room && rooms.get(st.room);
  if (!room) return;
  if (st.role === 'host' && room.host === ws) {
    closeRoom(st.room, room);
  } else if (st.role === 'peer' && room.peers.get(st.id) === ws) {
    room.peers.delete(st.id);
    send(room.host, { type: 'peer-left', id: st.id });
  }
}

// ---- Static files (optional): serve the built web app from the same process ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // The full policy is a <meta> tag in index.html; frame-ancestors only works as a header.
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://x');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname.startsWith('/r/')) pathname = '/index.html';
  const filePath = normalize(join(STATIC_DIR, pathname));
  if (!filePath.startsWith(STATIC_DIR + sep)) {
    res.writeHead(400).end();
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const headers = { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' };
    if (pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    else headers['Cache-Control'] = 'no-cache';
    if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const serveFiles = existsSync(join(STATIC_DIR, 'index.html'));

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (serveFiles && (req.method === 'GET' || req.method === 'HEAD')) {
    serveStatic(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Signaling server. Connect with a WebSocket to /ws.');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x');
  const origin = req.headers.origin || '';
  const ip = clientIp(req);
  if (url.pathname !== '/ws' || (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin))) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  if (!admitIp(ip)) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.state = { ip, role: null, room: null, id: null, alive: true, msgTimes: [] };
    ws.state.helloTimer = setTimeout(() => {
      if (!ws.state.role) ws.close(1008, 'idle');
    }, LIMITS.helloTimeoutMs);
    ws.on('pong', () => (ws.state.alive = true));
    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      const times = ws.state.msgTimes.filter((t) => now - t < 10_000);
      times.push(now);
      ws.state.msgTimes = times;
      if (times.length > LIMITS.messagesPerSocketPer10s) {
        ws.close(1008, 'rate limit');
        return;
      }
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') onMessage(ws, msg);
    });
    ws.on('close', () => onClose(ws));
    ws.on('error', () => {});
  });
});

// Heartbeat: drop sockets that stopped answering, so dead hosts free their rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.state.alive) {
      ws.terminate();
      continue;
    }
    ws.state.alive = false;
    ws.ping();
  }
}, 15_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`signaling listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (ws path /ws)`);
  if (serveFiles) console.log(`serving web app from ${STATIC_DIR}`);
});
