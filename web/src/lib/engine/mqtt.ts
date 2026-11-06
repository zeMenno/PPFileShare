// Minimal MQTT 3.1.1 client over WebSocket: just enough to use public brokers as a
// message relay (CONNECT with last will, SUBSCRIBE, QoS 0 PUBLISH, keep-alive).
// No dependency, so nothing third-party runs on the page.

const enc = new TextEncoder();
const dec = new TextDecoder();

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGRESP = 13;

/** Generous keep-alive: hidden tabs may only run timers once a minute. */
const KEEPALIVE_S = 120;
const PING_EVERY_MS = 50_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_QUEUE = 200;

function withLength(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + bytes.length);
  out[0] = bytes.length >> 8;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

const str = (s: string) => withLength(enc.encode(s));

function packet(type: number, flags: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const lenBytes: number[] = [];
  let x = len;
  do {
    let digit = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) digit |= 0x80;
    lenBytes.push(digit);
  } while (x > 0);
  const out = new Uint8Array(1 + lenBytes.length + len);
  out[0] = (type << 4) | flags;
  out.set(lenBytes, 1);
  let o = 1 + lenBytes.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Will {
  topic: string;
  payload: Uint8Array;
}

/** One broker connection that reconnects by itself until closed. */
export class MqttConnection {
  connected = false;
  onMessage: (topic: string, payload: Uint8Array) => void = () => {};
  onReady: () => void = () => {};

  #ws: WebSocket | null = null;
  #buf = new Uint8Array(0);
  #ready = false;
  #closed = false;
  #retries = 0;
  #nextId = 1;
  #queue: Uint8Array<ArrayBuffer>[] = [];
  #pingTimer?: ReturnType<typeof setInterval>;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #connectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly url: string,
    private readonly clientId: string,
    private readonly topics: string[],
    private readonly will?: Will,
  ) {}

  start() {
    this.#open();
  }

  publish(topic: string, payload: Uint8Array) {
    const p = packet(PUBLISH, 0, str(topic), payload);
    if (this.#ready && this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(p);
    else {
      this.#queue.push(p);
      if (this.#queue.length > MAX_QUEUE) this.#queue.shift();
    }
  }

  close() {
    this.#closed = true;
    clearInterval(this.#pingTimer);
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#connectTimer);
    const ws = this.#ws;
    this.#ws = null;
    this.connected = this.#ready = false;
    if (ws?.readyState === WebSocket.OPEN) ws.send(Uint8Array.of(0xe0, 0)); // DISCONNECT: no last will
    ws?.close();
  }

  #open() {
    if (this.#closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch {
      return this.#scheduleRetry();
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    this.#buf = new Uint8Array(0);
    this.#connectTimer = setTimeout(() => ws.close(), CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      const flags = 0x02 | (this.will ? 0x04 : 0); // clean session, optional will (QoS 0, not retained)
      const parts = [str('MQTT'), Uint8Array.of(4, flags, KEEPALIVE_S >> 8, KEEPALIVE_S & 0xff), str(this.clientId)];
      if (this.will) parts.push(str(this.will.topic), withLength(this.will.payload));
      ws.send(packet(CONNECT, 0, ...parts));
    };
    ws.onmessage = (ev) => {
      if (this.#ws !== ws || !(ev.data instanceof ArrayBuffer)) return;
      this.#onData(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      clearTimeout(this.#connectTimer);
      clearInterval(this.#pingTimer);
      this.connected = this.#ready = false;
      this.#scheduleRetry();
    };
  }

  #scheduleRetry() {
    if (this.#closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.#retries++);
    this.#retryTimer = setTimeout(() => this.#open(), delay);
  }

  #onData(chunk: Uint8Array) {
    const buf = new Uint8Array(this.#buf.length + chunk.length);
    buf.set(this.#buf);
    buf.set(chunk, this.#buf.length);
    let off = 0;
    for (;;) {
      if (buf.length - off < 2) break;
      let len = 0;
      let mult = 1;
      let i = off + 1;
      let complete = false;
      for (let n = 0; n < 4 && i < buf.length; n++, i++) {
        len += (buf[i] & 0x7f) * mult;
        mult *= 128;
        if (!(buf[i] & 0x80)) {
          complete = true;
          i++;
          break;
        }
      }
      if (!complete || buf.length - i < len) break;
      this.#onPacket(buf[off], buf.subarray(i, i + len));
      off = i + len;
    }
    this.#buf = buf.slice(off);
  }

  #onPacket(first: number, body: Uint8Array) {
    const ws = this.#ws!;
    switch (first >> 4) {
      case CONNACK: {
        clearTimeout(this.#connectTimer);
        if (body[1] !== 0) return ws.close(); // refused
        this.connected = true;
        this.#retries = 0;
        this.#pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(Uint8Array.of(0xc0, 0)), PING_EVERY_MS);
        const id = this.#nextId++ & 0xffff || 1;
        const filters = this.topics.flatMap((t) => [str(t), Uint8Array.of(0)]);
        ws.send(packet(SUBSCRIBE, 0x02, Uint8Array.of(id >> 8, id & 0xff), ...filters));
        return;
      }
      case SUBACK: {
        if ([...body.subarray(2)].some((rc) => rc === 0x80)) return ws.close(); // broker refused a topic
        this.#ready = true;
        for (const p of this.#queue.splice(0)) ws.send(p);
        this.onReady();
        return;
      }
      case PUBLISH: {
        const qos = (first >> 1) & 3;
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        let o = 2 + tlen;
        if (qos > 0) {
          if (qos === 1) ws.send(packet(PUBACK, 0, body.subarray(o, o + 2)));
          o += 2;
        }
        this.onMessage(topic, body.subarray(o));
        return;
      }
      case PINGRESP:
        return;
    }
  }
}
