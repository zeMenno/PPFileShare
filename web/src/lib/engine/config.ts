// Runtime configuration. Override with VITE_* variables at build time (see README).

function iceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn('VITE_ICE_SERVERS is not valid JSON, using the default STUN server');
    }
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

function signalingUrl(): string {
  const fromEnv = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export const config = {
  iceServers: iceServers(),
  signalingUrl: signalingUrl(),
  /** Give up on a direct connection after this long and say so. */
  connectTimeoutMs: 15_000,
  /** Largest chunk we ever send; the real size also respects the SCTP max message size. */
  maxChunkSize: 256 * 1024,
  minChunkSize: 16 * 1024,
  /** Number of parallel binary data channels per peer. */
  dataChannels: 3,
  /** Per-channel send buffer limits (backpressure). */
  bufferHigh: 4 * 1024 * 1024,
  bufferLow: 1024 * 1024,
  /** Encrypt jobs in flight per peer (reading + encrypting in the worker). */
  maxInflight: 8,
  /** Bytes a receiver may have requested but not yet written, per file. */
  receiveWindow: 8 * 1024 * 1024,
  /** Files downloaded at the same time by one joiner. */
  parallelFiles: 3,
  /** Below this size we assemble the file in memory instead of streaming it to disk. */
  blobLimit: 200 * 1024 * 1024,
};
