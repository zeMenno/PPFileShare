// Smoke test for the signaling server. Run with the server up: `node test.js`.
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

const URL = process.env.SIGNALING_URL || 'ws://localhost:8787/ws';

function client() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const closed = new Promise((r) => ws.on('close', r));
  return {
    ws,
    closed,
    open: () => new Promise((r, j) => (ws.readyState === 1 ? r() : (ws.once('open', r), ws.once('error', j)))),
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, ms = 2000) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
        waiters.push({ type, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
  };
}

const room = 'testroom' + Math.random().toString(36).slice(2, 10);
const token = 'tok' + Math.random().toString(36).slice(2).padEnd(20, 'x');

const host = client();
await host.open();
host.send({ type: 'create', room, token });
await host.next('created');

// Someone else can't take the room id.
const squatter = client();
await squatter.open();
squatter.send({ type: 'create', room, token: 'another-token-123456' });
assert.equal((await squatter.next('error')).code, 'room-exists');
squatter.ws.close();

// Unknown room.
const lost = client();
await lost.open();
lost.send({ type: 'join', room: 'nosuchroom12345' });
assert.equal((await lost.next('error')).code, 'no-room');
lost.ws.close();

// Join + relay both ways.
const peer = client();
await peer.open();
peer.send({ type: 'join', room });
const { id } = await peer.next('joined');
assert.equal((await host.next('peer-joined')).id, id);
peer.send({ type: 'signal', data: { box: 'from-peer' } });
const toHost = await host.next('signal');
assert.deepEqual([toHost.from, toHost.data.box], [id, 'from-peer']);
host.send({ type: 'signal', to: id, data: { box: 'from-host' } });
assert.equal((await peer.next('signal')).data.box, 'from-host');

// Kick.
const peer2 = client();
await peer2.open();
peer2.send({ type: 'join', room });
const { id: id2 } = await peer2.next('joined');
await host.next('peer-joined');
host.send({ type: 'kick', id: id2, reason: 'denied' });
assert.equal((await peer2.next('kicked')).reason, 'denied');
await peer2.closed;
assert.equal((await host.next('peer-left')).id, id2);

// Peers can't kick.
peer.send({ type: 'kick', id });
// Oversized message closes the socket.
const big = client();
await big.open();
big.send({ type: 'join', room, pad: 'x'.repeat(70 * 1024) });
await big.closed;

// Host leaves: room closes for everyone.
host.ws.close();
await peer.next('room-closed');
await peer.closed;
const late = client();
await late.open();
late.send({ type: 'join', room });
assert.equal((await late.next('error')).code, 'no-room');
late.ws.close();

console.log('signaling smoke test passed');
process.exit(0);
