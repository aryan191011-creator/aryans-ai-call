/**
 * Verifies the keysafe relay: mount, the /config handshake the page depends on,
 * and — the part that actually bites — that a browser is never left hanging or
 * silently black-holed when the upstream leg fails. Upstream is unreachable in
 * this sandbox, which makes it a free fault-injection test: the relay must
 * deliver a relayError frame and stay alive for the next caller.
 */
import WebSocket from 'ws';
import { spawn } from 'node:child_process';

/*
 * This check used to require that someone had already started a keysafe server on
 * :8788 by hand — so run from a clean checkout it died with ECONNREFUSED, which is
 * the worst possible outcome for a *check*: it looks like the code failed when in
 * fact nothing was tested. It now owns its own server, on a port that cannot collide
 * with the preview, and shuts it down at the end.
 */
const PORT = Number(process.env.CHECK_PORT || 8789);
// 127.0.0.1, never `localhost`: the server binds 0.0.0.0 (IPv4 only, which is what the
// preview needs), while `localhost` resolves to ::1 first on a dual-stack box. fetch()
// falls back and succeeds, the ws client does not and reports ECONNREFUSED — which
// reads like "the relay is broken" when nothing is wrong but the test's own address.
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_BASE = `ws://${HOST}:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PROXY: '1', GEMINI_API_KEY: 'relay-check-key' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(BASE + '/healthz')).ok; } catch { await sleep(100); }
}
if (!up) {
  console.error('FAIL  could not start its own keysafe server on :' + PORT);
  child.kill('SIGKILL');
  process.exit(1);
}

// The keysafe-only POST route the voice audition uses. Upstream is unreachable from a
// sandbox, so this is a free fault-injection test: the server must answer with a JSON
// error a UI can show, and must survive to serve the next request.
const tts = await fetch(BASE + '/tts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
}).catch((e) => ({ ok: false, status: 0, e: e.message }));
const ttsBody = await (tts.json?.() || Promise.resolve({})).catch(() => ({}));
console.log('/tts     ->', tts.status, JSON.stringify(ttsBody).slice(0, 120));
if (tts.status === 404) throw new Error('server has no /tts route — the audition would 404 in keysafe mode');
if (tts.ok) console.log('NOTE  /tts returned 200 — this environment has egress, real audio came back');
else if (!ttsBody?.error?.message) throw new Error('/tts failed without a JSON error body: the sheet would show "undefined"');

const cfg = await (await fetch(BASE + '/config')).json();
const health = await (await fetch(BASE + '/healthz')).json();
console.log('/config  ->', JSON.stringify(cfg));
console.log('/healthz ->', JSON.stringify(health));
if (!cfg.keysafe) throw new Error('expected keysafe:true under PROXY=1');
if (!health.ok) throw new Error('the server died handling /tts — a bad request must not take down a live call');

const ws = new WebSocket(`${WS_BASE}/relay`);
const got = [];
let done = false;
const finish = (how) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  ws.close();
  child.kill('SIGTERM'); // no orphaned server left holding the port
  const err = got.find((m) => m.relayError);
  console.log('frames to browser:', got.length ? JSON.stringify(got).slice(0, 240) : '(none)');
  // The property under test is not "an error frame arrives" — on a host with egress the
  // relay proxies fine and no error is expected. It is that the browser is never left
  // black-holed: it gets a frame it can act on, or a clean close it can retry on.
  if (err) {
    console.log('OK  upstream failure surfaced as relayError:', JSON.stringify(err.relayError));
  } else if (got.length) {
    console.log('OK  relay carried traffic (no fault to report from this environment)');
  } else {
    console.error(`FAIL  browser saw ${how} with zero frames — that is a silent dead call`);
    process.exit(1);
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
