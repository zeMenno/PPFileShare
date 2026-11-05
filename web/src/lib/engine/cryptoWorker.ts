import type { WorkerRequest, WorkerResponse } from './worker';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** Promise-based client for the crypto worker. */
export class CryptoWorker {
  #worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  #next = 1;
  #pending = new Map<number, { resolve: (r: WorkerResponse & { ok: true }) => void; reject: (e: Error) => void }>();

  constructor() {
    this.#worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const res = ev.data;
      const p = this.#pending.get(res.id);
      if (!p) return;
      this.#pending.delete(res.id);
      if (res.ok) p.resolve(res);
      else {
        const err = new Error(res.error);
        if (res.name) err.name = res.name;
        p.reject(err);
      }
    };
    this.#worker.onerror = (ev) => {
      const err = new Error(ev.message || 'crypto worker failed');
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
    };
  }

  #call(req: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []) {
    const id = this.#next++;
    return new Promise<WorkerResponse & { ok: true }>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...req, id }, transfer);
    });
  }

  async init(key: CryptoKey) {
    await this.#call({ op: 'init', key });
  }

  /** Read [offset, offset+length) of a file and return an encrypted frame. */
  async encrypt(file: Blob, fileId: number, offset: number, length: number): Promise<ArrayBuffer> {
    const res = await this.#call({ op: 'encrypt', file, fileId, offset, length });
    return res.frame!;
  }

  async decrypt(frame: ArrayBuffer): Promise<{ fileId: number; offset: number; data: ArrayBuffer }> {
    const res = await this.#call({ op: 'decrypt', frame }, [frame]);
    return { fileId: res.fileId!, offset: res.offset!, data: res.data! };
  }

  terminate() {
    this.#worker.terminate();
    for (const p of this.#pending.values()) p.reject(new Error('worker stopped'));
    this.#pending.clear();
  }
}
