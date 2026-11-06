import { defineConfig, loadEnv, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { DEFAULT_BROKERS } from './src/lib/engine/brokers.ts';

/**
 * Strict Content Security Policy for production builds: only our own scripts may run,
 * so nothing on the page can read the key in the URL fragment.
 * (Dev mode skips it because Vite's HMR needs inline styles and its own websocket.)
 */
function contentSecurityPolicy(env: Record<string, string>, relay: boolean): Plugin {
  const connect = ["'self'"];
  if (env.VITE_SIGNALING_URL) connect.push(new URL(env.VITE_SIGNALING_URL).origin);
  if (relay) {
    const brokers = env.VITE_RELAY_BROKERS ? env.VITE_RELAY_BROKERS.split(',').map((s) => s.trim()) : DEFAULT_BROKERS;
    for (const b of brokers) connect.push(new URL(b).origin);
  }
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

const signalingTarget = process.env.SIGNALING_TARGET || 'ws://localhost:8787';
const proxy = { '/ws': { target: signalingTarget, ws: true } };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Vercel only serves static files (no WebSockets), so builds there use public relays.
  const defaultMode = process.env.VERCEL ? 'relay' : 'ws';
  const relay = (env.VITE_SIGNALING_MODE || defaultMode) === 'relay';
  return {
    // "lan" mode serves over self-signed HTTPS, because WebCrypto and service
    // workers only work in a secure context (phones on http://192.168.x.x don't count).
    plugins: [svelte(), contentSecurityPolicy(env, relay), mode === 'lan' && basicSsl()],
    define: {
      __DEFAULT_SIGNALING_MODE__: JSON.stringify(defaultMode),
    },
    server: { proxy },
    preview: { proxy },
    worker: { format: 'es' },
    build: { target: 'es2022' },
  };
});
