// Vercel Function: polling signaling endpoint (POST /api/signal).
import { handleSignal } from './_lib/signal-core.js';
import { upstashStore } from './_lib/store-upstash.js';

const MAX_BODY = 64 * 1024;

function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  // Only pages from this site may signal (beacons and fetches both send Origin).
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (origin && host && new URL(origin).host !== host) return json(403, { error: 'forbidden' });

  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: 'too-large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'bad-request' });
  }

  const ip =
    request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

  let store;
  try {
    store = upstashStore();
  } catch (e) {
    return json(503, { error: (e as Error).message });
  }
  const { status, json: out } = await handleSignal(store, body, ip);
  return json(status, out);
}
