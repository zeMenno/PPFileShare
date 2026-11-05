// Where received bytes go. Three strategies, picked per browser:
//  - File System Access (Chromium desktop): stream straight into a chosen file or folder.
//  - Service-worker streaming download (Firefox, Safari, Android): StreamSaver pattern.
//  - In-memory Blob for small files, or when nothing else is available.

import { config } from './config';
import { randomId } from './crypto';
import type { FileMeta } from './protocol';

export interface Sink {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

export type SinkFactory = (meta: FileMeta) => Promise<Sink>;

// Chromium-only pickers; not in lib.dom.
interface SaveFilePickerOptions {
  suggestedName?: string;
}
declare global {
  interface Window {
    showSaveFilePicker?: (opts?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
  }
}

export const hasFileSystemAccess =
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function' && typeof window.showDirectoryPicker === 'function';

const SMALL_FOR_STREAMING = 32 * 1024 * 1024;

// ------------------------------------------------------------------ helpers

function baseName(meta: FileMeta) {
  return meta.name || meta.path.split('/').pop() || 'download';
}

function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ------------------------------------------------------------------ memory

/** Collects the file in memory and saves it as a Blob download at the end. */
export function memorySink(meta: FileMeta, onDone?: (blob: Blob) => void): Sink {
  let parts: BlobPart[] = [];
  return {
    async write(chunk) {
      parts.push(chunk);
    },
    async close() {
      const blob = new Blob(parts, { type: meta.type || 'application/octet-stream' });
      parts = [];
      if (onDone) onDone(blob);
      else triggerDownload(blob, baseName(meta));
    },
    async abort() {
      parts = [];
    },
  };
}

// ------------------------------------------------------------------ File System Access

function writableSink(w: FileSystemWritableFileStream): Sink {
  return {
    write: (chunk) => w.write(chunk),
    close: () => w.close(),
    abort: async () => {
      await w.abort().catch(() => {});
    },
  };
}

async function exists(dir: FileSystemDirectoryHandle, name: string) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Writes each file into the chosen folder, recreating sub-folders, never overwriting. */
export function directorySinkFactory(root: FileSystemDirectoryHandle): SinkFactory {
  return async (meta) => {
    const parts = meta.path.split('/').filter(Boolean);
    const fileName = parts.pop() || baseName(meta);
    let dir = root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    let name = fileName;
    const [stem, ext] = splitExt(fileName);
    for (let i = 1; i < 100 && (await exists(dir, name)); i++) name = `${stem} (${i})${ext}`;
    const handle = await dir.getFileHandle(name, { create: true });
    return writableSink(await handle.createWritable());
  };
}

export function fileHandleSinkFactory(handle: FileSystemFileHandle): SinkFactory {
  return async () => writableSink(await handle.createWritable());
}

// ------------------------------------------------------------------ service worker streaming

let swPromise: Promise<ServiceWorker | null> = Promise.resolve(null);

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  swPromise = navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => reg.active)
    .catch((e) => {
      console.warn('service worker unavailable', e);
      return null;
    });
}

async function getServiceWorker(): Promise<ServiceWorker | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 4000));
  return Promise.race([swPromise, timeout]);
}

let openStreams = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;

function streamOpened(sw: ServiceWorker) {
  openStreams++;
  // Browsers stop idle service workers after ~30 s; keep ours awake while streaming.
  keepAlive ??= setInterval(() => sw.postMessage({ type: 'ping' }), 10_000);
}

function streamClosed() {
  openStreams = Math.max(0, openStreams - 1);
  if (!openStreams && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = undefined;
  }
}

async function streamSink(meta: FileMeta, sw: ServiceWorker): Promise<Sink> {
  const id = randomId();
  const { port1: port, port2 } = new MessageChannel();
  let credits = 0;
  let cancelled = false;
  let waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((w) => w());

  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The download helper did not start.')), 5000);
    port.onmessage = (ev) => {
      const m = ev.data;
      if (m?.type === 'ready') {
        clearTimeout(t);
        resolve();
      } else if (m?.type === 'pull') {
        credits++;
        wake();
      } else if (m?.type === 'cancel') {
        cancelled = true;
        wake();
      }
    };
  });
  const name = baseName(meta);
  sw.postMessage({ type: 'download', id, name, size: meta.size, mime: meta.type }, [port2]);
  await ready;

  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = `/__download/${id}/${encodeURIComponent(name)}`;
  document.body.appendChild(iframe);
  streamOpened(sw);

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    streamClosed();
    setTimeout(() => iframe.remove(), 60_000);
  };

  return {
    async write(chunk) {
      while (!credits && !cancelled) await new Promise<void>((r) => waiters.push(r));
      if (cancelled) throw new DOMException('The download was cancelled in the browser.', 'AbortError');
      credits--;
      const buf = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk.buffer : chunk.slice().buffer;
      port.postMessage({ type: 'chunk', data: buf }, [buf]);
    },
    async close() {
      port.postMessage({ type: 'end' });
      end();
    },
    async abort() {
      port.postMessage({ type: 'abort' });
      end();
    },
  };
}

// ------------------------------------------------------------------ choosing

/**
 * Decide where a batch of files goes. Must be called straight from a click handler,
 * because the File System Access pickers need a user gesture.
 * Returns null if the user cancelled a picker.
 */
export async function chooseSink(files: FileMeta[]): Promise<SinkFactory | null> {
  try {
    if (hasFileSystemAccess) {
      if (files.length === 1) {
        const f = files[0];
        if (f.size < config.blobLimit) return async (meta) => memorySink(meta);
        const handle = await window.showSaveFilePicker!({ suggestedName: baseName(f) });
        return fileHandleSinkFactory(handle);
      }
      const dir = await window.showDirectoryPicker!({ mode: 'readwrite', id: 'pp-downloads' });
      return directorySinkFactory(dir);
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return null;
    console.warn('File System Access failed, falling back', e);
  }
  return async (meta) => {
    if (meta.size >= SMALL_FOR_STREAMING) {
      const sw = await getServiceWorker();
      if (sw) {
        try {
          return await streamSink(meta, sw);
        } catch (e) {
          console.warn('streaming download failed, using memory', e);
        }
      }
    }
    return memorySink(meta);
  };
}

/** True when a big file will have to be held in memory on this browser. */
export async function willBufferInMemory(files: FileMeta[]): Promise<boolean> {
  if (hasFileSystemAccess) return false;
  const big = files.some((f) => f.size >= config.blobLimit);
  if (!big) return false;
  return !(await getServiceWorker());
}
