/**
 * Headless boot smoke test for web/app.js.
 *
 * Why this exists: `curl /` returning 200 says nothing about whether the page
 * runs. A single null deref in the boot path gives the user a blank preview
 * while every server-side check still passes green — which is exactly the
 * failure that looks "healthy" from inside the sandbox. So we evaluate the real
 * app.js against a stubbed DOM/WebSocket/WebAudio and drive a whole fake call.
 *
 * No dev deps, no browser: node:vm plus just enough fakery to satisfy the
 * code paths. Run: node scripts/check-boot.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../web/app.js', import.meta.url));
const app = fs.readFileSync(SRC, 'utf8');

// ── stub DOM ───────────────────────────────────────────────────────────────
class El {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._q = new Map();
    this._h = {};
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
  remove() {}
  querySelector(sel) {
    if (!this._q.has(sel)) this._q.set(sel, new El('span'));
    return this._q.get(sel);
  }
  addEventListener(ev, fn) { (this._h[ev] ??= []).push(fn); }
  classList = { toggle() {}, add() {}, remove() {} };
  fire(ev, arg = {}) { for (const fn of this._h[ev] || []) fn(arg); }
  text() {
    const kids = [...this.children, ...this._q.values()].map((c) => c.text?.() || '');
    return (this.textContent || kids.filter(Boolean).join(' ')).trim();
  }
}

const reg = new Map();
const procs = [];
const docHandlers = {};
const document = {
  getElementById: (id) => (reg.has(id) ? reg.get(id) : reg.set(id, new El(id)).get(id)),
  createElement: (t) => new El(t),
  addEventListener: (ev, fn) => (docHandlers[ev] ??= []).push(fn),
};
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

// ── stub WebAudio (48 kHz context, buffers declared at 24 kHz) ─────────────
const node = () => ({
  connect(n) { return n ?? this; },
  disconnect() {},
});
class FakeAudioContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; }
  async resume() {}
  async close() {}
  createGain() { return { ...node(), gain: { value: 1 } }; }
  createMediaStreamSource() { return node(); }
  createScriptProcessor() {
    const n = { ...node(), onaudioprocess: null };
    procs.push(n);
    return n;
  }
  createBuffer(_ch, len, rate) {
    return { length: len, sampleRate: rate, duration: len / rate, copyToChannel() {} };
  }
  createBufferSource() { return { ...node(), start() {}, stop() {}, buffer: null, onended: null }; }
}

// ── stub network ──────────────────────────────────────────────────────────
const sockets = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
    // Mirror the browser: open arrives on a later turn, and the app hangs its
    // setup send off onopen. Skipping this hides the whole handshake path.
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(d) {
    if (this.readyState !== 1) throw new Error('send before OPEN — the app must not do this');
    this.sent.push(JSON.parse(d));
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  frames(key) { return this.sent.filter((f) => key in f); }
  from(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
const fetches = [];
const fetch = async (u) => {
  fetches.push(u);
  return { ok: true, status: 200, json: async () => ({ keysafe: false }) };
};

const sandbox = {
  document, localStorage, WebSocket: FakeWebSocket, fetch, console,
  performance: { now: () => Date.now() },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  location: { origin: 'http://localhost:8787', href: 'http://localhost:8787/' },
  navigator: {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.AudioContext = FakeAudioContext;
sandbox.window.isSecureContext = true;

// ── run it ────────────────────────────────────────────────────────────────
const tick = (n = 6) => new Promise((r) => setTimeout(r, n));
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['  ok  ', name]); }
  catch (e) { results.push([' FAIL ', name + ' :: ' + e.message]); process.exitCode = 1; }
};

let bootError = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(app, sandbox, { filename: 'web/app.js' });
} catch (e) {
  bootError = e;
}

await tick();

check('module evaluates with no throw', () => {
  if (bootError) throw bootError;
});

check('boot reached the settings sheet (no key configured)', () => {
  assert.equal(reg.get('sheet')?.hidden, false, 'sheet should auto-open when keyless');
});

// configure a key the way the user would, then save
reg.get('fKey').value = 'TESTKEY-abc';
reg.get('fModel').value = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
reg.get('sheetSave').fire('click');
await tick();
check('save persists to localStorage', () => {
  const saved = JSON.parse(localStorage.getItem('aryans-aicall/v0'));
  assert.equal(saved.key, 'TESTKEY-abc');
});

// start the session
reg.get('pttBtn').fire('click');
await tick();
check('one socket, aimed at BidiGenerateContent with the key', () => {
  assert.equal(sockets.length, 1, `expected 1 socket, got ${sockets.length}`);
  const ws = sockets[0];
  assert.match(ws.url, /GenerativeService\.BidiGenerateContent/);
  assert.match(ws.url, /key=TESTKEY-abc/);
});
check('first frame is a setup with model, AUDIO modality and tools', () => {
  const ws = sockets[0];
  const setup = ws.frames('setup')[0];
  assert.ok(setup, 'no setup frame sent');
  assert.equal(setup.setup.model, 'models/gemini-2.5-flash-native-audio-preview-12-2025');
  assert.deepEqual(setup.setup.responseModalities, ['AUDIO']);
  assert.ok(setup.setup.tools?.[0]?.functionDeclarations?.length >= 2, 'tools not advertised');
  assert.equal(setup.setup.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
});

// handshake
sockets[0].from({ setupComplete: {} });
await tick();
check('setupComplete lands the UI in listening', () => {
  assert.equal(reg.get('modePill').textContent, 'listening');
  assert.equal(reg.get('hangup').hidden, false, 'hangup button should appear');
});

// drive the mic: loud 2048-sample blocks must become 16 kHz PCM frames
check('mic frames reach the socket as audio/pcm;rate=16000', () => {
  assert.ok(procs.length >= 1, 'no script processor was created');
  const block = new Float32Array(2048);
  for (let i = 0; i < block.length; i++) block[i] = Math.sin(i / 3) * 0.4; // loud
  // ~7 blocks of 2048 at 48 kHz = 300 ms: enough to cross the 100 ms chunk floor
  for (let n = 0; n < 7; n++) procs[0].onaudioprocess({ inputBuffer: { getChannelData: () => block } });
  const audio = sockets[0].frames('realtimeInput').filter((f) => f.realtimeInput.audio);
  assert.ok(audio.length, 'no realtimeInput.audio frames sent');
  assert.equal(audio[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  // 100 ms at 16 kHz, 16-bit = 3200 bytes = 4272 base64 chars
  const bytes = Buffer.from(audio[0].realtimeInput.audio.data, 'base64').length;
  assert.equal(bytes, 3200, `chunk should be 3200 bytes, got ${bytes}`);
});

// agent replies with audio + transcriptions
const pcm = Buffer.alloc(4800 * 2); // 200 ms of 24 kHz int16
for (let i = 0; i < 4800; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 4000), i * 2);
sockets[0].from({
  serverContent: {
    modelTurn: {
      parts: [{ inlineData: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=24000' } }],
    },
  },
});
sockets[0].from({ serverContent: { outputTranscription: { text: 'Theek hai, main note kar leta hoon.' } } });
sockets[0].from({ serverContent: { inputTranscription: { text: 'Mera order confirm karo' } } });
sockets[0].from({ serverContent: { turnComplete: true } });
await tick();
check('agent audio flips the orb to speaking', () => {
  assert.equal(reg.get('coreGlyph').textContent, '🔊');
});
check('transcriptions are rendered, not swallowed', () => {
  const all = reg.get('thread').children.map((c) => c.text()).join('\n');
  assert.match(all, /Theek hai, main note kar leta hoon\./);
  assert.match(all, /Mera order confirm karo/);
});

// tool call round trip
sockets[0].from({
  toolCall: { functionCalls: [{ id: 'c1', name: 'take_note', args: { text: 'order 4471 COD confirm' } }] },
});
await tick();
check('toolResponse goes back with the call id', () => {
  const tr = sockets[0].frames('toolResponse').at(-1);
  assert.ok(tr, 'no toolResponse frame');
  assert.equal(tr.toolResponse.functionResponses[0].id, 'c1');
  assert.equal(tr.toolResponse.functionResponses[0].name, 'take_note');
});
check('take_note is durable across the session', () => {
  const notes = JSON.parse(localStorage.getItem('aryans-aicall/notes') || '[]');
  assert.equal(notes.at(-1).text, 'order 4471 COD confirm');
});

// barge-in path must not throw with playback in flight
for (const fn of docHandlers.keydown || []) fn({ code: 'Escape' });
await tick();
check('Escape flushes playback safely', () => {
  assert.notEqual(reg.get('coreGlyph').textContent, '🔊');
});

// teardown
reg.get('hangup').fire('click');
await tick();
check('hangup returns to idle without throwing', () => {
  assert.equal(reg.get('modePill').textContent, 'idle');
  assert.equal(reg.get('hangup').hidden, true);
});

// The stub's traversal is not faithful enough to prove a selector resolves to a
// real child, so check the contract that actually matters instead: every class
// app.js queries by must exist in the stylesheet. Rename '.tx' to '.textx' and
// this goes red even when the fake DOM happily swallows it.
const css = fs.readFileSync(fileURLToPath(new URL('../web/styles.css', import.meta.url)), 'utf8');
const html = fs.readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
check('every queried class exists in the stylesheet', () => {
  const sel = [...app.matchAll(/querySelector\('\.([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const orphans = [...new Set(sel)].filter((c) => !css.includes('.' + c));
  assert.deepEqual(orphans, [], 'styled nowhere: ' + orphans.join(', '));
});
check('every id in the HTML is reachable by the app', () => {
  const jsIds = new Set([...app.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...jsIds].filter((i) => !htmlIds.has(i));
  assert.deepEqual(missing, [], 'dangling getElementById: ' + missing.join(', '));
});

for (const [s, n] of results) console.log(s, n);
const failed = results.filter(([s]) => s.includes('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} boot checks passed`);
if (failed) process.exitCode = 1;
