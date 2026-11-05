/// <reference lib="webworker" />
// Reads file slices and does all per-chunk AES-GCM work, so the UI thread stays free.

import { HEADER_BYTES, IV_BYTES, readHeader, writeHeader } from './protocol';

export type WorkerRequest =
  | { id: number; op: 'init'; key: CryptoKey }
  | { id: number; op: 'encrypt'; file: Blob; fileId: number; offset: number; length: number }
  | { id: number; op: 'decrypt'; frame: ArrayBuffer };

export type WorkerResponse =
  | { id: number; ok: true; frame?: ArrayBuffer; fileId?: number; offset?: number; data?: ArrayBuffer }
  | { id: number; ok: false; error: string; name?: string };

declare const self: DedicatedWorkerGlobalScope;

let key: CryptoKey | null = null;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.op === 'init') {
      key = req.key;
      self.postMessage({ id: req.id, ok: true } satisfies WorkerResponse);
      return;
    }
    if (!key) throw new Error('worker not initialised');

    if (req.op === 'encrypt') {
      const plain = await req.file.slice(req.offset, req.offset + req.length).arrayBuffer();
      if (plain.byteLength !== req.length) throw new Error('file changed on disk while sharing');
      const header = writeHeader(req.fileId, req.offset);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, plain);
      const frame = new Uint8Array(HEADER_BYTES + IV_BYTES + ct.byteLength);
      frame.set(header, 0);
      frame.set(iv, HEADER_BYTES);
      frame.set(new Uint8Array(ct), HEADER_BYTES + IV_BYTES);
      self.postMessage({ id: req.id, ok: true, frame: frame.buffer } satisfies WorkerResponse, [frame.buffer]);
      return;
    }

    if (req.op === 'decrypt') {
      const frame = new Uint8Array(req.frame);
      const { fileId, offset } = readHeader(frame);
      const data = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: frame.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES),
          additionalData: frame.subarray(0, HEADER_BYTES),
        },
        key,
        frame.subarray(HEADER_BYTES + IV_BYTES),
      );
      self.postMessage({ id: req.id, ok: true, fileId, offset, data } satisfies WorkerResponse, [data]);
      return;
    }
  } catch (err) {
    const e = err as Error;
    self.postMessage({ id: req.id, ok: false, error: e?.message || String(err), name: e?.name } satisfies WorkerResponse);
  }
};
