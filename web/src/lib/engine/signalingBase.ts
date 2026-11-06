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
 * a WebSocket to our own Node server, or public MQTT brokers used as relays.
 */
export abstract class Signaling extends Emitter<Events> {
  abstract readonly isOpen: boolean;
  abstract connect(timeoutMs?: number): Promise<void>;
  abstract send(msg: Record<string, unknown>): void;
  abstract close(): void;
}
