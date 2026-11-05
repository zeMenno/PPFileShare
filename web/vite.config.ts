import { defineConfig, loadEnv, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';

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
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self'",
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
  return {
    // "lan" mode serves over self-signed HTTPS, because WebCrypto and service
    // workers only work in a secure context (phones on http://192.168.x.x don't count).
    plugins: [svelte(), contentSecurityPolicy(env), mode === 'lan' && basicSsl()],
    server: { proxy },
    preview: { proxy },
    worker: { format: 'es' },
    build: { target: 'es2022' },
  };
});
