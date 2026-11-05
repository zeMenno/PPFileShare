// Streaming-download helper (StreamSaver pattern).
// The page hands us a MessagePort per file; we expose it as a ReadableStream at
// /__download/<id>/<name>, and the browser saves that response straight to disk.
// Nothing is cached, nothing else is intercepted.

const streams = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'download') return; // pings just keep us alive
  const port = event.ports[0];
  if (!port || typeof msg.id !== 'string') return;

  let controller;
  let resolvePull = null;
  const stream = new ReadableStream(
    {
      start(c) {
        controller = c;
      },
      pull() {
        port.postMessage({ type: 'pull' });
        return new Promise((resolve) => (resolvePull = resolve));
      },
      cancel() {
        port.postMessage({ type: 'cancel' });
        streams.delete(msg.id);
      },
    },
    { highWaterMark: 8 },
  );

  port.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'chunk') {
      controller.enqueue(new Uint8Array(m.data));
      resolvePull?.();
      resolvePull = null;
    } else if (m.type === 'end') {
      controller.close();
      resolvePull?.();
      port.close();
    } else if (m.type === 'abort') {
      controller.error(new Error('aborted'));
      resolvePull?.();
      port.close();
      streams.delete(msg.id);
    }
  };

  streams.set(msg.id, { stream, name: String(msg.name || 'download'), size: Number(msg.size) || 0, mime: msg.mime });
  // Forget streams nobody fetched within a minute.
  setTimeout(() => streams.delete(msg.id), 60_000);
  port.postMessage({ type: 'ready' });
});

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const m = url.pathname.match(/^\/__download\/([A-Za-z0-9_-]+)(\/|$)/);
  if (!m) return;
  const entry = streams.get(m[1]);
  if (!entry) {
    event.respondWith(new Response('This download is no longer available.', { status: 404 }));
    return;
  }
  streams.delete(m[1]);
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(entry.name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  if (entry.size) headers.set('Content-Length', String(entry.size));
  event.respondWith(new Response(entry.stream, { headers }));
});
