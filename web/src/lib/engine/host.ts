// Host side: owns the room, keeps references to the shared files and streams
// encrypted chunks to every approved joiner, each over its own RTCPeerConnection.

import { config } from './config';
import { deriveRoomKey, fromB64u, newLinkKey, openJson, randomId, sealJson, toB64u, type Bytes } from './crypto';
import { CryptoWorker } from './cryptoWorker';
import { Observable } from './emitter';
import {
  AAD_HOST,
  AAD_PEER,
  aadSignal,
  chooseChunkSize,
  type FileMeta,
  type HostMsg,
  type PeerMsg,
  type SignalMsg,
} from './protocol';
import { SignalingClient, type ServerMsg } from './signaling';
import { SpeedMeter } from './speed';

export interface HostOptions {
  password?: string;
  requireApproval: boolean;
  closeAfterFirstDownload: boolean;
}

export interface FileInput {
  file: File;
  /** Relative path including the name, e.g. "Holiday/day1/a.jpg". */
  path?: string;
}

export type PeerStatus = 'verifying' | 'pending' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface PeerTransfer {
  fileId: number;
  name: string;
  size: number;
  sent: number;
  complete: boolean;
}

export interface PeerSnapshot {
  id: string;
  name: string;
  status: PeerStatus;
  error?: string;
  transfers: PeerTransfer[];
  speed: number;
  sending: boolean;
}

export type RoomStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface HostSnapshot {
  roomId: string;
  link: string;
  status: RoomStatus;
  closedReason?: string;
  files: FileMeta[];
  totalSize: number;
  peers: PeerSnapshot[];
  hasPassword: boolean;
  options: HostOptions;
  transferring: boolean;
}

interface SharedFile {
  meta: FileMeta;
  file: File;
}

interface Range {
  fileId: number;
  from: number;
  to: number;
}

const HELLO_TIMEOUT_MS = 20_000;
const GIVE_UP_AFTER_DROP_MS = 30_000;

export function cleanPath(path: string, fallback: string): string {
  const parts = path
    .split(/[\\/]+/)
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.length ? parts.join('/') : fallback;
}

export class HostRoom extends Observable<HostSnapshot> {
  readonly roomId: string;
  readonly link: string;
  readonly key: CryptoKey;
  readonly worker = new CryptoWorker();
  readonly files = new Map<number, SharedFile>();

  #options: HostOptions;
  #token = randomId(16);
  #sig: SignalingClient | null = null;
  #status: RoomStatus = 'connecting';
  #closedReason?: string;
  #peers = new Map<string, HostPeer>();
  #approvedClients = new Set<string>();
  #nextFileId = 1;
  #reconnectDelay = 1000;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #pendingCreate: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Pre-sealed "bye" so we can still send it synchronously while the page unloads. */
  byeFrame: Bytes | null = null;

  static async create(options: HostOptions): Promise<HostRoom> {
    const linkKey = newLinkKey();
    const key = await deriveRoomKey(linkKey, options.password || undefined);
    const room = new HostRoom(randomId(12), linkKey, key, options);
    try {
      await room.#init();
    } catch (e) {
      room.close();
      throw e;
    }
    return room;
  }

  private constructor(roomId: string, linkKey: string, key: CryptoKey, options: HostOptions) {
    super();
    this.roomId = roomId;
    this.key = key;
    this.#options = { ...options };
    const frag = `k=${linkKey}${options.password ? '&p=1' : ''}`;
    this.link = `${location.origin}/r/${roomId}#${frag}`;
  }

  async #init() {
    await this.worker.init(this.key);
    this.byeFrame = await sealJson(this.key, { t: 'bye' } satisfies HostMsg, AAD_HOST);
    await this.#connectSignaling();
  }

  // ---------------------------------------------------------------- snapshot

  snapshot(): HostSnapshot {
    const files = [...this.files.values()].map((f) => f.meta);
    const peers = [...this.#peers.values()].map((p) => p.snapshot());
    return {
      roomId: this.roomId,
      link: this.link,
      status: this.#status,
      closedReason: this.#closedReason,
      files,
      totalSize: files.reduce((n, f) => n + f.size, 0),
      peers,
      hasPassword: !!this.#options.password,
      options: { ...this.#options, password: undefined },
      transferring: [...this.#peers.values()].some((p) => p.isSending),
    };
  }

  /** Lets peers ask for a UI refresh. */
  notify() {
    this.changed();
  }

  // ---------------------------------------------------------------- files

  addFiles(inputs: FileInput[]) {
    if (this.#status === 'closed') return;
    let added = 0;
    for (const { file, path } of inputs) {
      const clean = cleanPath(path || file.name, file.name || 'file');
      const dup = [...this.files.values()].some(
        (f) => f.meta.path === clean && f.meta.size === file.size && f.meta.lastModified === file.lastModified,
      );
      if (dup) continue;
      const id = this.#nextFileId++;
      this.files.set(id, {
        file,
        meta: { id, name: clean.split('/').pop()!, path: clean, size: file.size, type: file.type, lastModified: file.lastModified },
      });
      added++;
    }
    if (added) this.#manifestChanged();
  }

  removeFile(id: number) {
    if (!this.files.delete(id)) return;
    for (const p of this.#peers.values()) p.dropFile(id);
    this.#manifestChanged();
  }

  #manifestChanged() {
    for (const p of this.#peers.values()) p.sendManifest();
    this.changed();
  }

  // ---------------------------------------------------------------- options

  setOption<K extends 'requireApproval' | 'closeAfterFirstDownload'>(name: K, value: HostOptions[K]) {
    this.#options[name] = value;
    this.changed();
  }

  // ---------------------------------------------------------------- joiners

  approve(peerId: string) {
    const peer = this.#peers.get(peerId);
    if (!peer || peer.status !== 'pending') return;
    this.#admit(peer);
  }

  deny(peerId: string) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    this.#sig?.send({ type: 'kick', id: peerId, reason: 'denied' });
    this.removePeer(peer);
  }

  /** Disconnect a joiner at any point. */
  disconnect(peerId: string) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    if (peer.clientId) this.#approvedClients.delete(peer.clientId);
    peer.sendBye();
    this.#sig?.send({ type: 'kick', id: peerId, reason: 'denied' });
    setTimeout(() => this.removePeer(peer), 300);
  }

  #admit(peer: HostPeer) {
    if (peer.clientId) this.#approvedClients.add(peer.clientId);
    this.sendSignal(peer.id, { t: 'welcome' });
    peer.start();
    this.changed();
  }

  removePeer(peer: HostPeer) {
    peer.dispose();
    this.#peers.delete(peer.id);
    this.changed();
  }

  peerFinished() {
    if (this.#options.closeAfterFirstDownload && this.#status !== 'closed') {
      setTimeout(() => this.close('Closed automatically after the first download.'), 1500);
    }
  }

  // ---------------------------------------------------------------- signaling

  async #connectSignaling() {
    const sig = new SignalingClient(config.signalingUrl);
    sig.on('message', (m) => this.#onServer(m));
    sig.on('close', () => this.#onSignalingLost(sig));
    await sig.connect();
    if (this.#status === 'closed') {
      sig.close();
      return;
    }
    this.#sig = sig;
    await new Promise<void>((resolve, reject) => {
      this.#pendingCreate = { resolve, reject };
      sig.send({ type: 'create', room: this.roomId, token: this.#token });
    });
    this.#status = 'open';
    this.#reconnectDelay = 1000;
    this.changed();
  }

  #onSignalingLost(sig: SignalingClient) {
    if (this.#sig !== sig || this.#status === 'closed') return;
    this.#sig = null;
    this.#status = 'reconnecting';
    // Joiners that weren't connected yet lost their signaling path; connected ones keep going.
    for (const p of [...this.#peers.values()]) if (!p.isLive) this.removePeer(p);
    this.changed();
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(async () => {
      if (this.#status === 'closed') return;
      try {
        await this.#connectSignaling();
      } catch {
        this.#sig?.close();
        this.#sig = null;
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 15_000);
        this.#scheduleReconnect();
      }
    }, this.#reconnectDelay);
  }

  sendSignal(peerId: string, msg: SignalMsg) {
    const sig = this.#sig;
    if (!sig) return;
    sealJson(this.key, msg, aadSignal(this.roomId)).then((box) => {
      sig.send({ type: 'signal', to: peerId, data: { box: toB64u(box) } });
    });
  }

  get canSignal() {
    return !!this.#sig?.isOpen;
  }

  #onServer(m: ServerMsg) {
    switch (m.type) {
      case 'created':
        this.#pendingCreate?.resolve();
        this.#pendingCreate = null;
        return;
      case 'error':
        if (this.#pendingCreate) {
          this.#pendingCreate.reject(new Error(`Could not open the room (${m.code}).`));
          this.#pendingCreate = null;
        }
        return;
      case 'peer-joined': {
        const peer = new HostPeer(this, m.id);
        this.#peers.set(m.id, peer);
        peer.helloTimer = setTimeout(() => {
          if (peer.status === 'verifying') {
            this.#sig?.send({ type: 'kick', id: m.id, reason: 'timeout' });
            this.removePeer(peer);
          }
        }, HELLO_TIMEOUT_MS);
        return;
      }
      case 'peer-left': {
        const peer = this.#peers.get(m.id);
        if (!peer) return;
        if (peer.isLive) peer.signalingGone = true;
        else this.removePeer(peer);
        return;
      }
      case 'signal':
        this.#onSignal(m.from, m.data?.box);
        return;
    }
  }

  async #onSignal(from: string, box: unknown) {
    const peer = this.#peers.get(from);
    if (!peer || typeof box !== 'string') return;
    let msg: SignalMsg;
    try {
      msg = await openJson<SignalMsg>(this.key, fromB64u(box), aadSignal(this.roomId));
    } catch {
      // Doesn't hold the key (or the password is wrong): never let them in.
      if (peer.status === 'verifying') {
        this.#sig?.send({ type: 'kick', id: from, reason: 'bad-key' });
        this.removePeer(peer);
      }
      return;
    }
    switch (msg.t) {
      case 'hello': {
        if (peer.status !== 'verifying') return;
        clearTimeout(peer.helloTimer);
        peer.clientId = String(msg.clientId || '').slice(0, 64);
        peer.name = String(msg.name || 'Someone').replace(/[\u0000-\u001f]/g, '').slice(0, 48) || 'Someone';
        if (!this.#options.requireApproval || this.#approvedClients.has(peer.clientId)) {
          this.#admit(peer);
        } else {
          peer.status = 'pending';
          this.emit('change', this.snapshot());
        }
        return;
      }
      case 'answer':
        peer.onAnswer(msg.sdp);
        return;
      case 'ice':
        peer.onRemoteIce(msg.candidate);
        return;
    }
  }

  // ---------------------------------------------------------------- closing

  /** Best effort goodbye for when the tab is closing; must stay synchronous. */
  sayGoodbye() {
    for (const p of this.#peers.values()) p.sendBye();
  }

  close(reason = 'You closed the room.') {
    if (this.#status === 'closed') return;
    this.#status = 'closed';
    this.#closedReason = reason;
    clearTimeout(this.#reconnectTimer);
    this.sayGoodbye();
    const peers = [...this.#peers.values()];
    // Give the goodbye a moment to leave before tearing the connections down.
    setTimeout(() => {
      for (const p of peers) p.dispose();
      this.worker.terminate();
    }, 500);
    this.#peers.clear();
    this.#sig?.close();
    this.#sig = null;
    this.emit('change', this.snapshot());
  }
}

/** One joiner, as seen by the host. */
class HostPeer {
  name = 'Someone';
  clientId = '';
  status: PeerStatus = 'verifying';
  error?: string;
  helloTimer?: ReturnType<typeof setTimeout>;
  signalingGone = false;

  #pc: RTCPeerConnection | null = null;
  #ctrl: RTCDataChannel | null = null;
  #data: RTCDataChannel[] = [];
  #queuedIce: RTCIceCandidateInit[] = [];
  #chunkSize = 64 * 1024;
  #queue: Range[] = [];
  #inflight = 0;
  #transfers = new Map<number, PeerTransfer>();
  #speed = new SpeedMeter();
  #ctrlChain: Promise<unknown> = Promise.resolve();
  #connectTimer?: ReturnType<typeof setTimeout>;
  #dropTimer?: ReturnType<typeof setTimeout>;
  #restartTimer?: ReturnType<typeof setTimeout>;
  #disposed = false;

  constructor(
    private readonly room: HostRoom,
    readonly id: string,
  ) {}

  get isLive() {
    return this.status === 'connected' || this.status === 'reconnecting';
  }

  get isSending() {
    return this.#queue.length > 0 || this.#inflight > 0;
  }

  snapshot(): PeerSnapshot {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      error: this.error,
      transfers: [...this.#transfers.values()].map((t) => ({ ...t })),
      speed: this.#speed.rate(),
      sending: this.isSending,
    };
  }

  start() {
    this.status = 'connecting';
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    this.#pc = pc;

    const ctrl = pc.createDataChannel('ctrl', { ordered: true });
    ctrl.binaryType = 'arraybuffer';
    ctrl.onopen = () => this.#onCtrlOpen();
    ctrl.onmessage = (ev) => this.#onCtrlMessage(ev.data);
    ctrl.onclose = () => this.#onCtrlClose();
    this.#ctrl = ctrl;

    for (let i = 0; i < config.dataChannels; i++) {
      const dc = pc.createDataChannel(`data${i}`, { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = config.bufferLow;
      dc.onbufferedamountlow = () => this.pump();
      dc.onopen = () => this.pump();
      this.#data.push(dc);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.room.sendSignal(this.id, { t: 'ice', candidate: ev.candidate.toJSON() });
    };
    // The host is always the offerer (initial offer and ICE restarts), so there is no glare.
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        const d = pc.localDescription!;
        this.room.sendSignal(this.id, { t: 'offer', sdp: { type: d.type, sdp: d.sdp } });
      } catch (e) {
        console.warn('negotiation failed', e);
      }
    };
    pc.onconnectionstatechange = () => this.#onConnectionState();

    this.#connectTimer = setTimeout(() => {
      if (this.status === 'connecting') this.#fail('No direct connection could be made.');
    }, config.connectTimeoutMs + 5000);
  }

  async onAnswer(sdp: RTCSessionDescriptionInit) {
    const pc = this.#pc;
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription(sdp);
      for (const c of this.#queuedIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } catch (e) {
      console.warn('bad answer', e);
    }
  }

  async onRemoteIce(candidate: RTCIceCandidateInit) {
    const pc = this.#pc;
    if (!pc) return;
    if (!pc.remoteDescription) this.#queuedIce.push(candidate);
    else await pc.addIceCandidate(candidate).catch(() => {});
  }

  #onConnectionState() {
    const pc = this.#pc;
    if (!pc || this.#disposed) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      clearTimeout(this.#dropTimer);
      clearTimeout(this.#restartTimer);
      if (this.status === 'reconnecting') {
        this.status = 'connected';
        this.pump();
        this.room.notify();
      }
    } else if ((state === 'disconnected' || state === 'failed') && this.isLive) {
      if (this.status !== 'reconnecting') {
        this.status = 'reconnecting';
        this.room.notify();
        // Network changed (e.g. Wi-Fi to 4G): try an ICE restart, keep progress.
        clearTimeout(this.#restartTimer);
        this.#restartTimer = setTimeout(() => {
          if (pc.connectionState !== 'connected' && this.room.canSignal && !this.signalingGone) pc.restartIce();
        }, state === 'failed' ? 0 : 2000);
        clearTimeout(this.#dropTimer);
        this.#dropTimer = setTimeout(() => {
          if (this.status === 'reconnecting') this.room.removePeer(this);
        }, GIVE_UP_AFTER_DROP_MS);
      } else if (state === 'failed' && this.room.canSignal && !this.signalingGone) {
        pc.restartIce();
      }
    }
  }

  #onCtrlOpen() {
    clearTimeout(this.#connectTimer);
    this.#chunkSize = chooseChunkSize(this.#pc?.sctp?.maxMessageSize, config.maxChunkSize, config.minChunkSize);
    this.status = 'connected';
    this.sendManifest();
    this.room.notify();
  }

  #onCtrlClose() {
    if (this.#disposed || this.status === 'failed') return;
    // Joiner went away (closed the tab, or will come back as a new peer).
    this.room.removePeer(this);
  }

  #fail(message: string) {
    this.status = 'failed';
    this.error = message;
    this.room.notify();
    setTimeout(() => this.room.removePeer(this), 8000);
    this.#pc?.close();
  }

  // ---------------------------------------------------------------- control

  #sendCtrl(msg: HostMsg) {
    this.#ctrlChain = this.#ctrlChain.then(async () => {
      const sealed = await sealJson(this.room.key, msg, AAD_HOST);
      if (this.#ctrl?.readyState === 'open') this.#ctrl.send(sealed);
    });
  }

  sendManifest() {
    if (this.status !== 'connected' && this.status !== 'reconnecting') return;
    const files = [...this.room.files.values()].map((f) => f.meta);
    this.#sendCtrl({ t: 'manifest', files, chunkSize: this.#chunkSize });
  }

  sendBye() {
    const bye = this.room.byeFrame;
    try {
      if (bye && this.#ctrl?.readyState === 'open') this.#ctrl.send(bye);
    } catch {
      /* closing anyway */
    }
  }

  async #onCtrlMessage(data: unknown) {
    if (!(data instanceof ArrayBuffer)) return;
    let msg: PeerMsg;
    try {
      msg = await openJson<PeerMsg>(this.room.key, new Uint8Array(data), AAD_PEER);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'want': {
        const shared = this.room.files.get(msg.file);
        if (!shared) {
          this.#sendCtrl({ t: 'error', file: msg.file, message: 'This file is no longer shared.' });
          return;
        }
        const from = Math.max(0, Math.floor(Number(msg.from)));
        const to = Math.min(shared.meta.size, Math.floor(Number(msg.to)));
        if (!(to > from)) return;
        let t = this.#transfers.get(msg.file);
        if (!t) {
          // A resumed download starts mid-file; count what the joiner already has.
          t = { fileId: msg.file, name: shared.meta.name, size: shared.meta.size, sent: from, complete: false };
          this.#transfers.set(msg.file, t);
        }
        this.#queue.push({ fileId: msg.file, from, to });
        this.pump();
        return;
      }
      case 'cancel':
        this.dropFile(msg.file);
        this.room.notify();
        return;
      case 'complete': {
        const t = this.#transfers.get(msg.file);
        if (t) {
          t.complete = true;
          t.sent = t.size;
        } else {
          const shared = this.room.files.get(msg.file);
          if (shared) {
            const m = shared.meta;
            this.#transfers.set(m.id, { fileId: m.id, name: m.name, size: m.size, sent: m.size, complete: true });
          }
        }
        this.room.notify();
        return;
      }
      case 'finished':
        this.room.peerFinished();
        return;
    }
  }

  dropFile(fileId: number) {
    this.#queue = this.#queue.filter((r) => r.fileId !== fileId);
    const t = this.#transfers.get(fileId);
    if (t && !t.complete) this.#transfers.delete(fileId);
  }

  // ---------------------------------------------------------------- sending

  #pickChannel(ignoreLimit: boolean): RTCDataChannel | null {
    let best: RTCDataChannel | null = null;
    for (const dc of this.#data) {
      if (dc.readyState !== 'open') continue;
      if (!ignoreLimit && dc.bufferedAmount >= config.bufferHigh) continue;
      if (!best || dc.bufferedAmount < best.bufferedAmount) best = dc;
    }
    return best;
  }

  /** Move queued chunks into the data channels, never past the buffer limit. */
  pump() {
    if (this.#disposed || !this.isLive) return;
    while (this.#queue.length && this.#inflight < config.maxInflight) {
      if (!this.#pickChannel(false)) return; // wait for bufferedamountlow
      const head = this.#queue[0];
      const shared = this.room.files.get(head.fileId);
      if (!shared) {
        this.#queue.shift();
        continue;
      }
      const offset = head.from;
      const length = Math.min(this.#chunkSize, head.to - head.from);
      head.from += length;
      if (head.from >= head.to) this.#queue.shift();
      this.#inflight++;
      this.room.worker.encrypt(shared.file, head.fileId, offset, length).then(
        (frame) => {
          this.#inflight--;
          const dc = this.#pickChannel(true);
          if (!dc || this.#disposed) return; // receiver re-requests after reconnecting
          try {
            dc.send(frame);
          } catch {
            return;
          }
          const t = this.#transfers.get(head.fileId);
          if (t && !t.complete) t.sent = Math.min(t.size, t.sent + length);
          this.#speed.add(length);
          this.room.notify();
          this.pump();
        },
        (err: Error) => {
          this.#inflight--;
          this.dropFile(head.fileId);
          const why = err?.name === 'NotReadableError' || err?.name === 'NotFoundError' ? 'it was moved or changed on disk' : err.message;
          this.#sendCtrl({ t: 'error', file: head.fileId, message: `The host could not read this file: ${why}.` });
          this.room.notify();
          this.pump();
        },
      );
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.#connectTimer);
    clearTimeout(this.#dropTimer);
    clearTimeout(this.#restartTimer);
    this.#queue = [];
    this.#pc?.close();
    this.#pc = null;
  }
}
