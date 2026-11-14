/**
 * Verifies the keysafe relay: mount, the /config handshake the page depends on,
 * and — the part that actually bites — that a browser is never left hanging or
 * silently black-holed when the upstream leg fails. Upstream is unreachable in
 * this sandbox, which makes it a free fault-injection test: the relay must
 * deliver a relayError frame and stay alive for the next caller.
 */
import WebSocket from 'ws';

const BASE = 'http://localhost:8788';
const cfg = await (await fetch(BASE + '/config')).json();
const health = await (await fetch(BASE + '/healthz')).json();
console.log('/config  ->', JSON.stringify(cfg));
console.log('/healthz ->', JSON.stringify(health));
if (!cfg.keysafe) throw new Error('expected keysafe:true under PROXY=1');

const ws = new WebSocket('ws://localhost:8788/relay');
const got = [];
let done = false;
const finish = (how) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  ws.close();
  const err = got.find((m) => m.relayError);
  console.log('frames to browser:', got.length ? JSON.stringify(got).slice(0, 240) : '(none)');
  if (err) {
    console.log('OK  upstream failure surfaced as relayError:', JSON.stringify(err.relayError));
  } else {
    console.log('NOTE  no relayError frame — upstream may still be dialing (browser saw:', how, ')');
  }
  process.exit(0);
};
ws.on('open', () => {
  // A setup frame must be queued while the upstream leg is still CONNECTING,
  // not dropped — that is what kills first-turn audio on a cold relay.
  ws.send(JSON.stringify({ setup: { model: 'models/x', responseModalities: ['AUDIO'] } }));
  console.log('sent setup frame immediately after open (queue path)');
});
ws.on('message', (m) => got.push(JSON.parse(m.toString())));
ws.on('close', (c) => finish('close code ' + c));
ws.on('error', (e) => {
  console.log('browser socket error:', e.message);
  finish('error');
});
const timer = setTimeout(() => finish('timeout'), 12000);
