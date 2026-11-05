// Wire formats.
//
// Signaling relay (through the server, sealed with the room key):
//   joiner -> host: hello                 host -> joiner: welcome, offer, ice
//   joiner -> host: answer, ice
//
// Control channel "ctrl" (ordered, reliable; every message sealed with the room key):
//   host -> joiner: manifest, error, bye
//   joiner -> host: want, cancel, complete, finished
//
// Data channels "data0".."dataN" carry binary frames:
//   [u8 version][u8 0][u16 0][u32 fileId][u32 offsetHi][u32 offsetLo] [12-byte IV] [ciphertext+tag]
//   The 16-byte header is the AES-GCM additional data, so a chunk can't be moved or relabelled.
//
// The receiver drives everything by asking for byte ranges ("want"), which gives
// flow control, retry and resume after a reconnect for free.

export interface FileMeta {
  id: number;
  name: string;
  /** Relative path including the file name, e.g. "Photos/2024/a.jpg". */
  path: string;
  size: number;
  type: string;
  lastModified: number;
}

export type SignalMsg =
  | { t: 'hello'; clientId: string; name: string }
  | { t: 'welcome' }
  | { t: 'offer'; sdp: RTCSessionDescriptionInit }
  | { t: 'answer'; sdp: RTCSessionDescriptionInit }
  | { t: 'ice'; candidate: RTCIceCandidateInit };

export type HostMsg =
  | { t: 'manifest'; files: FileMeta[]; chunkSize: number }
  | { t: 'error'; file?: number; message: string }
  | { t: 'bye' };

export type PeerMsg =
  | { t: 'want'; file: number; from: number; to: number }
  | { t: 'cancel'; file: number }
  | { t: 'complete'; file: number }
  | { t: 'finished' };

export const FRAME_VERSION = 1;
export const HEADER_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const FRAME_OVERHEAD = HEADER_BYTES + IV_BYTES + TAG_BYTES;

export const aadSignal = (roomId: string) => `pp1:signal:${roomId}`;
export const AAD_HOST = 'pp1:ctrl:host';
export const AAD_PEER = 'pp1:ctrl:peer';

export function writeHeader(fileId: number, offset: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(HEADER_BYTES);
  const v = new DataView(h.buffer);
  v.setUint8(0, FRAME_VERSION);
  v.setUint32(4, fileId);
  v.setUint32(8, Math.floor(offset / 2 ** 32));
  v.setUint32(12, offset % 2 ** 32);
  return h;
}

export function readHeader(frame: Uint8Array): { fileId: number; offset: number } {
  const v = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
  if (v.getUint8(0) !== FRAME_VERSION) throw new Error('unknown frame version');
  return { fileId: v.getUint32(4), offset: v.getUint32(8) * 2 ** 32 + v.getUint32(12) };
}

/** Pick a chunk size that fits the negotiated SCTP max message size. */
export function chooseChunkSize(maxMessageSize: number | null | undefined, maxChunk: number, minChunk: number): number {
  const limit = maxMessageSize && Number.isFinite(maxMessageSize) && maxMessageSize > 0 ? maxMessageSize : 65536;
  const usable = Math.min(maxChunk, limit - FRAME_OVERHEAD);
  // Round down to a multiple of 16 KiB.
  return Math.max(minChunk, Math.floor(usable / 16384) * 16384);
}
