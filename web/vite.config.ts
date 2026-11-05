import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { handleSignal, memoryStore } from '../api/_lib/signal-core.js';

/**
 * Strict Content Security Policy for production builds: only our own scripts may run,
 * so nothing on the page can read the key in the URL fragment.
 * (Dev mode skips it because Vite's HMR needs inline styles and its own websocket.)
 */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  const connect = ["'self'"];
  if (env.VITE_SIGNALING_URL) connect.push(new URL(env.VITE_SIGNALING_URL).origin);
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

/** Serve the Vercel polling endpoint (/api/signal) from the dev server, with an in-memory store. */
function localSignalingApi(): Plugin {
  const store = memoryStore();
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST') return next();
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', async () => {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const { status, json } = await handleSignal(store, body, req.socket.remoteAddress || 'local');
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(json));
    });
  };
  return {
    name: 'local-signaling-api',
    configureServer: (server) => void server.middlewares.use('/api/signal', handler),
    configurePreviewServer: (server) => void server.middlewares.use('/api/signal', handler),
  };
}

const signalingTarget = process.env.SIGNALING_TARGET || 'ws://localhost:8787';
const proxy = { '/ws': { target: signalingTarget, ws: true } };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    // "lan" mode serves over self-signed HTTPS, because WebCrypto and service
    // workers only work in a secure context (phones on http://192.168.x.x don't count).
    plugins: [svelte(), contentSecurityPolicy(env), localSignalingApi(), mode === 'lan' && basicSsl()],
    define: {
      // Vercel can't host WebSockets, so builds there use HTTP polling signaling.
      __DEFAULT_SIGNALING_MODE__: JSON.stringify(process.env.VERCEL ? 'http' : 'ws'),
    },
    server: { proxy },
    preview: { proxy },
    worker: { format: 'es' },
    build: { target: 'es2022' },
  };
});
