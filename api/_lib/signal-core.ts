// Polling signaling for serverless hosts (Vercel). Same room protocol as the
// WebSocket server in signaling/server.js, but each client polls over HTTP and
// state lives in a small key-value store with short expiry times.
//
// Everything relayed here is already sealed with the room key by the browsers;
// this code only ever sees opaque ciphertext.

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  expire(key: string, ttlSec: number): Promise<void>;
  mget(keys: string[]): Promise<(string | null)[]>;
  /** Append to a list and refresh its expiry. */
  push(key: string, value: string, ttlSec: number): Promise<void>;
  /** Return and remove everything in a list. */
  drain(key: string): Promise<string[]>;
  hset(key: string, field: string, value: string, ttlSec: number): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  /** Increment a counter, setting its expiry when it is created. */
  incr(key: string, ttlSec: number): Promise<number>;
}

interface Sock {
  secret: string;
  role: 'host' | 'peer' | null;
  room: string | null;
  id: string | null;
  last: number;
}

interface Room {
  hostSid: string;
  token: string;
}

type Msg = Record<string, unknown> & { type: string };

export interface SignalResult {
  status: number;
  json: unknown;
}

/** A client that stops polling for this long is considered gone. */
const SOCK_TTL = 30;
const ROOM_TTL = 30;
const MAILBOX_TTL = 60;
const MAX_PEERS = 20;
const MAX_OPS = 60;
const NEW_SOCKETS_PER_IP_PER_MINUTE = 60;
const MIN_POLL_INTERVAL_MS = 150;

const ROOM_ID = /^[A-Za-z0-9_-]{10,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const SID = /^[A-Za-z0-9_-]{16,64}$/;

const k = {
  sock: (sid: string) => `pp:sock:${sid}`,
  mailbox: (sid: string) => `pp:mb:${sid}`,
  room: (room: string) => `pp:room:${room}`,
  peers: (room: string) => `pp:peers:${room}`,
  rate: (ip: string) => `pp:rl:${ip}:${Math.floor(Date.now() / 60_000)}`,
};

function randomId(bytes = 18): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const deliver = (store: Store, sid: string, msg: Msg) => store.push(k.mailbox(sid), JSON.stringify(msg), MAILBOX_TTL);

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function leave(store: Store, sid: string, st: Sock) {
  if (st.role === 'host' && st.room) {
    const room = parseJson<Room>(await store.get(k.room(st.room)));
    if (room?.hostSid === sid) {
      const peers = await store.hgetall(k.peers(st.room));
      await Promise.all(Object.values(peers).map((peerSid) => deliver(store, peerSid, { type: 'room-closed' })));
      await store.del(k.room(st.room), k.peers(st.room));
    }
  } else if (st.role === 'peer' && st.room && st.id) {
    await store.hdel(k.peers(st.room), st.id);
    const room = parseJson<Room>(await store.get(k.room(st.room)));
    if (room) await deliver(store, room.hostSid, { type: 'peer-left', id: st.id });
  }
  await store.del(k.sock(sid), k.mailbox(sid));
}

async function applyOp(store: Store, sid: string, st: Sock, op: Msg, out: Msg[]) {
  switch (op.type) {
    case 'create': {
      const roomId = String(op.room ?? '');
      const token = String(op.token ?? '');
      if (st.role || !ROOM_ID.test(roomId) || !TOKEN.test(token)) return out.push({ type: 'error', code: 'bad-request' });
      const existing = parseJson<Room>(await store.get(k.room(roomId)));
      if (existing && existing.token !== token) return out.push({ type: 'error', code: 'room-exists' });
      // Same token = the host reconnecting: take the room over from the old connection.
      if (existing && existing.hostSid !== sid) await store.del(k.sock(existing.hostSid));
      await store.set(k.room(roomId), JSON.stringify({ hostSid: sid, token } satisfies Room), ROOM_TTL);
      st.role = 'host';
      st.room = roomId;
      return out.push({ type: 'created' });
    }
    case 'join': {
      const roomId = String(op.room ?? '');
      if (st.role) return out.push({ type: 'error', code: 'bad-request' });
      const room = ROOM_ID.test(roomId) ? parseJson<Room>(await store.get(k.room(roomId))) : null;
      if (!room || !(await store.get(k.sock(room.hostSid)))) return out.push({ type: 'error', code: 'no-room' });
      const peers = await store.hgetall(k.peers(roomId));
      if (Object.keys(peers).length >= MAX_PEERS) return out.push({ type: 'error', code: 'room-full' });
      const id = `p${randomId(6)}`;
      await store.hset(k.peers(roomId), id, sid, ROOM_TTL);
      st.role = 'peer';
      st.room = roomId;
      st.id = id;
      out.push({ type: 'joined', id });
      return deliver(store, room.hostSid, { type: 'peer-joined', id });
    }
    case 'signal': {
      if (!st.room || op.data === undefined) return;
      if (st.role === 'host') {
        const peerSid = await store.hget(k.peers(st.room), String(op.to ?? ''));
        if (peerSid) await deliver(store, peerSid, { type: 'signal', from: 'host', data: op.data });
      } else if (st.role === 'peer') {
        const room = parseJson<Room>(await store.get(k.room(st.room)));
        if (room) await deliver(store, room.hostSid, { type: 'signal', from: st.id, data: op.data });
      }
      return;
    }
    case 'kick': {
      if (st.role !== 'host' || !st.room) return;
      const id = String(op.id ?? '');
      const peerSid = await store.hget(k.peers(st.room), id);
      if (!peerSid) return;
      const reason = typeof op.reason === 'string' ? op.reason.slice(0, 32) : 'denied';
      await deliver(store, peerSid, { type: 'kicked', reason });
      await store.hdel(k.peers(st.room), id);
      return out.push({ type: 'peer-left', id });
    }
    default:
      return out.push({ type: 'error', code: 'bad-request' });
  }
}

/**
 * One poll. Body: { sid?, secret?, ops?: Msg[], leave?: true }.
 * The first call (no sid) opens a "connection" and returns its sid + secret.
 */
export async function handleSignal(store: Store, body: unknown, ip: string): Promise<SignalResult> {
  if (!body || typeof body !== 'object') return { status: 400, json: { error: 'bad-request' } };
  const req = body as { sid?: unknown; secret?: unknown; ops?: unknown; leave?: unknown };
  const ops = (Array.isArray(req.ops) ? req.ops : [])
    .filter((o): o is Msg => !!o && typeof o === 'object' && typeof (o as Msg).type === 'string')
    .slice(0, MAX_OPS);

  let sid: string;
  let st: Sock;
  if (req.sid === undefined) {
    if (req.leave) return { status: 200, json: { ok: true } };
    const n = await store.incr(k.rate(ip), 70);
    if (n > NEW_SOCKETS_PER_IP_PER_MINUTE) return { status: 429, json: { error: 'rate-limited' } };
    sid = randomId();
    st = { secret: randomId(), role: null, room: null, id: null, last: 0 };
  } else {
    if (typeof req.sid !== 'string' || !SID.test(req.sid)) return { status: 400, json: { error: 'bad-request' } };
    sid = req.sid;
    const found = parseJson<Sock>(await store.get(k.sock(sid)));
    if (!found) return { status: 410, json: { error: 'gone' } };
    if (found.secret !== req.secret) return { status: 403, json: { error: 'forbidden' } };
    st = found;
    if (req.leave) {
      await leave(store, sid, st);
      return { status: 200, json: { ok: true } };
    }
    if (Date.now() - st.last < MIN_POLL_INTERVAL_MS) return { status: 429, json: { error: 'too-fast' } };
  }

  const out: Msg[] = [];
  for (const op of ops) await applyOp(store, sid, st, op, out);

  // Housekeeping: keep our records alive, and notice peers/hosts that vanished.
  if (st.role === 'host' && st.room) {
    const room = parseJson<Room>(await store.get(k.room(st.room)));
    if (!room || room.hostSid !== sid) {
      // Room expired or another connection took it over.
      await store.del(k.sock(sid), k.mailbox(sid));
      return { status: 410, json: { error: 'gone' } };
    }
    await store.expire(k.room(st.room), ROOM_TTL);
    await store.expire(k.peers(st.room), ROOM_TTL);
    const peers = await store.hgetall(k.peers(st.room));
    const ids = Object.keys(peers);
    if (ids.length) {
      const alive = await store.mget(ids.map((id) => k.sock(peers[id])));
      for (let i = 0; i < ids.length; i++) {
        if (alive[i]) continue;
        await store.hdel(k.peers(st.room), ids[i]);
        out.push({ type: 'peer-left', id: ids[i] });
      }
    }
  } else if (st.role === 'peer' && st.room) {
    const room = parseJson<Room>(await store.get(k.room(st.room)));
    if (!room) {
      out.push({ type: 'room-closed' });
      st.role = null;
      st.room = null;
    }
  }

  st.last = Date.now();
  await store.set(k.sock(sid), JSON.stringify(st), SOCK_TTL);
  const queued = (await store.drain(k.mailbox(sid))).map((m) => parseJson<Msg>(m)).filter((m): m is Msg => !!m);
  return { status: 200, json: { sid, secret: st.secret, messages: [...out, ...queued] } };
}

/** In-memory store for local development and tests (single process only). */
export function memoryStore(): Store {
  const data = new Map<string, { v: unknown; exp: number }>();
  const live = (key: string) => {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      data.delete(key);
      return undefined;
    }
    return e;
  };
  const put = (key: string, v: unknown, ttl: number) => data.set(key, { v, exp: Date.now() + ttl * 1000 });
  return {
    async get(key) {
      const e = live(key);
      return typeof e?.v === 'string' ? e.v : null;
    },
    async set(key, value, ttl) {
      put(key, value, ttl);
    },
    async del(...keys) {
      keys.forEach((key) => data.delete(key));
    },
    async expire(key, ttl) {
      const e = live(key);
      if (e) e.exp = Date.now() + ttl * 1000;
    },
    async mget(keys) {
      return keys.map((key) => {
        const e = live(key);
        return typeof e?.v === 'string' ? e.v : null;
      });
    },
    async push(key, value, ttl) {
      const e = live(key);
      const list = Array.isArray(e?.v) ? (e!.v as string[]) : [];
      list.push(value);
      put(key, list, ttl);
    },
    async drain(key) {
      const e = live(key);
      data.delete(key);
      return Array.isArray(e?.v) ? (e!.v as string[]) : [];
    },
    async hset(key, field, value, ttl) {
      const e = live(key);
      const h = e?.v instanceof Map ? (e.v as Map<string, string>) : new Map<string, string>();
      h.set(field, value);
      put(key, h, ttl);
    },
    async hget(key, field) {
      const e = live(key);
      return e?.v instanceof Map ? ((e.v as Map<string, string>).get(field) ?? null) : null;
    },
    async hdel(key, field) {
      const e = live(key);
      if (e?.v instanceof Map) (e.v as Map<string, string>).delete(field);
    },
    async hgetall(key) {
      const e = live(key);
      return e?.v instanceof Map ? Object.fromEntries(e.v as Map<string, string>) : {};
    },
    async incr(key, ttl) {
      const e = live(key);
      const n = (typeof e?.v === 'number' ? e.v : 0) + 1;
      if (e) e.v = n;
      else put(key, n, ttl);
      return n;
    },
  };
}
