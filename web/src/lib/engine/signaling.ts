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

/** Thin WebSocket wrapper for talking to the signaling server. */
export class SignalingClient extends Emitter<Events> {
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
        reject(new Error('Could not reach the signaling server.'));
      }, timeoutMs);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (!opened) reject(new Error('Could not reach the signaling server.'));
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
