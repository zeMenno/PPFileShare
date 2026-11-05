import { config } from './config';
import { Emitter } from './emitter';

export type ServerMsg =
  | { type: 'created' }
  | { type: 'joined'; id: string }
  | { type: 'peer-joined'; id: string }
  | { type: 'peer-left'; id: string }
  | { type: 'signal'; from: string; data: { box: string } }
  | { type: 'kicked'; reason: string }
  | { type: 'room-closed' }
  | { type: 'error'; code: string };

type Events = { message: ServerMsg; close: { code: number } };

/**
 * Connection to the signaling service. Two transports speak the same protocol:
 * a WebSocket (self-hosted Node server) and HTTP polling (Vercel functions).
 */
export abstract class Signaling extends Emitter<Events> {
  abstract readonly isOpen: boolean;
  abstract connect(timeoutMs?: number): Promise<void>;
  abstract send(msg: Record<string, unknown>): void;
  abstract close(): void;
}

export function createSignaling(): Signaling {
  return config.signalingMode === 'http' ? new HttpSignaling(config.signalingHttpUrl) : new WsSignaling(config.signalingUrl);
}

const UNREACHABLE = 'Could not reach the signaling server.';

/** WebSocket transport. */
export class WsSignaling extends Signaling {
  #ws: WebSocket | null = null;
  #closedByUs = false;

  constructor(private readonly url: string) {
    super();
  }

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.#ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(UNREACHABLE));
      }, timeoutMs);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (!opened) reject(new Error(UNREACHABLE));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        this.emit('message', msg);
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (this.#ws === ws && opened && !this.#closedByUs) this.emit('close', { code: ev.code });
      };
    });
  }

  send(msg: Record<string, unknown>) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  close() {
    this.#closedByUs = true;
    this.#ws?.close();
    this.#ws = null;
  }
}

/** HTTP polling transport. The poll loop lives in a worker so hidden tabs keep polling. */
export class HttpSignaling extends Signaling {
  #worker: Worker | null = null;
  #open = false;
  #closedByUs = false;
  #session: { sid: string; secret: string } | null = null;

  constructor(private readonly url: string) {
    super();
  }

  get isOpen() {
    return this.#open;
  }

  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./signalWorker.ts', import.meta.url), { type: 'module' });
      this.#worker = worker;
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(UNREACHABLE));
      }, timeoutMs);
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'open') {
          clearTimeout(timer);
          this.#open = true;
          this.#session = { sid: m.sid, secret: m.secret };
          resolve();
        } else if (m.type === 'message') {
          this.emit('message', m.msg);
        } else if (m.type === 'error') {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(m.message || UNREACHABLE));
        } else if (m.type === 'closed') {
          const wasOpen = this.#open;
          this.#open = false;
          worker.terminate();
          if (wasOpen && !this.#closedByUs) this.emit('close', { code: 1006 });
        }
      };
      worker.postMessage({ type: 'start', url: new URL(this.url, location.href).href });
    });
  }

  send(msg: Record<string, unknown>) {
    if (this.#open) this.#worker?.postMessage({ type: 'send', msg });
  }

  close() {
    this.#closedByUs = true;
    this.#open = false;
    this.#worker?.terminate();
    this.#worker = null;
    // Tell the server right away (also works while the page is unloading).
    if (this.#session) {
      const body = JSON.stringify({ ...this.#session, leave: true });
      if (!navigator.sendBeacon?.(this.url, body)) {
        fetch(this.url, { method: 'POST', body, keepalive: true }).catch(() => {});
      }
      this.#session = null;
    }
  }
}
