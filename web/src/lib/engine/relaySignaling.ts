// Signaling through public MQTT brokers, for hosts without a server of their own
// (e.g. a static site on Vercel). The host's browser plays the part the room server
// plays in signaling/server.js; the brokers only pass messages along.
//
// What the brokers see: a topic derived from the room id AND the link key (so knowing
// the room URL alone isn't enough to find it), random peer ids, and the handshake
// payloads, which are already sealed with the room key.
//
// Topics, under base = hash(room id, link key):
//   base/h        host inbox:  join, signal, leave (peer's last will)
//   base/p/<id>   peer inbox:  joined, signal, kicked
//   base/x        room closed (host's last will, or an explicit close)

import { randomId, toB64u } from './crypto';
import { MqttConnection } from './mqtt';
import { Signaling, type ServerMsg } from './signalingBase';

const enc = new TextEncoder();
const dec = new TextDecoder();

const JOIN_TIMEOUT_MS = 12_000;
const CREATE_TIMEOUT_MS = 12_000;
const ID = /^[A-Za-z0-9_-]{6,32}$/;

type Wire = { type: string; mid: string; from?: string; id?: string; reason?: string; data?: unknown };

async function roomTopic(roomId: string, linkKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`ppfs1|${roomId}|${linkKey}`));
  return `ppfs1/${toB64u(new Uint8Array(digest)).slice(0, 32)}`;
}

export class RelaySignaling extends Signaling {
  #conns: MqttConnection[] = [];
  #base = '';
  #role: 'host' | 'peer' | null = null;
  #me = '';
  #peers = new Set<string>();
  #seen = new Set<string>();
  #chain: Promise<unknown> = Promise.resolve();
  #open = false;
  #joined = false;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly brokers: string[],
    private readonly linkKey: string,
  ) {
    super();
  }

  get isOpen() {
    return this.#open && (this.#conns.length === 0 || this.#conns.some((c) => c.connected));
  }

  /** Broker connections start on create/join, once we know which last will to leave. */
  async connect(): Promise<void> {
    if (!this.brokers.length) throw new Error('No signaling relays configured.');
    this.#open = true;
  }

  send(msg: Record<string, unknown>) {
    this.#chain = this.#chain.then(() => this.#op(msg)).catch((e) => console.warn('relay signaling', e));
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    clearTimeout(this.#timer);
    if (this.#role === 'host') this.#publish(`${this.#base}/x`, { type: 'room-closed' });
    else if (this.#role === 'peer') this.#publish(`${this.#base}/h`, { type: 'leave', from: this.#me });
    for (const c of this.#conns) c.close();
    this.#conns = [];
  }

  // ---------------------------------------------------------------- outgoing

  async #op(msg: Record<string, unknown>) {
    if (!this.#open) return;
    switch (msg.type) {
      case 'create': {
        this.#base = await roomTopic(String(msg.room), this.linkKey);
        this.#role = 'host';
        let created = false;
        this.#timer = setTimeout(() => {
          if (!created) this.#emit({ type: 'error', code: 'unreachable' });
        }, CREATE_TIMEOUT_MS);
        this.#start([`${this.#base}/h`], `${this.#base}/x`, { type: 'room-closed' }, () => {
          if (created) return;
          created = true;
          clearTimeout(this.#timer);
          this.#emit({ type: 'created' });
        });
        return;
      }
      case 'join': {
        this.#base = await roomTopic(String(msg.room), this.linkKey);
        this.#role = 'peer';
        this.#me = randomId(9);
        this.#start([`${this.#base}/p/${this.#me}`, `${this.#base}/x`], `${this.#base}/h`, { type: 'leave', from: this.#me });
        // Queued per broker and sent once that broker has our inbox subscribed.
        this.#publish(`${this.#base}/h`, { type: 'join', from: this.#me });
        this.#timer = setTimeout(() => {
          if (!this.#joined) this.#emit({ type: 'error', code: 'no-room' });
        }, JOIN_TIMEOUT_MS);
        return;
      }
      case 'signal':
        if (this.#role === 'host' && typeof msg.to === 'string' && this.#peers.has(msg.to)) {
          this.#publish(`${this.#base}/p/${msg.to}`, { type: 'signal', from: 'host', data: msg.data });
        } else if (this.#role === 'peer') {
          this.#publish(`${this.#base}/h`, { type: 'signal', from: this.#me, data: msg.data });
        }
        return;
      case 'kick':
        if (this.#role !== 'host' || typeof msg.id !== 'string') return;
        this.#publish(`${this.#base}/p/${msg.id}`, { type: 'kicked', reason: String(msg.reason ?? 'denied') });
        this.#peers.delete(msg.id);
        return;
    }
  }

  #start(topics: string[], willTopic: string, will: Record<string, unknown>, onReady?: () => void) {
    const willPayload = enc.encode(JSON.stringify({ ...will, mid: randomId(8) }));
    this.#conns = this.brokers.map((url) => {
      const c = new MqttConnection(url, `ppfs_${randomId(9)}`, topics, { topic: willTopic, payload: willPayload });
      c.onMessage = (topic, payload) => this.#onMessage(topic, payload);
      if (onReady) c.onReady = onReady;
      c.start();
      return c;
    });
  }

  #publish(topic: string, body: Record<string, unknown>) {
    const payload = enc.encode(JSON.stringify({ ...body, mid: randomId(8) }));
    for (const c of this.#conns) c.publish(topic, payload);
  }

  // ---------------------------------------------------------------- incoming

  #emit(msg: ServerMsg) {
    if (this.#open) this.emit('message', msg);
  }

  #onMessage(topic: string, payload: Uint8Array) {
    if (payload.length > 64 * 1024) return;
    let m: Wire;
    try {
      m = JSON.parse(dec.decode(payload));
    } catch {
      return;
    }
    if (!m || typeof m.type !== 'string' || typeof m.mid !== 'string') return;
    // Every message arrives once per broker; handle it once.
    if (this.#seen.has(m.mid)) return;
    this.#seen.add(m.mid);
    if (this.#seen.size > 2000) this.#seen = new Set([...this.#seen].slice(-1000));

    if (this.#role === 'host' && topic === `${this.#base}/h`) {
      const from = m.from;
      if (typeof from !== 'string' || !ID.test(from)) return;
      if (m.type === 'join') {
        if (!this.#peers.has(from)) {
          this.#peers.add(from);
          this.#emit({ type: 'peer-joined', id: from });
        }
        this.#publish(`${this.#base}/p/${from}`, { type: 'joined', id: from });
      } else if (m.type === 'signal' && this.#peers.has(from)) {
        this.#emit({ type: 'signal', from, data: m.data as { box: string } });
      } else if (m.type === 'leave' && this.#peers.delete(from)) {
        this.#emit({ type: 'peer-left', id: from });
      }
    } else if (this.#role === 'peer') {
      if (topic === `${this.#base}/x`) {
        if (m.type === 'room-closed') this.#emit({ type: 'room-closed' });
        return;
      }
      if (topic !== `${this.#base}/p/${this.#me}`) return;
      if (m.type === 'joined' && !this.#joined) {
        this.#joined = true;
        clearTimeout(this.#timer);
        this.#emit({ type: 'joined', id: this.#me });
      } else if (m.type === 'signal') {
        this.#emit({ type: 'signal', from: 'host', data: m.data as { box: string } });
      } else if (m.type === 'kicked') {
        this.#emit({ type: 'kicked', reason: String(m.reason ?? 'denied').slice(0, 32) });
      }
    }
  }
}
