/// <reference lib="webworker" />
// Poll loop for HTTP signaling. Runs in a worker because browsers heavily throttle
// timers in background tabs, and a host tab usually sits in the background.

export {};
declare const self: DedicatedWorkerGlobalScope;

/** Poll fast while a handshake is happening, slowly otherwise. */
const FAST_MS = 500;
const SLOW_MS = 2500;
const FAST_WINDOW_MS = 15_000;
const MAX_FAILURES = 6;

let url = '';
let sid: string | undefined;
let secret: string | undefined;
let queue: Record<string, unknown>[] = [];
let lastActivity = 0;
let wake: (() => void) | null = null;

const post = (m: unknown) => self.postMessage(m);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wake = null;
      resolve();
    }
    wake = done;
  });

async function loop() {
  let failures = 0;
  for (;;) {
    const ops = queue.splice(0, 60);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, secret, ops }),
      });
      if (res.status === 410 || res.status === 403) {
        post({ type: 'closed' });
        return;
      }
      if (res.status === 429) {
        queue.unshift(...ops);
        await sleep(1000);
        continue;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      failures = 0;
      if (!sid) {
        sid = data.sid;
        secret = data.secret;
        post({ type: 'open', sid, secret });
      }
      for (const msg of data.messages ?? []) post({ type: 'message', msg });
      if (ops.length || data.messages?.length) lastActivity = Date.now();
    } catch (e) {
      queue.unshift(...ops);
      failures++;
      if (!sid && failures >= 2) {
        post({ type: 'error', message: `Could not reach the signaling server (${(e as Error).message}).` });
        return;
      }
      if (failures >= MAX_FAILURES) {
        post({ type: 'closed' });
        return;
      }
    }
    if (queue.length) await sleep(30);
    else await sleep(Date.now() - lastActivity < FAST_WINDOW_MS ? FAST_MS : SLOW_MS);
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'start') {
    url = m.url;
    lastActivity = Date.now();
    loop();
  } else if (m.type === 'send') {
    queue.push(m.msg);
    lastActivity = Date.now();
    // Let a burst of ICE candidates collect for a moment, then send them together.
    setTimeout(() => wake?.(), 30);
  }
};
