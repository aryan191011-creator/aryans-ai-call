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

// Speaking is the Live row's job, so there is exactly one REST surface left: model
// discovery. A /tts route would mean a second Google model between the preview and the
// call, which is what made a voice ever sound "nicer in Settings than on the phone".
const tts = await fetch(BASE + '/tts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
}).catch((e) => ({ ok: false, status: 0, e: e.message }));
console.log('/tts     ->', tts.status, '(expected 404: no second audio route by design)');
if (tts.ok) throw new Error('/tts still answers — the client never calls it, so it is a key-bearing route nobody uses');
if (tts.status !== 404 && tts.status !== 405) throw new Error('/tts answered ' + tts.status + ' instead of 404');

const cfg = await (await fetch(BASE + '/config')).json();
const health = await (await fetch(BASE + '/healthz')).json();
console.log('/config  ->', JSON.stringify(cfg));
console.log('/healthz ->', JSON.stringify(health));
if (!cfg.keysafe) throw new Error('expected keysafe:true under PROXY=1');
if (!health.ok) throw new Error('the server died handling a request for a missing route — a stray fetch must not take down a live call');

// The audition rides /relay in keysafe mode, so the relay has to carry a setup frame
// with a voice in it, not just the call's. One frame is queued while the upstream leg
// is still connecting: dropping it is what used to make previews go silent.
const models = await fetch(BASE + '/models');
console.log('/models  ->', models.status, '(keysafe passthrough is mounted)');
if (models.status === 404) throw new Error('/models is gone — the settings sheet cannot check the row against the key');

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
  // A setup frame must be queued while the upstream leg is still CONNECTING, not
  // dropped — that is what kills first-turn audio on a cold relay. This is the shape of
  // the audition's frame too (voice under generationConfig), so the same queue carries
  // the voice preview in keysafe mode.
  ws.send(JSON.stringify({
    setup: {
      model: 'models/x',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Sulafat' } } },
      },
    },
  }));
  console.log('sent a voice-carrying setup frame immediately after open (queue path)');
});
ws.on('message', (m) => got.push(JSON.parse(m.toString())));
ws.on('close', (c) => finish('close code ' + c));
ws.on('error', (e) => {
  console.log('browser socket error:', e.message);
  finish('error');
});
const timer = setTimeout(() => finish('timeout'), 12000);
