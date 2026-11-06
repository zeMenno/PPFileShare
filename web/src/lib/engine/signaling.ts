import { config } from './config';
import { RelaySignaling } from './relaySignaling';
import { Signaling, type ServerMsg } from './signalingBase';

export { Signaling, type ServerMsg };

/** `linkKey` keeps relay topics private to people holding the full link. */
export function createSignaling(linkKey: string): Signaling {
  return config.signalingMode === 'relay'
    ? new RelaySignaling(config.relayBrokers, linkKey)
    : new WsSignaling(config.signalingUrl);
}

const UNREACHABLE = 'Could not reach the signaling server.';

/** WebSocket transport (signaling/server.js). */
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
