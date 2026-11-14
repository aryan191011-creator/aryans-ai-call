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
// Read alongside app.js, so any check in the file — not only the ones written near the
// bottom — can compare the three files against each other.
const css = fs.readFileSync(fileURLToPath(new URL('../web/styles.css', import.meta.url)), 'utf8');
// Comments are not markup, and this file treats the string as markup in three places: the fake
// DOM's body children, the panel/id scrapes, and the nesting walk. A sentence in a comment that
// mentions a tag ("instead of a <pre> that materialises") therefore becomes a phantom element —
// and worse, the body scraper would happily append it to document.body. Strip first, scan after.
const html = fs.readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

// ── stub DOM ───────────────────────────────────────────────────────────────
class El {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.style = { setProperty(k, v) { this[k] = v; } };
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
  append(...n) { this.children.push(...n); for (const c of n) if (c) c._parent = this; }
  appendChild(n) { this.children.push(n); n._parent = this; return n; } // the DOM API app.js calls
  // Real containment, via the parent links appendChild maintains. The focus guard in
  // app.js asks `sheet.contains(target)` and treats a false answer as an escape, so a
  // stub that always returned true would make its check pass on the case that matters and
  // say nothing about the case it exists for.
  contains(n) { for (let p = n; p; p = p._parent) if (p === this) return true; return false; }
  replaceChildren(...n) { this.children = n; }
  remove() {}
  focus() { this._focused = true; }
  blur() { this._focused = false; }
  querySelector(sel) {
    if (!this._q.has(sel)) this._q.set(sel, new El('span'));
    return this._q.get(sel);
  }
  addEventListener(ev, fn) { (this._h[ev] ??= []).push(fn); }
  // Real anchors answer to click(); the download path leans on it, so the stub has to
  // or the test would fail on missing fakery rather than on missing behaviour.
  click() { this._clicked = (this._clicked || 0) + 1; }
  // classList has to actually move `className`, or every `classList.add('live')` in the
  // app is unobservable here and the checks that read className pass or fail by accident.
  classList = {
    add: (c) => { if (!this.classList.contains(c)) this.className = (this.className + ' ' + c).trim(); },
    remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
    toggle: (c, on) => { if (on === undefined) on = !this.classList.contains(c); this.classList[on ? 'add' : 'remove'](c); return on; },
    contains: (c) => (this.className || '').split(/\s+/).includes(c),
  };
  // Attributes are how state is exposed to AT, so they must be readable by the
  // assertions — a stub that swallows setAttribute cannot verify a11y at all.
  setAttribute(k, v) { (this._attrs ??= {})[k] = String(v); }
  getAttribute(k) { return this._attrs?.[k] ?? null; }
  removeAttribute(k) { this._attrs && delete this._attrs[k]; }
  fire(ev, arg = {}) { for (const fn of this._h[ev] || []) fn(arg); }
  text() {
    const kids = [...this.children, ...this._q.values()].map((c) => c.text?.() || '');
    return (this.textContent || kids.filter(Boolean).join(' ')).trim();
  }
}

const reg = new Map();
const procs = [];
const docHandlers = {};
const documentElement = new El('html');
const document = {
  documentElement,
  getElementById: (id) => (reg.has(id) ? reg.get(id) : reg.set(id, new El(id)).get(id)),
  createElement: (t) => new El(t),
  addEventListener: (ev, fn) => (docHandlers[ev] ??= []).push(fn),
};
/** Fire an event the way the document does, so handlers registered with
 *  document.addEventListener run with the target the real browser would give them. */
const docFire = (ev, e) => { for (const fn of docHandlers[ev] || []) fn(e); };
// The sheet's background-inert logic iterates `document.body.children`, and the harness had no
// body at all. The list is read out of index.html rather than typed here: the top-level tags in
// the file ARE the body children, and an element with an id is the same object app.js sees, so
// the identity test `node === el.sheet` in app.js means something in here. A hand-written list
// would keep passing after someone wrapped the page in a <div> and inerted the wrong node.
const bodyKids = [];
{
  const start = html.indexOf('<body');
  const end = html.indexOf('</body>');
  for (const line of html.slice(start, end).split('\n')) {
    const m = /^<([a-z]+)((?:[^>"']|"[^"]*"|'[^']*')*)/.exec(line);
    if (!m) continue;
    const attrs = m[2];
    const idm = /\bid="([^"]+)"/.exec(attrs);
    const node = idm ? document.getElementById(idm[1]) : new El(m[1]);
    node.tagName = m[1].toUpperCase();
    node._tag = m[1];
    bodyKids.push(node);
  }
}
assert.ok(bodyKids.length >= 4, `index.html should have several top-level elements, saw ${bodyKids.length}`);
document.body = new El('body');
document.body.append(...bodyKids);

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

// ── stub WebAudio (48 kHz context, buffers declared at 24 kHz) ─────────────
// The graph itself is asserted, not just "no exception was thrown": a tone chain that
// is built but never reaches the destination is exactly as silent as no chain at all,
// and an over-forgiving stub is what let that pass before.
const audio = { nodes: [], edges: [] };
const node = (kind) => {
  const n = {
    _kind: kind,
    connect(t) { audio.edges.push([n, t]); return t ?? n; },
    disconnect() {},
  };
  audio.nodes.push(n);
  return n;
};
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000; this.currentTime = 0; this.state = 'running';
    this.destination = node('destination');
  }
  async resume() {}
  async close() {}
  createGain() { const n = node('gain'); n.gain = { value: 1 }; return n; }
  createBiquadFilter() {
    const n = node('biquad');
    n.type = 'lowpass';
    n.frequency = { value: 0 }; n.Q = { value: 1 }; n.gain = { value: 0 };
    return n;
  }
  createDynamicsCompressor() {
    const n = node('compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = { value: 0 };
    return n;
  }
  async decodeAudioData(buf) {
    audio.decoded = new Uint8Array(buf);
    return { duration: 1.2, length: buf.byteLength };
  }
  createMediaStreamSource() { return node(); }
  createScriptProcessor() {
    const n = { ...node(), onaudioprocess: null };
    procs.push(n);
    return n;
  }
  createBuffer(_ch, len, rate) {
    return { length: len, sampleRate: rate, duration: len / rate, copyToChannel() {} };
  }
  createBufferSource() {
    const n = node('buffersource');
    // Real playback ends; a stub that never fires `onended` pins every
    // "still playing?" branch in the app to true and hides the bug where a paused model
    // or an interruption leaves the orb stuck on speaking forever.
    n.start = () => {
      audio.played = (audio.played || 0) + 1;
      // Ended after the buffer's own duration, the way a real audio clock does. Fired on
      // the next tick instead, every "is audio still playing?" branch in the app would
      // go false instantly and the tests would stop covering the queued case; never
      // fired, they would go true forever. Both are wrong in a way that hides bugs.
      const ms = Math.max(1, Math.round((n.buffer?.duration || 0) * 1000));
      setTimeout(() => { try { n.onended?.(); } catch {} }, ms);
    };
    n.stop = () => {}; n.buffer = null; n.onended = null;
    return n;
  }
  createOscillator() { return { ...node(), frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, start() {}, stop() {} }; }
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
const fetch = async (u, o) => {
  fetches.push({ url: String(u), opts: o || {} });
  const dest = fetches.at(-1).url;
  if (/\/models(\?|$)/.test(dest) && !dest.includes('generateContent')) {
    // Deliberately a list that does NOT contain the configured preview row: retired
    // model rows are the failure this path exists to catch.
    return {
      ok: true,
      status: 200,
      json: async () => ({ models: [
        { name: 'models/gemini-2.0-flash-001', supportedGenerationMethods: ['generateContent'] },
        // A text-only Live row listed FIRST on purpose: it would connect and then have
        // nothing to play, so the picker must rank the native-audio row above it.
        { name: 'models/gemini-2.5-flash-live-preview' },
        { name: 'models/gemini-live-2.5-flash-native-audio' },
        // A Live row whose name never says "live", exactly as the 2.5 native-audio
        // preview rows are really named. Recognition by name alone calls it invisible.
        { name: 'models/gemini-2.5-flash-native-audio-preview-08-2025' },
        // Listed last on purpose: a newer row must still win, or the picker keeps you on
        // the generation that was current when this file was written.
        { name: 'models/gemini-3.8-live' },
      ] }),
    };
  }
  if (fetches.at(-1).url.includes('generateContent')) {
    // There is no REST path in this app any more: speaking happens on the Live socket.
    // A fetch that reaches here is a regression — one model row for hearing, deciding
    // and speaking, or the preview is a promise the call cannot keep.
    return { ok: false, status: 404, json: async () => ({ error: { message: 'no REST audio route in this build' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ keysafe: false }) };
};

const blobs = [];
class FakeBlob {
  constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ''; blobs.push(this); }
}
const urls = [];
const sandbox = {
  document, localStorage, WebSocket: FakeWebSocket, fetch, console,
  Blob: FakeBlob,
  URL: { createObjectURL: (b) => { urls.push(b); return 'blob:fake/' + (urls.length - 1); }, revokeObjectURL: () => {} },


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
// A stall cannot be caught by another timer (the failure mode freezes the timer phase
// outright), so it is caught on the way out: beforeExit fires when the loop drains.
let suiteFinished = false;
process.on('beforeExit', () => {
  if (!suiteFinished) {
    console.log(' FAIL  suite stalled before finishing — an await never settled, which '
      + 'usually means the app recursion or a hung fake; not a pass');
    process.exitCode = 1;
  }
});
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
// Untick the half-duplex guard the way a headphones user would. With the guard
// on there is deliberately NO barge-in — the mic is muted while the agent talks
// so laptop speakers cannot make it interrupt itself. The barge-in policy tests
// below only mean anything with the guard off.
reg.get('fGuard').checked = false;
// The stub El starts every checkbox unchecked; `fHybrid` is checked in the markup, and
// leaving it false here would test the hybrid path as absent rather than present.
reg.get('fHybrid').checked = true;
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
  // This check used to assert the *wrong* shape — responseModalities and speechConfig
  // flat on `setup`, mirroring a doc snippet. A test that pins a bug in place is worse
  // than no test: it makes the bug look sanctioned. It is now asserting the path the
  // API reference documents, and forbids the old one.
  const gc = setup.setup.generationConfig;
  assert.ok(gc, 'no setup.generationConfig — modality and voice belong under it');
  assert.deepEqual(gc.responseModalities, ['AUDIO']);
  assert.equal(
    gc.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Sulafat',
    'the voice picked in Settings must reach the wire'
  );
  assert.equal(setup.setup.speechConfig, undefined,
    'speechConfig on setup itself is an unknown field — the API ignores it and you get the default voice');
  assert.ok(setup.setup.tools?.[0]?.functionDeclarations?.length >= 2, 'tools not advertised');
});

// handshake
sockets[0].from({ setupComplete: {} });
await tick();
check('setupComplete opens the call and puts controls on screen', () => {
  // 'thinking', not 'listening': we asked for a greeting on connect, so the
  // honest state while that comes back is waiting — the old expectation
  // ('listening') described the bug where a connected call sat in silence.
  assert.equal(reg.get('modePill').textContent, 'thinking');
  assert.equal(reg.get('hangup').hidden, false, 'hangup button should appear');
});


// ── the greeting path (a connected call must not be silence) ───────────────
check('connecting greets the caller unprompted', () => {
  const kick = sockets[0].frames('clientContent');
  assert.equal(kick.length, 1, 'expected exactly one kickoff turn, got ' + kick.length);
  const text = kick[0].clientContent.turns[0].parts[0].text;
  assert.ok(text.startsWith('<<connected>>'), 'kickoff must start with the signal token');
  assert.ok(kick[0].clientContent.turnComplete, 'an incomplete turn never triggers a reply');
});
check('the kickoff opens a thinking state, so the wait is honest', () => {
  assert.equal(reg.get('latBar').hidden, false);
});
check('the settings sheet arrives populated, not empty', () => {
  assert.ok(reg.get('fPrompt').value.length > 400, 'persona textarea was blank: ' + reg.get('fPrompt').value.length + ' chars');
  assert.ok(reg.get('fGreet').value.length > 20, 'greeting field was blank');
});
check('the trigger and the persona cannot drift apart', () => {
  // The token appears in both halves of the contract; renaming one must fail here.
  const def = /const CONNECT_SIGNAL = '([^']+)'/.exec(app);
  assert.ok(def, 'CONNECT_SIGNAL not found');
  assert.match(app.slice(0, app.indexOf('const DEFAULTS')), new RegExp(def[1]),
    'DEFAULT_PROMPT does not document the token it is sent');
});

// ── the ten setup panels ──────────────────────────────────────────────────
const PANEL_IDS = ['key', 'model', 'voice', 'audition', 'turns', 'session', 'words', 'comfort', 'quality', 'phone'];
check('the markup, the rail and the app agree on the ten panels, in order', () => {
  // Three lists of the same ten names, in three files. Two of them drifting is invisible
  // in a browser (a tab that shows nothing) and invisible in this harness (getElementById
  // happily invents the element), so the only fix is to compare them here.
  const declared = [...html.matchAll(/<section class="panel" id="p-([a-z]+)" data-panel="([a-z]+)" hidden>/g)];
  assert.deepEqual(declared.map((m) => m[1]), PANEL_IDS, 'the sections in the markup are not the ten panels');
  assert.deepEqual(declared.map((m) => m[1]), declared.map((m) => m[2]), 'id and data-panel disagree on a section');
  const tabs = [...html.matchAll(/class="tab" id="t-([a-z]+)" data-panel="([a-z]+)"/g)];
  assert.deepEqual(tabs.map((m) => m[1]), PANEL_IDS, 'the rail is not the same ten, in the same order');
  assert.deepEqual(tabs.map((m) => m[2]), tabs.map((m) => m[1]), 'id and data-panel disagree on a tab');
  const js = [...app.matchAll(/const PANELS = \[([^\]]*)\]/g)][0][1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(js, PANEL_IDS, 'app.js PANELS drifted from the markup');
  const names = app.slice(app.indexOf('const PANEL_NAMES'), app.indexOf('const PANEL_FOCUS'));
  for (const id of PANEL_IDS) assert.ok(names.includes(`${id}:`), `PANEL_NAMES has no entry for ${id}`);
});

check('every field lives in exactly one panel, and no field was dropped', () => {
  // A restructure loses a field by accident more often than it gains one on purpose: a
  // duplicated id means the second one is never read, and an orphan means the setting
  // exists in code and nowhere you can touch it.
  const sheet = html.slice(html.indexOf('<div class="panels">'), html.indexOf('</div>\n\n    <div class="sheet-actions">'));
  const ids = [...sheet.matchAll(/id="(f[A-Za-z]+|keyWarn|statsReset)"/g)].map((m) => m[1]);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dupes, [], 'a field id appears in two panels: ' + dupes.join(', '));
  const wanted = ['fKey', 'fModel', 'fVoice', 'fTone', 'fSample', 'fAudition', 'fVad', 'fHybrid',
    'fGuard', 'fCaps', 'fGreet', 'fPrompt', 'fMotion', 'fContrast', 'fScale', 'fCues', 'keyWarn'];
  const missing = wanted.filter((w) => !ids.includes(w));
  assert.deepEqual(missing, [], 'settings the sheet no longer has: ' + missing.join(', '));
  assert.equal((sheet.match(/id="fPrompt"/g) || []).length, 1, 'the persona box was pasted twice');
  // The log is deliberately NOT in a panel: the audition writes it, Test connection writes
  // it, and a failure can land on either from any panel. Inside a panel it would be
  // invisible half the time — the classic "where did my error message go".
  const panelsHtml = html.slice(html.indexOf('<div class="panels">'), html.indexOf('</div>\n\n    <div class="sheet-actions">'));
  assert.ok(!panelsHtml.includes('id="sheetLog"'), 'the log was buried inside one panel');
  assert.ok(html.indexOf('id="sheetLog"') > html.indexOf('id="sheet-actions"'.replace('id=', 'class=')),
    'the log is not below the actions it is meant to follow');
});

// Every panel check starts from the same deterministic state: a closed sheet, no hash,
// then an open one on the named panel. Without that, each one inherits whatever the last
// check left behind — and an assertion that reads a state its own body did not set is a
// check that passes for the wrong reason.
const openOn = (name) => {
  if (reg.get('sheet').hidden === false) reg.get('sheetClose').fire('click');
  // Arrive by hash rather than by clicking the tab: that is the one route that runs
  // openSheet's focus hand-off, so the checks below can see where focus lands.
  sandbox.location.hash = name ? '#setup-' + name : '';
  reg.get('gearBtn').fire('click');
};

check('one panel is showing, the other nine are not', () => {
  openOn('key');
  const shown = PANEL_IDS.filter((n) => reg.get('p-' + n).hidden === false);
  assert.deepEqual(shown, ['key'], `expected only the Key panel, got ${JSON.stringify(shown)}`);
  assert.match(reg.get('sheetTitle').textContent, /Setup · Key/);
});
check('a panel is only reachable through its own rail button', () => {
  openOn('quality');
  assert.equal(PANEL_IDS.filter((n) => reg.get('p-' + n).hidden === false).length, 1, 'two panels visible at once');
  assert.equal(reg.get('p-key').hidden, true, 'the previous panel is still on screen too');
  assert.match(reg.get('sheetTitle').textContent, /Quality/, 'the dialog heading still names the old panel');
});
check('the rail says where you are, to a screen reader too', () => {
  openOn('quality');
  // aria-current="" on all ten is the same as aria-current on none of them.
  for (const n of PANEL_IDS) {
    const want = n === 'quality' ? 'true' : 'false';
    assert.equal(reg.get('t-' + n).getAttribute('aria-current'), want,
      `t-${n} said aria-current=${reg.get('t-' + n).getAttribute('aria-current')}, wanted ${want}`);
  }
});
// Focus moves on a timer (a dialog that grabs it before paint is a dialog that loses it
// on iOS), so the table is collected across awaits and asserted once — a check() body
// cannot await, and a rejection inside one is never seen.
const focusTable = /const PANEL_FOCUS = \{([\s\S]*?)\n\};/.exec(app)[1];
const focusRows = [...focusTable.matchAll(/(\w+): '([A-Za-z]+)'/g)].map((m) => [m[1], m[2]]);
const focusSeen = [];
for (const [name, target] of focusRows) {
  openOn(name);
  await tick(50);
  focusSeen.push([name, target, reg.get(target)._focused === true]);
}
check('focus lands on the field this panel is about', () => {
  // aria-modal dialogs must keep the tab ring inside, and focus on a *hidden* field puts
  // the caret somewhere nobody can see — the classic one-keyboard-stuck-in-the-void bug.
  assert.equal(focusRows.length, PANEL_IDS.length, 'PANEL_FOCUS is not one entry per panel');
  for (const name of PANEL_IDS) assert.ok(focusRows.some(([n]) => n === name), `PANEL_FOCUS has no ${name}`);
  for (const [name, target, seen] of focusSeen) {
    const body = html.slice(html.indexOf(`id="p-${name}"`), html.indexOf(`id="p-${name}"`) + 5200);
    assert.ok(body.includes(`id="${target}"`) || name === 'phone',
      `${name} focuses #${target}, which is not inside it`);
    assert.ok(seen, `${name} did not move focus to #${target}`);
  }
});
check('the rail is how you move, not a label strip', () => {
  // openOn arrives by hash, so nothing else in this suite proves the tabs do anything —
  // and a tab that only paints, without moving the panel or the URL, is the bug.
  openOn('key');
  reg.get('t-voice').fire('click');
  assert.equal(reg.get('p-voice').hidden, false, 'clicking the Voice tab changed nothing');
  assert.equal(reg.get('p-key').hidden, true, 'the old panel is still up');
  assert.equal(sandbox.location.hash, '#setup-voice', 'moving panel left the URL where it was');
});

check('the stepper stops at both ends instead of looping', () => {
  openOn('key');
  assert.equal(reg.get('panelPrev').disabled, true, 'Back is live on the first panel');
  assert.equal(reg.get('panelNext').disabled, false, 'Next is dead on the first panel');
  reg.get('panelNext').fire('click');
  assert.equal(reg.get('p-model').hidden, false, 'Next did not step');
  openOn('phone');
  assert.equal(reg.get('panelNext').disabled, true, 'Next is live on the last panel');
  reg.get('panelNext').fire('click');
  assert.equal(reg.get('p-phone').hidden, false, 'stepping past the end moved anyway');
});
check('nothing you can press lives inside a <label>', () => {
  // A button or a link nested in a <label> belongs to the labelled control: clicking it
  // focuses (and for a checkbox, toggles) that control, so "restore the built-in defaults"
  // also puts the caret in the persona box, and a screen reader reads the link text as part
  // of the field name. Two fields were built like that; the rule keeps them from creeping back.
  const offenders = [];
  for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    const inner = m[1];
    for (const t of inner.matchAll(/<(button|a)\b/g)) offenders.push(t[1]);
  }
  assert.deepEqual([...new Set(offenders)], [],
    'interactive elements nested in a label: ' + [...new Set(offenders)].join(', '));
  // And the two fields that used to be nested keep their accessible name.
  for (const [id, by] of [['fKey', 'keyLabel'], ['fPrompt', 'promptLabel']]) {
    assert.ok(html.includes(`id="${by}"`), `${id} lost its label element`);
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]{0,160}?aria-labelledby="${by}"`), `${id} is unlabelled`);
  }
});

check('the panel you are on is in the URL, and a pasted link opens it', () => {
  // The diagnosis says "pick another row"; the sentence is only worth anything if it can
  // be a link that lands on the one box that fixes the call.
  openOn('model');
  assert.equal(sandbox.location.hash, '#setup-model', 'the hash does not say where you are: ' + sandbox.location.hash);
  reg.get('sheetClose').fire('click');
  assert.equal(sandbox.location.hash, '', 'closing left a panel in the URL');
  sandbox.location.hash = '#setup-quality';
  reg.get('gearBtn').fire('click');
  assert.equal(reg.get('p-quality').hidden, false, 'a deep link opened the sheet on the wrong panel');
  assert.equal(reg.get('p-model').hidden, true, 'the deep link stacked two panels');
  sandbox.location.hash = '#setup-nonsense';
  reg.get('sheetClose').fire('click');
  reg.get('gearBtn').fire('click');
  assert.equal(PANEL_IDS.filter((n) => reg.get('p-' + n).hidden === false).length, 1,
    'an unknown #setup-* left the sheet with no panel, or with two');
  sandbox.location.hash = '';
});
check('Esc closes from any panel and takes the hash with it', () => {
  openOn('comfort');
  docFire('keydown', { code: 'Escape', target: reg.get('p-comfort') });
  assert.equal(reg.get('sheet').hidden, true, 'Esc did not close the sheet from a panel');
  assert.equal(sandbox.location.hash, '', 'the URL still claims a panel that is not on screen');
  assert.equal(reg.get('gearBtn')._focused, true, 'focus was not handed back to the gear');
});
check('the arrow keys walk the rail, but not out of a field', () => {
  openOn('turns');
  docFire('keydown', { code: 'ArrowRight', target: reg.get('nothing') });
  assert.equal(reg.get('p-session').hidden, false, 'ArrowRight did not step');
  // In a real browser a keydown inside <select> targets the select, whose tagName is
  // SELECT; the fake El has no tagName, so what is provable here is the guard itself —
  // without it, arrow keys stop being usable in the persona box and in every dropdown.
  assert.match(app, /tagName\) \|\| ''\)\.toUpperCase\(\)/, 'no tag sniffing on the arrow handler');
  assert.match(app, /INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'/, 'the guard does not cover the fields');
  // #setup-typo must not invent a section: getElementById happily creates one in this
  // harness and in a browser it gives you a sheet with nothing in it, so the guard is the
  // only thing standing between a mistyped link and a blank dialog.
  assert.match(app, /PANELS\.includes\(m\[1\]\)/, 'the hash is not validated against the panel list');
  assert.match(app, /if \(!PANELS\.includes\(name\)\) return false;/, 'showPanel accepts any name');
});
// Build a measurement first, then zero it: an assertion that the counters read 0.0s
// proves nothing if they never read anything else.
openOn('quality');
sockets.at(-1).from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(4800, 3).toString('base64') } }] } } });
await tick(320);
const metersBefore = ['sRecv', 'sCalls', 'sTokens'].map((id) => reg.get(id).textContent);
check('the counters can be zeroed, from the panel that explains them', () => {
  // Measured before and after a change is the only way to know a setting helped. With no
  // zero, "hybrid felt snappier" is a memory and p95 still carries every call since the
  // reload — so the number that looks like evidence is not.
  assert.ok(metersBefore[0] !== '0.0s', 'precondition: nothing was measured to reset');
  reg.get('statsReset').fire('click');
  assert.equal(reg.get('sRecv').textContent, '0.0s', 'audio played did not go back to zero');
  assert.equal(reg.get('sTokens').textContent, '0', 'tokens were not reset');
  assert.equal(reg.get('sTurnLat').textContent, '–', 'the turn number survived the reset');
  assert.equal(reg.get('sSpread').textContent, '–', 'p50/p95 survived the reset');
  assert.match(reg.get('thread').children.at(-1).text(), /from here/i, 'no note saying what the zero means');
});

check('the sheet is a grid that scrolls its panels, not its shell', () => {
  // .sheet-card owns the scroll: if a .panel did, the rail and the Save button would
  // slide away mid-form, and each panel would remember its own scroll position badly.
  assert.match(css, /\.sheet-card \{[^}]*grid-template-rows: auto auto 1fr auto/, 'the card is not rowed');
  assert.match(css, /\.panels \{[^}]*overflow-y: auto/, 'the panel area does not scroll');
  assert.ok(!/\.panel \{[^}]*display/.test(css), 'a display rule on .panel outranks [hidden]');
  assert.match(css, /\.tab\[aria-current="true"\][^{]*\{[^}]*background/, 'the active tab is only distinguished by colour');
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
let pcm = Buffer.alloc(4800 * 2); // 200 ms of 24 kHz int16
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


// ── behavioural checks for the voice-UX rules ──────────────────────────────
{
  // Ahead of the real clock, so any timestamp left behind before we take over
  // is in the past rather than a kilometre in the future.
  let fake = Date.now() + 1000;
  sandbox.performance.now = () => fake;
  const loud = () => procs[0].onaudioprocess({
    inputBuffer: { getChannelData: () => Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / 3) * 0.4) },
  });
  const quiet = () => procs[0].onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(2048) },
  });
  // Close whatever the earlier mic test left open, then run one whole utterance
  // on the fake clock — otherwise stats.since is stamped with the real clock and
  // every "held" duration below is a nonsense negative number.
  for (let i = 0; i < 3; i++) { fake += 20; quiet(); }

  check('backchannel ducks, it does not cut', () => {
    // Start the turn here rather than borrowing it from the check above: the fake audio
    // clock now ends playback for real, so a precondition that ages is a flaky test.
    sockets[0].from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } } });
    assert.equal(reg.get('orb').dataset.state, 'speaking', 'precondition: the agent must be talking');
    fake += 40; loud();           // speech starts
    fake += 40; loud();           // ~80ms of "haan" — under the 300ms commit line
    assert.equal(reg.get('orb').dataset.state, 'speaking', 'a short "haan" must not interrupt');
  });
  check('committed speech cuts the agent off', () => {
    fake += 420; loud();          // now held > 300ms: a real interrupt
    assert.equal(reg.get('orb').dataset.state, 'interrupted');
  });
  check('a spoken stop word cuts on words, not on energy', () => {
    for (let i = 0; i < 3; i++) { fake += 300; quiet(); }
    sockets[0].from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } } });
    assert.equal(reg.get('orb').dataset.state, 'speaking', 'precondition: agent must be talking');
    sockets[0].from({ serverContent: { inputTranscription: { text: 'ruko' } } });
    assert.match(reg.get('modePill').textContent, /interrupted/i);
  });
  check('a backchannel word leaves the agent talking', () => {
    sockets[0].from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } } });
    sockets[0].from({ serverContent: { inputTranscription: { text: 'haan' } } });
    assert.equal(reg.get('orb').dataset.state, 'speaking');
  });
  check('thinking appears on the turn boundary, not after a timeout', () => {
    for (let i = 0; i < 3; i++) { fake += 300; loud(); }   // finish the interruption
    sockets[0].from({ serverContent: { turnComplete: true } });
    for (let i = 0; i < 3; i++) { fake += 200; quiet(); }  // silence → end of turn
    assert.equal(reg.get('orb').dataset.state, 'thinking');
    assert.equal(reg.get('latBar').hidden, false, 'the latency bar is the spinner voice users need');
  });
  check('scroll position is respected, with a jump affordance', () => {
    const th = reg.get('thread');
    th.scrollHeight = 4000;
    th.scrollTop = 0;
    th.clientHeight = 600;
    sockets[0].from({ serverContent: { inputTranscription: { text: 'upar scroll kiya hai' } } });
    assert.equal(th.scrollTop, 0, 'the reader was yanked to the bottom');
    assert.equal(reg.get('jumpLatest').hidden, false, 'and got no way back');
  });
  check('mute is announced, not just coloured', () => {
    reg.get('muteBtn').fire('click');
    assert.equal(reg.get('muteBtn').getAttribute('aria-pressed'), 'true');
    assert.equal(reg.get('muteBtn').getAttribute('aria-label'), 'Unmute microphone');
    assert.equal(reg.get('orb').dataset.state, 'muted');
    reg.get('muteBtn').fire('click');
  });
  check('mic control is a real toggle button (aria-pressed tracks state)', () => {
    assert.equal(reg.get('pttBtn').getAttribute('aria-pressed'), 'true');
  });
}


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


// ── the research rules, checked against the actual markup and stylesheet ────
// ── the cascade trap that pinned the overlay open ───────────────────────────
check('hidden actually hides: the [hidden] guard survives the cascade', () => {
  // The UA sheet has [hidden]{display:none}, but an author rule that sets
  // `display` on the same element wins on cascade ORIGIN, so specificity never
  // gets a say. Result: el.hidden = true silently does nothing and an overlay is
  // un-closable. A global !important is the only reliable fix.
  const guard = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css);
  assert.ok(guard, 'no [hidden]{display:none !important} rule in styles.css');
});
check('no element hidden in the markup carries a display rule that outranks it', () => {
  // Which elements are authored hidden, and does any CSS rule give them a display?
  const hiddenEls = [...html.matchAll(/<(\w+)([^>]*\bhidden\b[^>]*)>/g)].map((m) => {
    const attrs = m[2];
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    const cls = /class="([^"]+)"/.exec(attrs)?.[1]?.split(/\s+/) || [];
    return { tag: m[1], id, cls };
  });
  assert.ok(hiddenEls.length >= 4, 'expected several hidden-by-default elements, saw ' + hiddenEls.length);
  const offenders = [];
  for (const el2 of hiddenEls) {
    const names = [el2.id && '#' + el2.id, ...el2.cls.map((c) => '.' + c)].filter(Boolean);
    for (const nm of names) {
      for (const m of css.matchAll(new RegExp('(^|\\})[^{}]*' + nm.replace(/[$()*+.?[\\\]^{|}/\\]/g, '\\$&') + '[^{]*\\{([^}]*)\\}', 'gm'))) {
        if (/display:\s*(?!none)/.test(m[2])) offenders.push(nm + ' { ' + m[2].trim().slice(0, 40) + ' }');
      }
    }
  }
  // Offenders are survivable *only* because of the !important guard — if someone
  // deletes that rule, this list becomes a live bug again.
  if (offenders.length) {
    assert.ok(/display:\s*none\s*!important/.test(css),
      'elements hidden in markup but given a display by CSS: ' + [...new Set(offenders)].join(', '));
  }
  // The settings dialog specifically must never be visible before it is opened.
  assert.match(html, /<div class="sheet" id="sheet" hidden>/, 'the sheet must start hidden in the HTML itself');
});

check('the guard trade-off is explicit in the saved config', () => {
  const saved = JSON.parse(localStorage.getItem('aryans-aicall/v0'));
  assert.equal(saved.guard, false, 'barge-in tests are meaningless if the guard silently stayed on');
});
check('every state has its own visual treatment', () => {
  const states = ['idle', 'connecting', 'listening', 'thinking', 'speaking', 'interrupted', 'muted', 'error'];
  const styled = states.filter(
    (st) => css.includes(`[data-state="${st}"]`) || (st === 'idle' && !css.includes('[data-state="idle"]'))
  );
  assert.equal(styled.length, states.length, 'unstyled states: ' + states.filter((x) => !styled.includes(x)));
});
check('listening and speaking do not share an animation', () => {
  // The single most-cited voice-UI mistake: identical motion for both states,
  // which leaves the user guessing and talking over the agent. Existence of a
  // rule per state is not enough — the keyframes must actually differ.
  const anims = (st) => {
    const out = new Set();
    for (const m of css.matchAll(new RegExp('\\[data-state="' + st + '"\\][^{]*\\{([^}]*)\\}', 'g'))) {
      for (const a of m[1].matchAll(/animation:\s*([^;]+);/g)) out.add(a[1].trim());
    }
    return out;
  };
  const listen = anims('listening');
  const speak = anims('speaking');
  assert.ok(listen.size && speak.size, 'one state has no animated treatment at all');
  const shared = [...listen].filter((a) => speak.has(a));
  assert.deepEqual(shared, [], 'identical motion for listen and speak: ' + shared.join(' | '));
});
check('state is never conveyed by colour alone', () => {
  // Every state must also drive text and an icon, not just a hue.
  assert.match(app, /GLYPH\s*=\s*\{[\s\S]*speaking[\s\S]*interrupted[\s\S]*muted/);
  assert.match(app, /el\.pill\.textContent = text/);
  assert.match(html, /<span class="state-icon"[^>]*aria-hidden="true"/);
});
check('live region pre-exists in the document (SC 4.1.3)', () => {
  // Inserting role=status together with its content is silent in screen readers.
  assert.match(html, /id="a11yStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<p class="sr-only" id="a11yStatus"/);
});
check('transcript is a polite log, not an assert', () => {
  assert.match(html, /id="thread"[^>]*role="log"/);
  assert.match(html, /id="thread"[^>]*aria-live="polite"/);
});
check('reduced motion honoured by OS *and* by an in-app override', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /html\[data-motion="reduce"\]/);
  assert.match(html, /id="fMotion"/);
});
check('light scheme defined, not just inverted dark', () => {
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
});
check('every button in the markup meets a tap target, derived from the markup', () => {
  // This check used to list five class names by hand, which meant a sixth was unmeasured:
  // the setup rail's tabs were 44px only because someone felt like it. Now the requirement
  // is read off the page — add a button class and it has to satisfy it.
  // `.linklike` is the one exemption, at 24px: it is a text-sized affordance inside a
  // sentence, and forcing 44 would break the line it sits in (2.5.8's minimum, not 2.5.5's).
  const inline = new Set(['linklike']);
  const classes = new Set();
  for (const m of html.matchAll(/<button[^>]*class="([^"]+)"/g)) {
    for (const c of m[1].trim().split(/\s+/)) classes.add(c);
  }
  assert.ok(classes.size >= 9, 'only found ' + classes.size + ' button classes — the scan is broken');
  const minHeight = (c) => {
    const blocks = [...css.matchAll(new RegExp('\\.' + c + '\\s*(?:,\\s*\\.' + c + ')*\\s*\\{([^}]*)\\}', 'g'))];
    return Math.max(0, ...blocks.map(([, body]) => Number((/min-height:\s*(\d+)px/.exec(body) || [])[1] || 0)));
  };
  const offenders = [];
  // Judged per element, not per class: `class="icon-btn ptt"` is held open by .icon-btn's
  // 44, and a per-class rule would demand a second one for no reason.
  for (const m of html.matchAll(/<button[^>]*class="([^"]+)"/g)) {
    const cs = m[1].trim().split(/\s+/);
    const want = cs.every((c) => inline.has(c)) ? 24 : 44;
    const got = Math.max(...cs.map(minHeight));
    if (got < want) offenders.push(`[${cs.join('.')}] ${got}px < ${want}px`);
  }
  assert.deepEqual([...new Set(offenders)], [], 'tap targets too small: ' + [...new Set(offenders)].join(', '));
});
check('audio cues stay under 150ms so they do not mask the first phoneme', () => {
  const m = [...app.matchAll(/t \+ (0\.\d+)/g)].map((x) => Number(x[1]));
  const cue = m.filter((v) => v > 0 && v <= 0.2);
  assert.ok(cue.length, 'no bounded cue envelope found');
  assert.ok(Math.max(...cue) <= 0.13, 'cue longer than 130ms will eat the first phoneme');
});
check('dead air is detected, not shrugged at', () => {
  assert.match(app, /1800/);
  assert.match(app, /deadair/);
});
check('barge-in is a policy with distinct outcomes', () => {
  assert.match(app, /BACKCHANNEL/);
  assert.match(app, /STOP_WORDS/);
  assert.match(app, /function\s+duck\s*\(\s*to\s*\)/);
});
check('endpointing quality is measured, not assumed', () => {
  assert.match(app, /falseCutoff/);
  assert.match(app, /q\(0\.95\)/, 'p95 must be tracked; averages hide the bad calls');
});


check('a blank persona resets to the default instead of persisting', () => {
  reg.get('fPrompt').value = '';
  reg.get('fGreet').value = '   ';
  reg.get('sheetSave').fire('click');
  const saved = JSON.parse(localStorage.getItem('aryans-aicall/v0'));
  assert.match(saved.prompt, /^You are Aryan's voice assistant/, 'empty save must not strip the persona');
  assert.ok(saved.greeting.length > 20, 'empty greeting must fall back to the default');
  assert.ok(saved.prompt.includes('<<connected>>'), 'repaired persona lost the CALL START contract');
});

// start a second call, then verify it greeted on its own terms
reg.get('pttBtn').fire('click');
await tick();
check('second session opens a fresh socket', () => {
  const ws2 = sockets[sockets.length - 1];
  assert.notEqual(ws2, sockets[0], 'expected a fresh socket for the second call');
  ws2.from({ setupComplete: {} });
});
await tick();
check('the new socket got the connected signal', () => {
  const ws2 = sockets[sockets.length - 1];
  const kick = ws2.frames('clientContent');
  assert.equal(kick.length, 1, 'kickedOff was not reset by teardown');
  assert.ok(kick[0].clientContent.turns[0].parts[0].text.startsWith('<<connected>>'));
});

// ── closing the dialog, by every route a person would try ───────────────────
check('the dialog opens and closes through the backdrop, the button and Esc', () => {
  const sheet = reg.get('sheet');
  const esc = () => { for (const fn of docHandlers.keydown || []) fn({ code: 'Escape' }); };

  reg.get('gearBtn').fire('click');
  assert.equal(sheet.hidden, false, 'gear button did not open the dialog');

  // a press starting inside the card and releasing on the backdrop must not close
  reg.get('sheet').fire('click', { target: reg.get('fKey') });
  assert.equal(sheet.hidden, false, 'click that began on a field dismissed the dialog');

  reg.get('sheet').fire('click', { target: sheet });   // a real backdrop tap
  assert.equal(sheet.hidden, true, 'backdrop tap did not close the dialog');

  reg.get('gearBtn').fire('click');
  reg.get('sheetClose').fire('click');
  assert.equal(sheet.hidden, true, 'the × button did not close the dialog');

  reg.get('gearBtn').fire('click');
  esc();
  assert.equal(sheet.hidden, true, 'Esc did not close the dialog');

  // Esc must not be swallowed by the dialog once it is gone
  reg.get('gearBtn').fire('click');
  esc();
  reg.get('sheet').fire('click', { target: sheet });
  assert.equal(sheet.hidden, true, 'dialog must end up closed, whatever order the taps came in');
});

// ── voice, tone and the audition path ───────────────────────────────────────
check('the voice rules are instructions the model can act on', () => {
  // Everything else in this file is wire or DOM. This one is the part that decides
  // whether it *sounds* good: the persona must forbid written-form output, and must
  // not contradict the digit-by-digit read-back rule that keeps numbers safe.
  const style = /VOICE STYLE([\s\S]*?)\nTONE/.exec(app);
  assert.ok(style, 'no VOICE STYLE block in the persona');
  assert.match(style[1], /[Cc]ontractions/);
  assert.match(style[1], /no lists|No lists/);
  assert.match(style[1], /one idea per turn/i);
  assert.match(style[1], /half-heard|never guess/i, 'no rule about a bad line');
  assert.match(style[1], /exception/i, 'number rules must resolve, not collide');
  assert.match(app, /echo them back digit by digit/, 'the read-back rule it defers to is gone');
});
check('all 30 prebuilt voices are offered, and the picker and the table agree', () => {
  const sel = /<select id="fVoice">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(sel, 'no #fVoice select');
  const names = [...sel[1].matchAll(/<option value="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 30, 'expected 30 voices, got ' + names.length);
  const tbl = /const VOICES = \{([\s\S]*?)\n\};/.exec(app);
  assert.ok(tbl, 'VOICES table not found');
  const keys = [...tbl[1].matchAll(/([A-Za-z]+):\s*'[^']+'/g)].map((m) => m[1]);
  assert.equal(keys.length, 30, 'VOICES table has ' + keys.length + ' entries');
  // A name the API does not know is dropped in silence (or rejects setup), which is
  // indistinguishable from "the picker is broken" — so neither list may drift.
  assert.deepEqual(names.filter((n2) => !keys.includes(n2)), [], 'picker offers an unknown voice');
  assert.deepEqual(keys.filter((n2) => !names.includes(n2)), [], 'table lists a voice the picker hides');
  const def = /voice: '([A-Za-z]+)'/.exec(app)[1];
  assert.ok(keys.includes(def), 'default voice ' + def + ' is not a real one');
});

reg.get('fTone').value = 'warm';
reg.get('fVoice').value = 'Achird';
reg.get('fSample').value = 'Haan ji, bol na — kya chal raha hai?';
reg.get('sheetSave').fire('click');
await tick();

check('the chosen tone reaches the real audio graph', () => {
  // Not "a select exists with a warm option" — the filter nodes must carry the warm
  // numbers, or the setting is another decorative control.
  const low = audio.nodes.filter((n) => n._kind === 'biquad' && n.type === 'lowshelf' && n.gain.value === 2.6);
  assert.ok(low.length, 'no low-shelf at +2.6 dB: the Warm setting never reached WebAudio');
  const hiss = audio.nodes.filter((n) => n._kind === 'biquad' && n.type === 'peaking' && n.frequency.value === 3200);
  assert.ok(hiss.length, 'no 3.2 kHz de-essing band — the frequency that makes TTS harsh');
  assert.ok(audio.nodes.some((n) => n._kind === 'compressor'), 'no compressor: loud turns will clip on a phone');
});

check('the tone chain actually terminates at the speakers', () => {
  const reaches = (from, to) => audio.edges.some(([a, b]) => a?._kind === from && b?._kind === to);
  assert.ok(reaches('compressor', 'destination'), 'chain does not reach destination — silent audio');
  assert.ok(reaches('gain', 'biquad'), 'outGain does not feed the chain, so ducking bypasses tone');
  assert.ok(reaches('buffersource', 'gain'), 'playback is not routed through outGain');
});

const ttsFetchCountBefore = fetches.length;
const socketsBeforeAudition = sockets.length;
const recvBefore = reg.get('sRecv').textContent;
const playedBefore = audio.played || 0;
reg.get('fAudition').fire('click');
await tick(4);

check('the audition speaks through the Live row, not a second TTS model', () => {
  const s = sockets[socketsBeforeAudition];
  assert.ok(s, 'clicking Hear this voice opened no socket — the preview is dead');
  assert.match(s.url, /GenerativeService\.BidiGenerateContent/, 'not a Live socket: ' + s.url);
  assert.equal(fetches.length, ttsFetchCountBefore,
    'the audition made a REST call; there is no REST path in this build');
  const setup = s.frames('setup')[0];
  assert.ok(setup, 'no setup frame on the audition socket');
  // The same nesting lesson as the call: voiceName anywhere other than
  // generationConfig.speechConfig is silently ignored, and the sample you audition is
  // the default voice wearing another name.
  assert.equal(
    setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Achird',
    'the audition must render the voice on screen, not the default one');
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.setup.model, 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    'a preview must come from the row the call will use');
  // An audition is not a call: no persona, no tools, nothing to save.
  assert.equal(setup.setup.systemInstruction, undefined, 'the audition is running a real session');
  assert.equal(setup.setup.tools, undefined, 'tools are advertised to a preview session');
  assert.equal(setup.setup.inputAudioTranscription, undefined, 'a preview does not need a transcription');
  // Nothing may be sent before setupComplete, so the turn frame can only exist after
  // the server says the session is live: that ordering is the API's, not a style choice.
  s.from({ setupComplete: {} });
  const turn = s.frames('clientContent')[0];
  assert.ok(turn, 'the audition never asked for a turn after setupComplete');
  assert.equal(turn.clientContent.turns[0].parts[0].text, 'Haan ji, bol na — kya chal raha hai?');
  assert.ok(turn.clientContent.turnComplete, 'an incomplete turn never produces audio');
  // No style directive smuggled into the text: a Live session reads it as content and
  // says the words out loud.
  assert.doesNotMatch(turn.clientContent.turns[0].parts[0].text, /say in a|warm tone|read this/i);
});

// 240 ms of 24 kHz int16, split across TWO events — 3.x rows put audio and transcript
// in one event and deliver parts in batches; a client that only reads the first part of
// the first event loses half the sample.
const sample = Buffer.alloc(24000 * 0.24 * 2);
for (let i = 0; i < sample.length / 2; i++) sample.writeInt16LE(Math.round(Math.sin(i / 6) * 5000), i * 2);
const aud = sockets[socketsBeforeAudition];
aud.from({ serverContent: { modelTurn: { parts: [
  { inlineData: { data: sample.subarray(0, sample.length / 2).toString('base64'), mimeType: 'audio/pcm;rate=24000' } },
  { text: 'Haan ji, ' },
] } } });
aud.from({ serverContent: { modelTurn: { parts: [
  { inlineData: { data: sample.subarray(sample.length / 2).toString('base64'), mimeType: 'audio/pcm;rate=24000' } },
  { text: 'bol na.' },
] }, outputTranscription: { text: 'Haan ji, bol na.' } } });
await tick(2);
check('the streamed sample is played, and is not counted as call audio', () => {
  assert.ok(audio.played - playedBefore >= 2,
    `audio did not stream: ${audio.played - playedBefore} of 2 chunks started`);
  assert.equal(reg.get('sRecv').textContent, recvBefore,
    'the audition inflated the call audio meter');
  // The preview must not be able to hold a live call in "agent talking": that state is
  // driven by the call's own playback queue.
  assert.match(app, /playBuffer\(chunk, \{ meter: false, track: false \}\)/,
    'the audition joins the call playback queue');
});
aud.from({ serverContent: { turnComplete: true } });
await tick(3);

check('the audition reports the voice, the row and the length', () => {
  const log = reg.get('sheetLog').textContent;
  assert.match(log, /Achird · Friendly/);
  assert.match(log, /0\.2s/);
  assert.match(log, /gemini-2\.5-flash-native-audio-preview-12-2025/, 'the row is not named: ' + log);
  assert.match(log, /same as a call/i, 'the sheet must say the preview is the real engine');
});
check('the audition socket is closed, and the button is pressable again', () => {
  const a = sockets[socketsBeforeAudition];
  assert.equal(a.readyState, 3, 'the throwaway session is still open');
  assert.equal(reg.get('fAudition').disabled, false, 'a stuck disabled button after one preview');
  assert.equal(reg.get('fAuditionSave').hidden, false, 'no way to keep the sample');
});

check('the sample is saved as a byte-exact 24 kHz WAV', () => {
  reg.get('fAuditionSave').fire('click');
  const blob = blobs.at(-1);
  assert.ok(blob, 'no blob was built for the download');
  assert.equal(blob.type, 'audio/wav');
  const w = blob.parts[0];
  const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  const ascii = (o) => String.fromCharCode(...w.subarray(o, o + 4));
  assert.equal(ascii(0), 'RIFF');
  assert.equal(ascii(8), 'WAVE');
  assert.equal(ascii(12), 'fmt ');
  assert.equal(dv.getUint16(20, true), 1, 'format must be PCM');
  assert.equal(dv.getUint16(22, true), 1, 'must be mono');
  assert.equal(dv.getUint32(24, true), 24000, 'Live audio is 24 kHz; anything else is chipmunk or slowed');
  assert.equal(dv.getUint16(34, true), 16, 'signed 16-bit');
  assert.equal(ascii(36), 'data');
  assert.equal(dv.getUint32(40, true), w.length - 44, 'data chunk size disagrees with the payload');
  assert.equal(dv.getUint32(4, true), 36 + w.length - 44, 'RIFF size disagrees');
  // The payload is the two streamed halves, concatenated, untouched.
  assert.equal(dv.getUint32(40, true), sample.length, 'the saved file is not the audio that was heard');
  assert.ok(urls.length >= 1, 'no object URL — nothing to click');
  assert.match(reg.get('fAuditionSave').textContent, /Saved/);
});

// The exact failure a user can produce on their own: a retired row, a quota wall, a
// blocked wss. A preview that comes back with nothing must still say something, must
// re-enable its button, and must be retryable — a latch left down is how a Settings
// sheet grows a button that does nothing until reload.
reg.get('fAudition').fire('click');
await tick(3);
const socketsAtEmpty = sockets.length;
const dead = sockets.at(-1);
assert.ok(dead, 'the retry preview opened no socket at all');
dead.onclose?.({ code: 1006 });
await tick(2);
check('a preview that comes back empty explains itself instead of shrugging', () => {
  assert.match(reg.get('sheetLog').textContent, /no audio|closed/i,
    'nothing explained the empty preview: ' + reg.get('sheetLog').textContent);
  assert.equal(reg.get('fAudition').disabled, false, 'the button stayed dead after one failure');
  assert.equal(reg.get('fAuditionSave').hidden, true, 'it offered to save a file that does not exist');
});
// A rejected setup is the single most likely way a preview fails — a retired row, or a
// voice name the row has never heard — and the row says exactly what it disliked. Swallow
// that and the user gets fifteen seconds of spinner and then a shrug.
reg.get('fAudition').fire('click');
await tick(3);
const broke = sockets.at(-1);
assert.ok(broke, 'a preview after a retry opened no socket');
broke.from({ setupError: { message: 'Model does not support the voice "Zephyr"' } });
await tick(2);
check('a rejected setup is reported as the row\'s complaint, not as a timeout', () => {
  const log = reg.get('sheetLog').textContent;
  assert.match(log, /does not support the voice/i, 'the model\'s own message was thrown away: ' + log);
  assert.match(log, /Model box/i, 'it did not say where to fix it: ' + log);
  assert.equal(reg.get('fAuditionSave').hidden, true, 'it offered to save a sample that was never rendered');
  assert.equal(reg.get('fAudition').disabled, false, 'the button stayed disabled after a rejection');
});

// Half a sample is still a sample: a line that drops mid-turn should leave the caller
// with what actually arrived rather than an error and nothing to compare.
reg.get('fAudition').fire('click');
await tick(3);
const partial = sockets.at(-1);
partial.from({ setupComplete: {} });
partial.from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: sample.slice(0, 1000).toString('base64') } }] } } });
await tick(3);
partial.close();          // no turnComplete: the line just went away
await tick(3);
check('audio that arrived before a dropped line is kept and reported', () => {
  const log = reg.get('sheetLog').textContent;
  assert.match(log, /gemini-2\.5-flash-native-audio/, 'the partial sample was reported as a failure: ' + log);
  assert.equal(reg.get('fAuditionSave').hidden, false, 'the audible part of the sample cannot be saved');
  assert.equal(reg.get('fAudition').disabled, false, 'button left disabled after a dropped preview');
});

const socketsAtRetry = sockets.length;
reg.get('fAudition').fire('click');
await tick(3);   // the preview opens its socket after its own awaits, like any caller would
check('a failed preview can be retried, so the latch is not one-way', () => {
  assert.equal(sockets.length, socketsAtRetry + 1,
    'second click opened nothing — the `auditioning` latch never released');
});
// Close it the way the browser would, so the tail of the suite is not counting a
// half-open preview as a broken call.
sockets.at(-1).close();
await tick(3);
check('a preview that never got a turn ends itself instead of idling open', () => {
  assert.equal(sockets.at(-1).readyState, 3, 'the throwaway session is still open');
  assert.match(reg.get('sheetLog').textContent, /no audio|closed|15s/i);
});


// ── the microphone must never be able to cancel a call ──────────────────────
if (reg.get('hangup').hidden === false) { reg.get('hangup').fire('click'); await tick(); }
const socketsBefore = sockets.length;
sandbox.navigator.mediaDevices.getUserMedia = async () => {
  throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
};
reg.get('pttBtn').fire('click');
await tick();

check('a refused microphone still opens a working call', () => {
  assert.equal(sockets.length, socketsBefore + 1, 'no session was opened — the mic blocked the whole call');
  const ws = sockets.at(-1);
  ws.from({ setupComplete: {} });
  assert.equal(ws.frames('clientContent').length, 1, 'no greeting without a mic? The caller should still be greeted');
  // 'thinking' is the honest label while the greeting is being generated; the resting
  // state after the turn is the one that must not lie about a missing microphone.
  assert.equal(reg.get('modePill').textContent, 'thinking');
  ws.from({ serverContent: { modelTurn: { parts: [{ text: 'hi' }] }, turnComplete: true } });
  assert.equal(reg.get('modePill').textContent, 'text in · voice out',
    'a session with no microphone must not go back to claiming it is listening');
  assert.equal(reg.get('muteBtn').hidden, true, 'a mute control for a mic we never got is a lie');
  assert.equal(reg.get('pushToTalk').hidden, true, 'push-to-talk with no microphone is a dead button');
  assert.equal(reg.get('micHelp').hidden, false, 'the reason must be on screen, not in the console');
});

check('the mic error says which of the four causes it is', () => {
  const why = reg.get('micWhy').textContent;
  assert.match(why, /permission not granted/i, 'got: ' + why);
  const how = reg.get('micHow').textContent;
  assert.match(how, /address bar|allow it/i, 'no actionable next step: ' + how);
  assert.equal(reg.get('micOpenTab').href, 'http://localhost:8787/', 'the escape hatch must point at this same page, top level');
});

check('the AudioContext is created before any await, on the tap', () => {
  // iOS/Safari will not resume a context built after the gesture has expired, and it
  // fails silently: no audio, no error. So the ordering is a correctness property.
  const body = /async function connect\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  const firstAwait = body.search(/await /);
  assert.ok(firstAwait >= 0, 'connect() has no awaits — check this test');
  assert.ok(body.indexOf('await ensureAudio()') >= 0, 'connect() must await ensureAudio() explicitly');
  assert.ok(body.indexOf('await ensureAudio()') < firstAwait + 'await '.length + 20,
    'ensureAudio is not the first await in connect()');
  assert.ok(body.indexOf('openMic') > body.indexOf('ensureAudio'),
    'the mic is opened before the context exists, which leaks a suspended context');
});

// ── markup: the class of bug hand-editing HTML keeps producing ───────────────
check('index.html nests cleanly', () => {
  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  const stack = [];
  const errs = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (selfClose || VOID.has(tag)) continue;
    const line = html.slice(0, m.index).split('\n').length;
    if (!close) stack.push([tag, line]);
    else if (!stack.length) errs.push(`line ${line}: </${tag}> with nothing open`);
    else if (stack.at(-1)[0] !== tag) {
      errs.push(`line ${line}: </${tag}> closes <${stack.at(-1)[0]}> from line ${stack.at(-1)[1]}`);
      stack.pop();
    } else stack.pop();
  }
  if (stack.length) errs.push('unclosed: ' + stack.map(([t, l]) => `<${t}>@${l}`).join(', '));
  assert.deepEqual(errs, [], errs.join(' | '));
});

// ── "it says connecting but not": the handshake must always land somewhere ─────
// A failed WebSocket upgrade gives the browser nothing — no status, no body, often
// only code 1006. Everything below exists so the user is never left holding a spinner.
const settle = (ms = 650) => new Promise((r) => setTimeout(r, ms));
// End whatever call is live, including one that never settled (its hangup button is not
// on screen yet, but the Start button is a teardown while a socket exists). Leaving a
// session open makes the *next* block's socket counts lie, and holds a pending timer.
const isLive = () =>
  reg.get('hangup').hidden === false || /connecting|reconnecting/i.test(reg.get('modePill').textContent);
const endEverything = async () => {
  for (let i = 0; i < 4 && isLive(); i++) {
    if (reg.get('hangup').hidden === false) reg.get('hangup').fire('click');
    else reg.get('pttBtn').fire('click'); // a call still connecting: Start is a cancel
    await settle(140);
  }
};
const threadText = () => (reg.get('thread').children || []).map((c) => c.textContent || '').join('\n');

// Nothing may be left half-open here: the ladder below counts sockets to know it broke
// the right one, and a stray in-flight socket would make every check after it lie.
if (reg.get('hangup').hidden === false) { reg.get('hangup').fire('click'); await settle(80); }
const beforeLadder = sockets.length;
reg.get('pttBtn').fire('click');
await settle(80);
const s1 = sockets.at(-1);

check('the ladder test has a live, unsettled socket to break', () => {
  assert.equal(sockets.length, beforeLadder + 1, 'expected exactly one new socket');
  assert.equal(typeof s1.onclose, 'function', 'the app did not attach its close handler');
});

s1.onclose({ code: 1006, reason: '' });
await settle();

check('a dead socket is diagnosed against the key, not shrugged at', () => {
  const probe = fetches.filter((f) => f.url.includes('/models'));
  assert.ok(probe.length, 'no model probe was made when the socket died');
  assert.match(probe.at(-1).url, /pageSize=200/);
  assert.match(threadText(), /not a row this key can see/, 'nothing said why: ' + threadText().slice(-150));
  assert.match(reg.get('modelHint').textContent, /is not visible to this key/);
  assert.equal(reg.get('modelHint').dataset.bad, '1');
});

check('the row the ladder retries onto is judged by what it supports', () => {
  // 3.8 is the row the retry picks, so this is also the only place the capable-row
  // behaviour is asserted on the *retry* frame rather than the first attempt.
  const retry = sockets.at(-1);
  void retry;
  assert.match(app, /const capableRow = capable\(cfg\.model\);/, 'the frame is not judged per row');
});

check('the model picker is filled from what the key can see', () => {
  const dl = reg.get('modelList');
  const order = dl.children.map((k) => k.value);
  // The picker shows Live rows only — the key's whole model list is not a choice list.
  assert.equal(dl.children.length, 4, 'datalist rows: ' + order.join(','));
  assert.ok(order.includes('models/gemini-2.5-flash-native-audio-preview-08-2025'),
    'a Live row was missed because its name does not say "live": ' + order.join(','));
  // Newest major first, and inside 2.5 a text-only row must not outrank a native-audio
  // one — that row connects and then has nothing to play.
  assert.deepEqual(order, [
    'models/gemini-3.8-live',
    'models/gemini-live-2.5-flash-native-audio',
    'models/gemini-2.5-flash-native-audio-preview-08-2025',
    'models/gemini-2.5-flash-live-preview',
  ], 'wrong picker order: ' + order.join(' → '));
});

check('the first retry changes exactly one thing: the row, frame untouched', () => {
  const s2 = sockets.at(-1);
  assert.notEqual(s2, s1, 'no retry socket appeared');
  const setup = s2.frames('setup')[0].setup;
  assert.equal(setup.model, 'models/gemini-3.8-live');
  assert.ok(setup.generationConfig?.speechConfig, 'the frame was degraded too — two variables changed at once');
  assert.ok(setup.systemInstruction, 'the persona was dropped along with it');
});

const s2 = sockets.at(-1);
s2.onclose({ code: 1006, reason: '' });
await settle();

check('the second failure varies the frame, since the row is now correct', () => {
  const s3b = sockets.at(-1);
  assert.notEqual(s3b, s2, 'no second retry socket');
  const setup = s3b.frames('setup')[0].setup;
  assert.equal(setup.model, 'models/gemini-3.8-live');
  // This assertion used to read `setup.generationConfig === undefined` — "the plain frame
  // has nothing in it" — and the app obeyed it for a whole release while the endpoint
  // answered every such frame with 1007 Unknown name "responseModalities" at 'setup'.
  // The check was written against the code, not the proto, so it pinned the bug in place.
  // "Plain" never meant empty: it means no voice, no VAD, no transcription, no tools.
  assert.deepEqual(setup.generationConfig, { responseModalities: ['AUDIO'] },
    'the minimal frame must still declare AUDIO output, just where the proto keeps it');
  assert.equal(setup.responseModalities, undefined,
    'a generation field is sitting flat on setup again — that is the shape Google refuses');
  for (const fancy of ['speechConfig', 'realtimeInputConfig', 'inputAudioTranscription',
    'outputAudioTranscription', 'systemInstruction', 'tools', 'sessionResumption']) {
    assert.equal(setup[fancy], undefined, `the "minimal" frame still carries ${fancy}`);
    assert.equal(setup.generationConfig?.[fancy], undefined, `${fancy} leaked into generationConfig`);
  }
});

const s3 = sockets.at(-1);
s3.from({ setupComplete: {} });
await settle(80);

check('the row that actually connected is banked, not merely used', () => {
  const saved = JSON.parse(localStorage.getItem('aryans-aicall/v0'));
  assert.equal(saved.model, 'models/gemini-3.8-live',
    'otherwise the next reload retries the broken row from scratch');
  assert.match(threadText(), /saved as your model row/);
});

// The bug this encodes: teardown() closes the socket, the close event routed into the
// diagnosis, the diagnosis called teardown() again — recursion, and worse, a retry that
// reopened a call the user had just cancelled.
const socketsAtHangup = sockets.length;
reg.get('hangup').fire('click');
await settle(200);
check('a hangup is not a connection failure, and never reopens the call', () => {
  assert.equal(sockets.length, socketsAtHangup, 'hanging up opened another socket');
  assert.match(reg.get('modePill').textContent, /idle/);
});

check('the spinner cannot last forever: deadline armed, deduped, cancelled on success', () => {
  // The socket (and so the deadline) is opened by openCallSocket, which the mid-call
  // line refresh reuses: a refresh without a deadline is a call that hangs forever at
  // minute 13, which is worse than the failure it exists to avoid.
  const body = /function openCallSocket\([^)]*\) \{([\s\S]*?)\n\}/.exec(app);
  assert.ok(body, 'openCallSocket not found');
  const opener = body[1];
  assert.match(opener, /armHandshake\(\)/, 'the call socket never arms the handshake deadline');
  assert.match(/async function connect\(\) \{([\s\S]*?)\n\}/.exec(app)[1], /openCallSocket\(\)/,
    'connect() builds its own socket, so the refresh and the first call can drift apart');
  const ms = Number(/const HANDSHAKE_MS = (\d+);/.exec(app)[1]);
  assert.ok(ms >= 3000 && ms <= 20000, `deadline of ${ms}ms is either flaky or cruel`);
  assert.match(app, /if \(diagOnce\) return;/, 'error and close both fire: one failure must not book two retries');
  assert.match(app, /clearTimeout\(handshakeTimer\);\n\s*handshakeTries = 0;/, 'setupComplete must cancel the deadline');
  assert.match(app, /handshakeTries >= 2/, 'no cap on retries — a dead network would loop forever');
  // The give-up line, checked as behaviour rather than as a phrase, so rewording it
  // cannot silently retire the test: the branch must tell the user, must tear down, and
  // must NOT re-print the reason the previous line already said — repeating a four-sentence
  // paragraph in a second colour is how the dead call ended up a wall of red mono text.
  const giveUp = /if \(handshakeTries >= 2\) \{([\s\S]*?)\n  \}/.exec(app);
  assert.ok(giveUp, 'no give-up branch after the retry cap');
  assert.match(giveUp[1], /note\(/, 'the user is never told the retries stopped');
  assert.match(giveUp[1], /teardown\(\);/, 'the spinner keeps spinning after giving up');
  assert.match(giveUp[1], /return;/, 'the give-up path falls through and retries anyway');
  assert.doesNotMatch(giveUp[1], /note\(why/, 'the give-up line re-prints the diagnosis the line above already gave');
});

check('the failure that needs a new row opens the panel that has it', () => {
  // The whole point of splitting the sheet into panels is this: a retired row is fixed in
  // one box, and "go change it in the settings" makes the caller hunt through a form while
  // the call is dead. So the link is not a nicety, it is the repair step.
  const err = /function reportError\(err\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(err, /NOT_FOUND\|404\|no such model\|unsupported/, 'the retired-row test is gone');
  assert.match(err, /openSheet\('model'\)/, 'the row failure no longer lands on the Model panel');
});

// ── the dialog keeps the keyboard ────────────────────────────────────────────
// The sheet is a full-viewport overlay, so the page behind it is still in tab order. These
// checks need real containment, and it comes from the markup: every id between the sheet's
// opening tag and the `</div>` that closes it at column zero is a descendant of the sheet, which
// is exactly the rule a browser applies. Typed here it would drift the first time a control
// moved in or out of the dialog.
const sheetIds = (() => {
  const open = html.indexOf('<div class="sheet"');
  const close = html.indexOf('\n</div>', open);
  const inside = [...html.slice(open, close).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const sheetEl = document.getElementById('sheet');
  for (const id of inside) sheetEl.appendChild(document.getElementById(id));
  // One of each, or the containment below proves nothing: a sheet with no children contains
  // nothing, and a guard tested against that would be green for the wrong reason.
  return inside;
})();

check('only the open and close functions may show or hide the sheet', () => {
  // `inert` is applied by openSheet and lifted by closeSheet. A third writer of the visibility
  // flag — a `sheet.hidden = false` in some future deep-link handler, say — opens the dialog
  // with the page behind still inert, and the app becomes its own keyboard trap: nothing on
  // screen answers Tab, and there is no error anywhere to read.
  const writes = [...app.matchAll(/^\s*el\.sheet\.hidden\s*=/gm)];
  assert.equal(writes.length, 2, `expected 2 writes of sheet.hidden, found ${writes.length}`);
  const openAt = app.indexOf('const openSheet = ');
  const closeAt = app.indexOf('const closeSheet = () => {');
  for (const w of writes) {
    const inOpen = w.index > openAt && w.index < closeAt;
    const inClose = w.index > closeAt && w.index < closeAt + 700;
    assert.ok(inOpen || inClose,
      `a sheet.hidden write at offset ${w.index} is outside openSheet/closeSheet`);
  }
  // And Escape, which the keyboard user actually presses, goes through closeSheet rather than
  // poking the flag itself — that is how the inert and hash cleanup survive a new dismiss path.
  const escAt = app.indexOf("if (e.code === 'Escape' && !el.sheet.hidden)");
  assert.ok(escAt > 0, 'the Escape branch was not found at all');
  // slice(start, start + n), not slice(start, n): the second form silently reads the first 220
  // characters of the file, which is a way for an assertion to be about nothing at all.
  const esc = app.slice(escAt, escAt + 220);
  assert.match(esc, /closeSheet\(\)/, 'Escape must call closeSheet');
  assert.doesNotMatch(esc, /sheet\.hidden\s*=/, 'Escape must not write the flag directly');
});

check('the fake DOM contains both sides of the dialog boundary', () => {
  const sheetEl = document.getElementById('sheet');
  {
    assert.ok(sheetIds.includes('sheetClose') && sheetIds.includes('fKey'),
      'the sheet is expected to own its controls');
    assert.ok(!sheetIds.includes('gearBtn') && !sheetIds.includes('composer'),
      'the page behind must stay outside the sheet subtree');
    assert.equal(sheetEl.contains(document.getElementById('sheetClose')), true);
    assert.equal(sheetEl.contains(document.getElementById('gearBtn')), false);
    assert.ok(sheetIds.length >= 20, `only ${sheetIds.length} ids inside the sheet, which is not all of them`);
    assert.ok(!sheetIds.includes('gearBtn'), 'the gear must be outside');
  }
});

check('the page behind the dialog is inert while it is open, and not afterwards', () => {
  openOn('key');
  const kids = document.body.children;
  const sheetEl = document.getElementById('sheet');
  const tagOf = (k) => `${(k.tagName || k.tag) || 'anon'}${k === sheetEl ? '(dialog)' : ''}${k.inert === true ? '=inert' : ''}`;
  // A set equality, not a one-directional "nothing was missed". Asserting only that no
  // focusable child survived would also pass when the app inerted the <script> tag it is told
  // to skip, because the filter and the app would be excluding the same node — a check written
  // around its own subject. Both sides have to be pinned: exactly these nodes, no more.
  const expected = kids.filter((k) => k !== sheetEl && !['SCRIPT', 'STYLE'].includes(k.tagName));
  const got = kids.filter((k) => k.inert === true);
  assert.deepEqual(got.map(tagOf).sort(), expected.map(tagOf).sort(),
    `inerted set is not the background set\n        expected ${expected.map((k) => k.tagName).join(',') || '∅'}\n        got      ${kids.filter((k) => k.inert === true).map((k) => k.tagName).join(',') || '∅'}`);
  assert.ok(expected.length >= 3, `the page behind has only ${expected.length} nodes: ${expected.map((k) => k.tagName).join(', ')}`);
  assert.notEqual(sheetEl.inert, true, 'the dialog itself must never be inert');
  reg.get('sheetClose').fire('click');
  const left = kids.filter((k) => k.inert === true).map((k) => k._tag || k.tag);
  assert.deepEqual(left, [], `still inert after close: ${left.join(', ')}`);
});

check('un-inerting happens before focus goes back to the gear', () => {
  // Order is the whole bug: focus on an inert element is refused, silently, so a closeSheet
  // that focuses first and un-inerts second leaves the keyboard nowhere and looks like a
  // handler that never ran.
  const body = app.slice(app.indexOf('const closeSheet = () => {'));
  const until = body.indexOf('};');
  const seq = body.slice(0, until);
  const un = seq.indexOf('setBackgroundInert(false)');
  const focus = seq.indexOf("$('gearBtn').focus()");
  assert.ok(un >= 0 && focus >= 0, `expected both calls in closeSheet, got ${JSON.stringify(seq.slice(0, 200))}`);
  assert.ok(un < focus, 'focus before inert=false is a focus that does nothing');
});

check('focus that escapes the dialog is pulled back to the panel that is open', () => {
  openOn('voice');
  const sheetEl = document.getElementById('sheet');
  // Inside first: a guard that yanks focus back on every focusin would make the dialog
  // unusable and still satisfy a test that only checks the escape case.
  const before = document.getElementById('fVoice');
  before._focused = false;
  docFire('focusin', { target: before });
  assert.notEqual(before._focused, true, 'a focus move inside the sheet must be left alone');
  assert.notEqual(sheetEl.contains(before), false, 'fVoice should be inside the sheet');
  // Now the escape: the browser has moved focus to a control on the page behind.
  const outside = document.getElementById('gearBtn');
  docFire('focusin', { target: outside });
  assert.equal(document.getElementById('fVoice')._focused, true,
    'escaping focus should come back to the field this panel is about');
  // And with the sheet closed, the guard has no business touching anything.
  reg.get('sheetClose').fire('click');
  const stray = document.getElementById('composer');
  stray._focused = false;
  docFire('focusin', { target: stray });
  assert.equal(stray._focused, false, 'no rescue when the dialog is not open');
});

check('a thrown WebSocket constructor is reported, not swallowed', () => {
  const body = /function openCallSocket\([^)]*\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(body, /try \{\s*ws = new WebSocket\(url\);/, 'construction is unguarded');
  assert.match(body, /Could not open the socket at all/);
});

check('teardown detaches handlers before closing', () => {
  const t = /function teardown\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(t, /ws = null;\n\s*if \(sock\)/, 'the socket must be unreachable before close fires its event');
  assert.match(t, /sock\.onclose = null;/);
});

check('the AudioContext survives a hangup instead of being closed', () => {
  // Chrome caps live contexts per page (~6) and then refuses more, silently: a
  // per-call close() is how "TTS stopped working after a while" gets written.
  assert.doesNotMatch(app, /actx\?\.close\(\)/, 'teardown must not close the page-level context');
  const t = /function teardown\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(t, /el\.outGain\?\.disconnect\(\)/, 'teardown should still drop this call\u2019s graph');
});

check('the model probe works in keysafe mode too', () => {
  const path = /const MODELS_PATH = '([^']+)'/.exec(app);
  assert.ok(path, 'MODELS_PATH missing');
  const srv = fs.readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
  assert.ok(srv.includes(`url.pathname === '/${path[1]}'`), `server has no /${path[1]} route`);
  assert.match(srv, /'x-goog-api-key': GEMINI_API_KEY/);
  // "Test" must not keep a private probe, or it can pass while connect() fails.
  assert.match(app, /const info = await refreshModels\(false\);/);
  assert.ok(!/\?key=\$\{encodeURIComponent\(k\)\}/.test(app), 'sheetTest still builds its own URL');
});

// ── the Live API surface: what the setup frame asks for, and what it obeys ──────
const srv = fs.readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
// Everything below is the part of the product that only Google's Live row can do, so
// it is asserted on the wire rather than in prose. A field the row does not know is a
// rejected setup — and a rejected setup is a dead socket, which users read as a broken
// key. So "ask for more, but only where more is documented" is a correctness rule.
const setModel = async (m, caps) => {
  if (reg.get('hangup').hidden === false) { reg.get('hangup').fire('click'); await settle(80); }
  reg.get('fModel').value = m;
  if (caps) reg.get('fCaps').value = caps;
  reg.get('sheetSave').fire('click');
  await settle(80);
  reg.get('pttBtn').fire('click');
  await settle(80);
  return sockets.at(-1);
};

const sFull = await setModel('models/gemini-3.1-flash-live-preview');
check('a capable row is asked for word-timed captions, vocabulary and a resumable line', () => {
  const setup = sFull.frames('setup')[0].setup;
  const vocab = setup.inputAudioTranscription.customVocabulary;
  assert.ok(Array.isArray(vocab) && vocab.length, 'no vocabulary biasing on a row that supports it');
  assert.ok(vocab.length <= 100, 'Google reports best results at <=100 terms, got ' + vocab.length);
  assert.ok(vocab.includes('WhatsApp') && vocab.includes('OTP'),
    'the words an Indian phone call actually contains are missing');
  assert.equal(setup.outputAudioTranscription.wordTimestamp, true,
    'captions cannot be timed without word timestamps');
  assert.ok(setup.sessionResumption, 'no resumption requested — a drop costs the whole call');
  assert.equal(setup.proactivity, undefined,
    'proactivity is not supported on this row: sending it is how the socket dies');
});
check('the model row in the markup is a Live row the frame can use', () => {
  const val = /<input id="fModel"[^>]*value="([^"]+)"/.exec(html)[1];
  const rows = [...html.matchAll(/<datalist id="modelList">([\s\S]*?)<\/datalist>/g)][0][1];
  const opts = [...rows.matchAll(/value="([^"]+)"/g)].map((m2) => m2[1]);
  assert.ok(opts.includes(val), 'the default input value is not offered: ' + val);
  assert.ok(!opts.some((o) => /tts/i.test(o)), 'a separate TTS row crept into the picker');
  // The default in the file and the default in the markup must be the same row, or the
  // sheet shows one thing and an unsaved Start sends another.
  const def = /model: '(models\/[^']+)'/.exec(app)[1];
  assert.equal(def, val, `DEFAULTS.model ${def} != markup default ${val}`);
  assert.ok(opts.every((o) => /live|native-audio/i.test(o)), 'a row that cannot speak is in the picker');
});

const sLean = await setModel('models/gemini-2.5-flash-native-audio-preview-12-2025');
check('an older row gets the smaller frame, and is told to always answer', () => {
  const setup = sLean.frames('setup')[0].setup;
  assert.deepEqual(setup.inputAudioTranscription, {}, 'fields this row may not know were sent anyway');
  assert.equal(setup.inputAudioTranscription.customVocabulary, undefined);
  assert.equal(setup.sessionResumption, undefined, 'resumption is not on this row — asking is a rejection');
  assert.deepEqual(setup.proactivity, { proactiveAudio: false },
    'a model allowed to skip "irrelevant" input will skip a caller mid-sentence');
  // The voice still has to arrive, or the gating looks like the old silent-drop bug.
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Achird');
});

reg.get('fCaps').value = 'lean';
reg.get('sheetSave').fire('click');
await settle(80);
reg.get('pttBtn').fire('click');
await settle(80);
check('the user can overrule the judgement, in both directions', () => {
  const setup = sockets.at(-1).frames('setup')[0].setup;
  assert.equal(setup.sessionResumption, undefined, 'Lean still asked for new fields');
  assert.equal(setup.proactivity, undefined, 'Lean still sent row-specific config');
  assert.ok(setup.generationConfig.speechConfig, 'Lean dropped the voice too — it is a frame, not a reset');
  assert.deepEqual(setup.tools?.[0]?.functionDeclarations?.length >= 2, true, 'tools vanished with the capabilities');
});
reg.get('fCaps').value = 'auto';
reg.get('fModel').value = 'models/gemini-3.1-flash-live-preview'; // the event tests below need a capable row
reg.get('sheetSave').fire('click');
await settle(80);
reg.get('pttBtn').fire('click');
await settle(80);

await endEverything();
const beforeNext = sockets.length;
reg.get('pttBtn').fire('click');
await settle(140);
const sNext = sockets.at(-1);
assert.ok(sNext && sockets.length > beforeNext, 'the new call opened no socket');
sNext.from({ setupComplete: {} });
await settle(60);
sNext.from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(4800, 7).toString('base64') } }] } } });
await settle(320);
sNext.from({ serverContent: { turnComplete: true } });
await settle(6);
check('a hangup clears the two claims about the model', () => {
  // 'waiting for you' and 'still reasoning' describe a turn on the OLD socket. Left set,
  // they hold the next call's orb at thinking forever — which reads exactly like a model
  // that has not answered yet, on a line that is fine.
  assert.notEqual(reg.get('orb').dataset.state, 'thinking', 'a stale claim kept the new call "thinking"');
  // Asserted as "does not still say", because this harness has no microphone: the honest
  // released state here is 'text in · voice out', and pinning 'listening' would only test
  // whether the fake grants consent.
  assert.ok(!/still reasoning|agent talking/i.test(reg.get('modePill').textContent),
    'the new call inherited a claim about the old one: ' + reg.get('modePill').textContent);
});
await endEverything();

check('hangup resets both model claims, by name, in teardown', () => {
  // Not observable through behaviour here: the fake audio clock drains the queue and
  // repaints the pill either way, so a stale claim hides behind it. The rule is still
  // real — these two flags describe a turn on a socket that no longer exists — so it is
  // asserted where it can be: inside the function that ends a call.
  const body = app.slice(app.indexOf('function teardown()'), app.indexOf('function teardown()') + 1400);
  for (const line of ['holdPill = false;', 'serverBusy = false;', 'clearTimeout(busyWatchdog);']) {
    assert.ok(body.includes(line), `teardown does not reset ${line}`);
  }
});

check('a stuck IN_PROGRESS has a ceiling', () => {
  // A row is allowed to say IN_PROGRESS and then end the session mid-reasoning. Without a
  // bound the caller stares at "still reasoning" on a dead line forever — the one state a
  // voice UI must never reach. Not worth 20 s of suite time to watch a timer fire, so the
  // bound is asserted where it is written, inside the function that arms it.
  const at = app.indexOf('function setInteractionStatus');
  const body = app.slice(at, at + 1700);
  assert.ok(/busyWatchdog = setTimeout\(/.test(body), 'no watchdog behind the claim');
  assert.ok(/serverBusy = false/.test(body), 'the watchdog does not release the claim it armed');
  const ms = body.match(/\},\s*(\d+)\);/);
  assert.ok(ms, 'the watchdog has no literal bound to reason about');
  assert.ok(Number(ms[1]) >= 5000 && Number(ms[1]) <= 60000,
    `a ${ms[1]} ms ceiling is either a second opinion or a dead call`);
});

const sOld = await setModel('models/gemini-live-2.0-flash-exp');
check('a row this file has never heard of gets the smallest frame', () => {
  // The judgement is positive-only: "not 2.5" is not evidence that a row knows the
  // 2026-era fields, and a setup it cannot parse is a dead socket blamed on the key.
  const setup = sOld.frames('setup')[0].setup;
  assert.equal(setup.sessionResumption, undefined, 'asked a 2.0 row to resume');
  assert.deepEqual(setup.inputAudioTranscription, {}, 'vocabulary biasing sent to a row that does not document it');
  assert.equal(setup.proactivity, undefined, 'proactivity sent outside the rows it exists on');
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Achird',
    'the one setting every Live row shares must survive every gate');
  if (reg.get('hangup').hidden === false) { reg.get('hangup').fire('click'); }
});

// Put the row back: every check below drives a *capable* row, because that is where the
// new server events actually arrive from.
await setModel('models/gemini-3.1-flash-live-preview');
const sEv = sockets.at(-1);
assert.ok(sEv.sent.some((f) => 'setup' in f), 'the event socket never got a setup frame');
sEv.from({ setupComplete: {} });
await settle(80);
check('partial input captions stream while the caller is still talking', () => {
  sEv.from({ serverContent: { interimInputTranscription: { text: 'mera or' } } });
  sEv.from({ serverContent: { interimInputTranscription: { text: 'mera order 44' } } });
  const live = (reg.get('thread').children || []).filter((c) => (c.className || '').includes('live'));
  assert.equal(live.length, 1, 'expected exactly one provisional caption, saw ' + live.length);
  assert.match(live[0].text(), /mera order 44$/, 'the interim bubble was appended to instead of overwritten: ' + live[0].text());
});
check('the final transcript replaces the provisional one instead of doubling it', () => {
  sEv.from({ serverContent: { inputTranscription: { text: 'mera order 4471 check karo' } } });
  sEv.from({ serverContent: { turnComplete: true } });
  const still = (reg.get('thread').children || []).filter((c) => (c.className || '').includes('live'));
  assert.deepEqual(still, [], 'a stale "live" caption is still blinking at the user');
  const all = (reg.get('thread').children || []).map((c) => c.text()).join('\n');
  assert.match(all, /mera order 4471 check karo/);
  assert.equal((all.match(/mera order/g) || []).length, 1, 'the sentence was logged twice');
});
check('a transcript line carries the time it was said at, in either spelling', () => {
  // Offsets are proto Durations: "74s", or {seconds:74}. Read both, and invent neither:
  // a line the row gives no offset for gets no time at all, because a guessed timestamp
  // in a log people treat as evidence is worse than a missing one.
  const before = (reg.get('thread').children || []).length;
  sEv.from({ serverContent: { inputTranscription: { text: 'OTP 8891 bhej do', startOffset: '74s' } } });
  sEv.from({ serverContent: { turnComplete: true } });
  sEv.from({ serverContent: { outputTranscription: { text: 'bhej diya, check kar lijiye', startOffset: { seconds: 78, nanos: 400000000 } } } });
  sEv.from({ serverContent: { turnComplete: true } });
  sEv.from({ serverContent: { outputTranscription: { text: 'aur kuch?' } } });
  sEv.from({ serverContent: { turnComplete: true } });
  const kids = (reg.get('thread').children || []).slice(before);
  assert.equal(kids.length, 3, `expected two agent lines and one caller line, saw ${kids.length}`);
  assert.equal(kids[0].dataset.t, '1:14', `no offset on the caller's line: ${kids[0].text()}`);
  assert.match(kids[1].querySelector('.ts').textContent, /1:18/, 'a {seconds,nanos} Duration was not read');
  assert.equal(kids[2].dataset.t, undefined, 'a line with no offset was given a time anyway');
});
check('a caption that was streamed gets the same timestamp as one that was not', () => {
  // Two paths build the caller's line — merged into the interim bubble, or appended fresh
  // — and a transcript that is timed only when you were not watching it arrive is a
  // transcript you cannot quote back. `dataset.t` is the assertion, because the fake's
  // querySelector invents a node rather than returning null.
  const before = (reg.get('thread').children || []).length;
  sEv.from({ serverContent: { interimInputTranscription: { text: 'mer' } } });
  sEv.from({ serverContent: { inputTranscription: { text: 'mera bill kitna hai', startOffset: { seconds: 125 } } } });
  sEv.from({ serverContent: { turnComplete: true } });
  const kids = (reg.get('thread').children || []).slice(before);
  assert.equal(kids.length, 1, 'the interim bubble was not reused for the final line');
  assert.equal(kids[0].dataset.t, '2:05', 'the streamed caption lost its timestamp');
});

check('"still reasoning" beats a floor hand-over the caller would talk over', () => {
  // The failure this exists for: turnComplete arrives, the app assumes the exchange is
  // over, shows "listening", and the caller starts talking on top of an answer that is
  // still being composed. interactionStatus is the server's own answer to that, so it
  // outranks the turn boundary.
  sEv.from({ serverContent: { turnComplete: true } }); // a quiet moment to be sure of
  assert.notEqual(reg.get('orb').dataset.state, 'thinking', 'precondition: the orb was already "thinking", so the check proves nothing');
  sEv.from({ serverContent: { interactionStatus: 'IN_PROGRESS' } });
  sEv.from({ serverContent: { turnComplete: true } });
  assert.equal(reg.get('orb').dataset.state, 'thinking', 'the caller was invited to speak while the model was still reasoning');
  assert.match(reg.get('modePill').textContent, /still reasoning/i, 'pill said: ' + reg.get('modePill').textContent);
  sEv.from({ serverContent: { interactionStatus: 'IDLE' } });
});
check('background reasoning is announced while the agent is not talking at all', () => {
  // The other half of interactionStatus: IN_PROGRESS arrives on its own too, mid-turn,
  // when nothing has been played. A caller looking at "listening" starts a sentence the
  // model is about to talk over, and then hears an answer to a question they did not ask.
  sEv.from({ serverContent: { turnComplete: true } });
  sEv.from({ serverContent: { interactionStatus: 'IN_PROGRESS' } });
  assert.match(reg.get('modePill').textContent, /still reasoning/i, 'pill said: ' + reg.get('modePill').textContent);
  assert.match(reg.get('say').textContent, /rukiye/, 'no cue telling the caller to hold on');
  sEv.from({ serverContent: { interactionStatus: 'IDLE' } });
});

check('IDLE hands the floor back over', () => {
  // Neither state is optional to show: 'thinking' forever is a dead line, and
  // 'listening' too early is the caller talking over an answer.
  assert.notEqual(reg.get('orb').dataset.state, 'thinking', 'IDLE did not release the orb');
  assert.ok(!/still reasoning/.test(reg.get('modePill').textContent), 'the pill kept a claim the server had retracted');
});

await settle(400); // with audio still queued the turn end is skipped for both, and the check proves nothing
check('a turn that ended without an answer says so, instead of looking slow', () => {
  sEv.from({ serverContent: { turnComplete: true, turnCompleteReason: 'RESPONSE_REJECTED' } });
  assert.match(reg.get('thread').children.at(-1).text(), /RESPONSE_REJECTED/, 'the refusal reason was swallowed');
  assert.equal(reg.get('orb').dataset.state, 'error', 'a refusal painted over as an ordinary turn end');
  assert.match(reg.get('say').textContent, /jawab nahi/, 'the caller was never told what to do next');
});

// Precondition matters more here than anywhere: the previous turn left the pill held, and
// a held pill hides the very difference this check is about. So give it a real turn to
// speak and a settle to go quiet, arriving at the refusal with nothing held.
sEv.from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(4800, 9).toString('base64') } }] } } });
await settle(400); // speak, then go quiet: arrive at the refusal with nothing held
check('a refusal is not folded back into an ordinary end of turn', () => {
  // The refusal and the turnComplete arrive in ONE message. If the generic turn-end path
  // runs afterwards it writes 'listening' over 'nothing to say', and the caller is invited
  // to speak to a model that has just declined the topic — the one outcome where asking
  // again makes it worse. Asserted on the pill after a drain, or the queue alone would
  // make both versions look identical.
  sEv.from({ serverContent: { turnComplete: true, turnCompleteReason: 'PROHIBITED_INPUT_CONTENT' } });
  assert.match(reg.get('modePill').textContent, /nothing to say/i, 'pill said: ' + reg.get('modePill').textContent);
});

sEv.from({ serverContent: { turnComplete: true, turnCompleteReason: 'NEED_MORE_INPUT' } });
await settle(320); // drain anything still queued — waiting is only truthful once silent
check('"needs more input" is shown as waiting, with no audio involved', () => {
  assert.match(reg.get('modePill').textContent, /waiting for you/i, 'pill said: ' + reg.get('modePill').textContent);
  assert.match(reg.get('say').textContent, /boliye/, 'the pill changed but the instruction did not');
});

check('the server saying "interrupted" cuts playback, whatever the local VAD thought', () => {
  const pcmB = Buffer.alloc(4800, 3);
  sEv.from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcmB.toString('base64') } }] } } });
  assert.equal(reg.get('orb').dataset.state, 'speaking', 'precondition: agent must be talking');
  sEv.from({ serverContent: { interrupted: true } });
  assert.notEqual(reg.get('orb').dataset.state, 'speaking', 'interrupted was ignored');
});
// Two phases, because the app has to tell them apart: a pause *while the caller is
// still hearing audio* is not "your turn" yet, and cutting the queue to say so is how a
// sentence loses its tail.
sEv.from({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(4800, 5).toString('base64') } }] } } });
sEv.from({ serverContent: { waitingForInput: true } });
check('a pause with audio still queued does not cut the sentence', () => {
  assert.equal(reg.get('orb').dataset.state, 'speaking', 'it flushed (or claimed) a state the caller had not heard yet');
});
await settle(300);
check('"waiting for input" is shown as waiting once the queue drains', () => {
  // Neither "agent talking" nor plain "listening": the model pausing to let you
  // continue is its own state, and guessing wrong is what makes people restart.
  assert.match(reg.get('modePill').textContent, /waiting for you/i, 'pill said: ' + reg.get('modePill').textContent);
  assert.match(reg.get('say').textContent, /boliye/i, 'no cue about what to do now');
});
check('tokens are counted where a free-tier user can see them', () => {
  sEv.from({ usageMetadata: { totalTokenCount: 12345 } });
  assert.equal(reg.get('sTokens').textContent, '12k');
  // A repeated or smaller total must not walk the number backwards, and a running total
  // must not be added to itself — `totalTokenCount` is the session total, not a delta.
  sEv.from({ usageMetadata: { totalTokenCount: 400 } });
  assert.equal(reg.get('sTokens').textContent, '12k', 'a stale total overwrote the newer one');
  sEv.from({ usageMetadata: { totalTokenCount: 12745 } });
  assert.equal(reg.get('sTokens').textContent, '13k', 'usage did not move with the real total');
});

// hybrid endpointing: our own end-of-turn against the server's silence timer
{
  let fake = Date.now() + 2000;
  sandbox.performance.now = () => fake;
  const loud = () => procs.at(-1).onaudioprocess({
    inputBuffer: { getChannelData: () => Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / 3) * 0.4) },
  });
  const quiet = () => procs.at(-1).onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(2048) },
  });
  const streamEnds = () => sEv.frames('realtimeInput').filter((f) => f.realtimeInput.audioStreamEnd).length;
  check('the end of my sentence is announced to the server, once', () => {
    fake += 60; loud();
    fake += 60; loud();
    fake += 400; quiet();                    // silence begins, turn clock starts
    assert.equal(streamEnds(), 0, 'it finalised before the 560 ms safety margin');
    fake += 300; quiet();
    assert.equal(streamEnds(), 0, 'finalised at 300 ms of silence — that is how mid-sentence cuts happen');
    fake += 320; quiet();
    assert.equal(streamEnds(), 1, 'no audioStreamEnd after a clear pause');
    fake += 600; quiet();
    fake += 600; quiet();
    assert.equal(streamEnds(), 1, 'one utterance must not send three finalisations');
  });
  check('the next utterance is allowed to announce itself too', () => {
    fake += 60; loud();
    fake += 400; quiet();
    fake += 700; quiet();
    assert.equal(streamEnds(), 2, 'the latch never reset — only the first turn of a call is fast');
  });
}
check('audioStreamEnd is only sent where the API allows it', () => {
  // The field is documented as valid only with automatic activity detection enabled; in
  // push-to-talk we disable it and send activityEnd instead. Sending both is a protocol
  // error the server may answer by closing the session.
  const senders = [...app.matchAll(/send\(\{ realtimeInput: \{ (audioStreamEnd|activityEnd)[^}]*\}/g)].map((m) => m[1]);
  assert.ok(senders.includes('audioStreamEnd') && senders.includes('activityEnd'), 'a signal went missing: ' + senders);
  const hybridGate = /if \(cfg\.hybrid && cfg\.vad !== 'ptt'/.test(app);
  assert.ok(hybridGate, 'the hybrid path is not gated on server VAD and the user setting');
});

// ── the line refreshes itself, and the caller does not have to notice ────────────
check('a mid-call refresh does not re-ask for the microphone', () => {
  // getUserMedia again would mean a second permission prompt in the middle of a call —
  // the one thing that makes people hang up. The static form: rotate() must not touch
  // the mic or the audio context at all.
  const r = /function rotate\(reason\) \{([\s\S]*?)\n\}/.exec(app);
  assert.ok(r, 'rotate() not found');
  assert.doesNotMatch(r[1], /openMic|getUserMedia|ensureAudio|closeMic/, 'the refresh re-opens the mic');
  assert.match(r[1], /settled = false;/, 'a failed refresh would be diagnosed as a clean hangup');
  assert.match(r[1], /detachSocket\(sock\)/, 'the old socket is closed without detaching its handlers');
});

check('the resume handle is remembered across the refresh', () => {
  // The frame the ladder retries onto must carry the handle, or "resume" is a promise
  // with nothing behind it.
  const r = /function fullSetup\(\) \{([\s\S]*?)\n\}/.exec(app);
  assert.match(r[1], /sessionResumption = sessionHandle \? \{ handle: sessionHandle \} : \{\}/);
  assert.match(app, /if \(rotating\) return;/, 'a deliberate rotation close runs the failure ladder');
});

check('a 15-minute cap is not allowed to end a call', () => {
  const soft = /const SESSION_SOFT_MS = ([\d*\s()]+);/.exec(app);
  assert.ok(soft, 'no session-cap countdown');
  const ms = Number(soft[1].replace(/[^\d*]/g, '').includes('*') ? eval(soft[1]) : Number(soft[1]));
  assert.ok(ms > 5 * 60 * 1000 && ms < 15 * 60 * 1000, `refresh at ${ms}ms is either pointless or too late`);
  assert.match(app, /armSessionCap\(\);/, 'the countdown is never armed');
  const t = /function teardown\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(t, /clearTimeout\(sessionTimer\)/, 'a refresh scheduled after a hangup reopens a dead call');
  assert.match(t, /sessionHandle = ''/, 'the next call would resume the conversation I just ended');
});
const gmu0 = sandbox.navigator.mediaDevices.getUserMedia;
let gmuCalls = 0;
sandbox.navigator.mediaDevices.getUserMedia = async (...a) => { gmuCalls++; return gmu0(...a); };
const beforeGoAway = sockets.length;
sEv.from({ sessionResumptionUpdate: { newHandle: 'H-42', resumable: true } });
sEv.from({ goAway: { timeLeft: '3s' } });
await settle(900);
check('goAway is answered with a new socket that carries the handle', () => {
  assert.ok(sockets.length > beforeGoAway, 'no fresh socket after goAway — the caller is watching a dead transcript');
  const setup = sockets.at(-1).frames('setup')[0].setup;
  assert.equal(setup.sessionResumption.handle, 'H-42', 'the new socket started a new conversation instead of resuming');
  assert.equal(gmuCalls, 0, 'the refresh asked for the microphone again — a second permission prompt mid-call');
});
sandbox.navigator.mediaDevices.getUserMedia = gmu0;
// The other half of the refresh: the user hangs up while a goAway is still pending. Two
// guards cover this (teardown clears the timer, rotate refuses without a live socket),
// and they are redundant on purpose — so the pair is asserted behaviourally, not by
// grepping one of them.
const socketsBeforeLateGoAway = sockets.length;
sockets.at(-1).from({ goAway: { timeLeft: '3s' } });
reg.get('hangup').fire('click');
await settle(900);
check('hanging up during a pending refresh does not reopen the call', () => {
  assert.equal(sockets.length, socketsBeforeLateGoAway,
    'a scheduled line refresh reopened a call the user had already ended');
  assert.match(reg.get('modePill').textContent, /idle/i, 'the chip moved off idle by itself');
});

check('the old socket of a refresh is not diagnosed as a failure', () => {
  // teardown()'s recursion was a real bug; a rotation closes a socket on purpose, and
  // the same trap is one edit away if the guard is dropped.
  assert.match(app, /if \(rotating\) return;/, 'a deliberate rotation close reaches failHandshake');
});
await endEverything();
const beforeNewCall = sockets.length;
reg.get('pttBtn').fire('click');
await settle(140);
const sNew = sockets.at(-1);
sNew.from({ setupComplete: {} });
check('a hangup does not resume a finished conversation', () => {
  assert.ok(sockets.length > beforeNewCall, 'no socket for the new call');
  const setup = sNew.frames('setup')[0].setup;
  assert.deepEqual(setup.sessionResumption, {},
    'a stale handle was reused: this "new" call would remember the last one');
  sNew.from({ serverContent: { turnComplete: true } });
});

// ── one provider, one path: no REST audio anywhere ──────────────────────────────
check('there is exactly one Google surface in this app', () => {
  assert.doesNotMatch(app, /preview-tts|:generateContent/, 'a REST audio call is back in the client');
  assert.doesNotMatch(app, /TTS_MODEL|TTS_URL|TTS_PATH/, 'the old TTS constants are back');
  assert.doesNotMatch(srv, /url\.pathname === '\/tts'/, 'the server kept a second audio route nobody uses');
  assert.doesNotMatch(srv, /const TTS_UPSTREAM/, 'a second Google endpoint is back in the server');
  assert.doesNotMatch(html, /preview-tts/, 'the picker offers a TTS row');
  // Direct and relay are the only two ways to reach the API, and both are the same
  // WebSocket service — that is the whole keysafe story in one assertion. Hosts are read
  // out of the two constants the code actually sends to, not out of prose.
  const root = /const API_ROOT = 'https:\/\/([^/]+)/.exec(app)[1];
  const direct = /const DIRECT =\s*\n?\s*'wss:\/\/([^/]+)/.exec(app)[1];
  assert.deepEqual([...new Set([root, direct])], ['generativelanguage.googleapis.com'],
    `the page talks to more than Google AI Studio: ${root}, ${direct}`);
  assert.match(app, /const MODELS_PATH = 'models'/, 'the REST surface grew beyond model discovery');
  assert.doesNotMatch(app, /fetch\([^)]*generateContent/, 'a REST generation call is back');
  assert.match(app, /const RELAY = location\.origin[\s\S]*\+ '\/relay'/, 'the relay URL drifted');
  assert.match(app, /sock = cfg\.keysafe \? new WebSocket\(RELAY\)/,
    'the audition bypasses the relay, so keysafe mode cannot preview a voice');
});
check('the provisional caption and the preview button are styled, not just present', () => {
  assert.match(css, /\.turn\.live/, 'a live caption with no visual difference is a caption that lies');
  for (const st of [':hover', ':active', ':disabled', ':focus-visible']) {
    assert.match(css, new RegExp('\\.secondary' + st.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')),
      'no button style for .secondary' + st);
  }
});

// Leave nothing running: a live call means a pending 13-minute timer, and node would
// sit on it and look like a hung suite from the outside.
await endEverything();
check('no session survives the end of the suite', () => {
  assert.match(reg.get('modePill').textContent, /idle/, 'a live call was left open');
  assert.equal(reg.get('hangup').hidden, true);
});

check('the app\u2019s own setup frames pass the app\u2019s own field audit', () => {
  // The audit is the thing that makes a hand-added field visible instead of fatal, so it has
  // to be silent for the frames this app actually builds. Every frame the whole suite sent is
  // walked here, in both directions: a legal list that is too *small* would shout at correct
  // frames, and one that is too *big* would let the shipped bug through unnoticed.
  const log = String(reg.get('sheetLog').textContent || '');
  assert.doesNotMatch(log, /not in the field list this build knows about/,
    'a frame carried a field the audit does not recognise: ' + (/\[setup audit\][^\n]*/.exec(log) || [''])[0]);
  const lists = /const SETUP_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(app)[1];
  const legal = [...lists.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  for (const must of ['model', 'systemInstruction', 'tools', 'generationConfig', 'realtimeInputConfig']) {
    assert.ok(legal.includes(must), `the audit list lost ${must}, which every call here sends`);
  }
  assert.equal(legal.length, 15, `the audit list is ${legal.length} long, not the 15 the converter emits — re-check it against the SDK, do not extend it from feel`);
});

// The normaliser is a safety net, so it gets tested as a unit: a net that catches nothing is
// indistinguishable from no net at all, and every frame this app builds today happens to be
// already-nested. The bug this pins: with no `generationConfig` object to move the field into,
// the first version deleted the flat one — so the fallback frame lost `responseModalities`
// silently instead of being repaired.
check('the normaliser moves a flat field even when there is nothing to move it into', () => {
  // JSON round-trip on every one of these: a value that crosses out of the vm context carries
  // that realm's prototypes and strict deepEqual rejects it on an empty diff. Learned twice in
  // one sitting, so it is written down at the second place it bit rather than the first.
  const flat = (expr) => JSON.parse(JSON.stringify(vm.runInContext(expr, sandbox)));
  const frame = flat('liveSetup({ model: "models/x", responseModalities: ["AUDIO"] })');
  assert.deepEqual(frame, {
    setup: { model: 'models/x', generationConfig: { responseModalities: ['AUDIO'] } },
  }, 'the flat field was dropped on the floor instead of nested');
  const both = flat('liveSetup({ model: "models/x", responseModalities: ["TEXT"], generationConfig: { responseModalities: ["AUDIO"] } })');
  assert.deepEqual(both.setup.generationConfig.responseModalities, ['AUDIO'],
    'a nested value was overwritten by the flat one — the nested shape is the one that reaches the API');
  assert.equal(both.setup.responseModalities, undefined, 'the flat copy survived alongside the nested one');
  // `{}` is what the app writes for a config with nothing in it (an empty generationConfig, an
  // empty transcription config), so this is the path the cleanup exists for. Asserting against
  // a frame where the object was never created would pass with the cleanup deleted — which is
  // exactly how the first draft of this check read.
  const none = flat('liveSetup({ model: "models/x", generationConfig: {}, systemInstruction: { parts: [{ text: "hi" }] } })');
  assert.equal(none.setup.generationConfig, undefined,
    'an empty generationConfig is sent as an empty object; the rest of the file assumes absent means default');
  const emptied = flat('liveSetup({ model: "models/x", responseModalities: ["AUDIO"], generationConfig: {} })');
  assert.ok(emptied.setup.generationConfig.responseModalities, 'the move did not land in the pre-made empty object');
});

// The audit only writes a log line, so nothing about a *frame* can prove it fired — which is
// exactly how a warning gets quietly deleted. Call it directly and demand the effect.
check('the audit fires on a field it does not know, and says what it will do about it', () => {
  const before = String(reg.get('sheetLog').textContent || '');
  const odd = vm.runInContext(
    'auditSetup({ model: "models/x", bogusField: 1, generationConfig: { responseModalities: ["AUDIO"], nope: 2 } })',
    sandbox,
  );
  // Compared as a string, not with deepEqual: a value that crosses out of the vm context
  // carries that realm's prototypes, and a strict deepEqual against a host array fails on an
  // audit that named every offender correctly. Seen once, paid for in a wasted half hour.
  assert.equal(Array.from(odd).join(','), 'bogusField,generationConfig.nope',
    'the audit named the wrong offenders: ' + JSON.stringify(Array.from(odd)));
  const after = String(reg.get('sheetLog').textContent || '');
  assert.notEqual(after, before, 'it computed a warning and dropped it on the floor');
  assert.match(after, /sent anyway/, 'the line has to say the field is still being sent, or it reads as a hard failure');
});

/* ══ the setup frame, graded against the proto ═══════════════════════════════
 * Everything in this block exists because of one screenshot: a phone showing
 * `Unknown name "responseModalities" at 'setup': Cannot find field.` twice, then
 * "socket closed with code 1007", then "Stopping here rather than retrying forever".
 * The generation knobs are not fields of `setup` — they are fields of
 * `setup.generationConfig` — and the app's own fallback frame, the one that has to
 * survive every rejection, was the one still sending it flat. A guard that only checks
 * the happy path guards the path that was never broken.
 */
check('every frame builder routes through the nesting normaliser', () => {
  // Match the wiring, not the formatting: every frame leaves through one function, and that
  // function calls the normaliser, the stripper and the audit. A literal one-liner here would
  // only prove the file is still formatted the way it was when the check was written.
  const fn = /const liveSetup = \(([\s\S]*?)\n\};/.exec(app);
  assert.ok(fn, 'liveSetup is not the single choke point any more');
  for (const call of ['nestGenerationFields', 'stripRefused', 'auditSetup']) {
    assert.ok(fn[1].includes(call), `liveSetup no longer routes through ${call} — a builder can bypass it, which is how the flat field got shipped`);
  }
  for (const f of ['responseModalities', 'speechConfig', 'temperature', 'maxOutputTokens']) {
    assert.ok(new RegExp(`'${f}'`).test(/const GENERATION_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(app)[1]),
      `GENERATION_FIELDS no longer lists ${f}, so it can go flat on setup unnoticed`);
  }
});

check('no setup frame in the whole suite ever puts a generation field flat', () => {
  // The real assertion: walk every frame the page actually sent, not the source text.
  // Regex over source is what failed here last time — it can only find what you think to
  // search for, and the bug was in a frame nobody was looking at.
  const gen = /const GENERATION_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(app)[1];
  const names = [...gen.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 6, 'GENERATION_FIELDS looks truncated: ' + names.join(','));
  const offenders = [];
  for (const [i, sock] of sockets.entries()) {
    for (const f of sock.frames('setup')) {
      const st = f.setup || {};
      for (const n of names) if (n in st) offenders.push(`socket #${i + 1}: setup.${n}`);
    }
  }
  assert.deepEqual(offenders, [], 'flat on setup (must be under setup.generationConfig): ' + offenders.join(', '));
});

// ── the production failure, reproduced from the screenshot ─────────────────
// Three repairs, then a call that works, then one more refusal: the last one is the test of
// whether the budget refilled, so the order is load-bearing and every step is asserted.
await endEverything();
reg.get('pttBtn').fire('click');
await settle();

/** Close the live socket the way Google answers a bad field name; return the retry's frame. */
const refuseAndRetry = async (field, path = 'setup') => {
  const sock = sockets.at(-1);
  sock.onclose({
    code: 1007,
    reason: `Invalid JSON payload received. Unknown name "${field}" at '${path}': Cannot find field.`,
  });
  await settle();
  const next = sockets.at(-1);
  return next === sock ? null : next.frames('setup').at(-1)?.setup;
};

const s1007 = sockets.at(-1);
s1007.onclose({
  code: 1007,
  reason: 'Invalid JSON payload received. Unknown name "responseModalities" at \'setup\': Cannot find field.',
});
await settle();

check('a named unknown field is repaired by moving it, and keeps the voice', () => {
  const next = sockets.at(-1);
  assert.notEqual(next, s1007, 'a 1007 must earn a retry socket');
  const setup = next.frames('setup')[0].setup;
  assert.deepEqual(setup.generationConfig?.responseModalities, ['AUDIO'],
    'the retry did not move the field where the endpoint asked for it');
  assert.equal(setup.responseModalities, undefined, 'it retried the same rejected frame');
  // The headline of the fix: this used to be "voice and VAD fall back to defaults". One
  // misplaced key should not cost the user the voice they picked.
  assert.ok(setup.generationConfig?.speechConfig, 'the repair threw away the chosen voice');
  assert.ok(setup.systemInstruction, 'the repair threw away the persona');
});

check('the repair says what it did, once, in a sentence a caller can read', () => {
  const t = threadText();
  assert.match(t, /belongs under generationConfig/, 'no human explanation of the fix: ' + JSON.stringify(t.slice(0, 200)));
  assert.equal((t.match(/Cannot find field/g) || []).length, 0,
    'the raw protobuf string is being dumped into the transcript again');
  assert.equal((t.match(/Setup frame refused by the endpoint/g) || []).length, 1,
    'the same diagnosis printed twice — the screenshot had it in two boxes');
  assert.ok(reg.get('say').textContent.length < 60,
    'the headline under the orb turned into a paragraph: ' + reg.get('say').textContent);
});

check('the raw response is kept, where it is useful and out of the way', () => {
  const log = reg.get('sheetLog');
  assert.ok(log.textContent.includes('Cannot find field'),
    'the field path is the thing a bug report needs — it belongs in the log, not the call screen');
  assert.match(log.textContent, /\[setup repair\] setup\.responseModalities/);
});

const fSys = await refuseAndRetry('systemInstruction');
const fSpeech = await refuseAndRetry('speechConfig', 'setup.generationConfig');

check('a refusal two levels deep removes that key and leaves its siblings alone', () => {
  assert.ok(fSpeech, 'no retry after a refusal at setup.generationConfig.speechConfig');
  assert.equal(fSpeech.generationConfig?.speechConfig, undefined, 'the refused key was re-sent');
  assert.deepEqual(fSpeech.generationConfig?.responseModalities, ['AUDIO'],
    'refusing one key cleared the whole generationConfig — the voice went with it');
});

check('the second repair drops the field it was named, not the config around it', () => {
  assert.ok(fSys, 'no retry after the second refusal');
  assert.equal(fSys.systemInstruction, undefined, 'systemInstruction was refused and is still being offered');
  assert.ok(fSys.tools, 'the repair kept deleting past the field it was told about');
});

// Now earn the budget back: connect this call, hang it up, and start a fresh one. `refused`
// deliberately survives a connect (that row was seen to reject those keys), so the fresh call
// must still be able to *repair* — which only happens if fieldRepairs went back to zero.
sockets.at(-1).from({ setupComplete: {} });
await settle(80);
await endEverything();
reg.get('pttBtn').fire('click');
await settle();
const afterConnect = await refuseAndRetry('outputAudioTranscription');

check('a refusal on a fresh call is repaired by name, not escalated', () => {
  // What this can honestly claim: the ladder is still alive on a call that starts after a
  // successful one. The budget refills on a connect *and* on a row change (repairField), and
  // this scenario sees both, so it cannot isolate the reset — the "moved twice" check below
  // is what catches a missing refill. Anything stronger would be a check that passes because
  // two different failures look the same.
  assert.ok(afterConnect, 'the ladder was spent even though the call had connected since');
  assert.equal(afterConnect.outputAudioTranscription, undefined,
    'the named field was not the thing that got dropped');
  assert.ok(afterConnect.inputAudioTranscription,
    'this is the minimal frame, not a repaired full frame — the ladder gave up instead of fixing one field');
  assert.deepEqual(afterConnect.generationConfig?.responseModalities, ['AUDIO']);
  assert.equal(afterConnect.systemInstruction, undefined,
    'a field this row refused came back on the next call');
  // The frame shape alone cannot prove the ladder ran — a minimal frame also lacks most of
  // these keys, and a check that passes because two different failures look the same is not a
  // check. The repair sentence names the field, which nothing else in the app can print.
  assert.match(threadText(), /does not accept "outputAudioTranscription"/,
    'no repair was attempted on this call: the budget was never refilled by the connect');
  assert.doesNotMatch(threadText(), /minimal setup frame/,
    'fell back to the minimal frame while there was still a specific field to fix');
});

/**
 * Phase C: the server contradicts a move. `responseModalities` is now only ever sent nested,
 * so a refusal of it *at setup* means the ladder's advice did not work, and repeating the
 * advice is not a second idea — it is a loop that re-sends an identical frame until the cap
 * runs out. A field that has been moved and refused again has to be retired in both places.
 */
const fContradiction = await refuseAndRetry('responseModalities');
check('a moved field that is refused again is retired, not moved a second time', () => {
  assert.ok(fContradiction, 'the contradiction got no retry at all');
  assert.equal(fContradiction.responseModalities, undefined, 'still flat on setup');
  assert.equal(fContradiction.generationConfig?.responseModalities, undefined,
    'the same move was tried twice — an identical frame, resent forever');
  assert.ok(fContradiction.inputAudioTranscription,
    'it stopped being a full frame; the ladder gave up instead of retiring one field');
  assert.equal((threadText().match(/Moved it there/g) || []).length, 1,
    'the app repeated its own advice instead of escalating past it');
});

/**
 * The presentation rule the screenshot broke: a failure gets one sentence in one box, and the
 * wire text goes under a disclosure. Driven by a 401, because that is the other error this app
 * can be handed that arrives as somebody else's prose.
 */
/**
 * The presentation rule the screenshot broke: one failure, one sentence, one box, and the wire
 * text under a disclosure. Driven by a 401 because that is the other error this app is handed as
 * somebody else's prose. Scoped to the nodes this scenario added — the transcript deliberately
 * survives a reconnect, so "the last error note" is not the same thing as "the only one".
 */
await endEverything();
const sockBefore = sockets.length;
reg.get('pttBtn').fire('click');
await settle(80);
const kidsBefore = (reg.get('thread').children || []).length;
assert.ok(sockets.length > sockBefore, 'the scenario could not open a call to break');
sockets.at(-1).from({ setupError: { message: 'API key not valid. Please pass a valid API key.' } });
await settle(120);

const allText = (n) => [String(n.textContent || ''), ...(n.children || []).flatMap(allText)].join('\n');
const since = (cls) => (reg.get('thread').children || []).slice(kidsBefore)
  .filter((c) => new RegExp(`(^|\\s)${cls}(\\s|$)`).test(String(c.className)));

check('the red box holds a sentence, never the API prose', () => {
  // No `sockets.length` guard needed: the top-level assert above already proved this scenario
  // opened a call, and `from()` delivers to that socket's onmessage or the app never saw it.
  const errs = since('err');
  assert.ok(errs.length >= 1, 'a 401 printed no error line at all');
  for (const n of errs) {
    assert.doesNotMatch(String(n.textContent), /API key not valid|Unknown name|Cannot find field|1007/,
      'the visible error is the wire string: ' + JSON.stringify(String(n.textContent).slice(0, 90)));
  }
  assert.match(String(errs.at(-1).textContent), /does not accept that key/i,
    'the sentence lost the one thing worth saying: ' + errs.at(-1).textContent);
  assert.ok(String(errs.at(-1).textContent).length < 150, 'the sentence is a paragraph again');
});

check('the raw response survives, folded, and printed once', () => {
  const raws = since('raw');
  assert.equal(raws.length, 1, 'expected one disclosure from this failure, got ' + raws.length);
  const det = (raws[0].children || [])[0];
  assert.equal(det?.tag, 'details', 'the raw text is not behind a disclosure');
  const [sum, pre] = det.children || [];
  assert.match(String(sum.textContent), /technical detail/);
  assert.match(String(pre.textContent), /API key not valid/, 'the payload was thrown away, not folded');
  const inThisFailure = (reg.get('thread').children || []).slice(kidsBefore).map(allText).join('\n');
  const once = (inThisFailure.match(/API key not valid/g) || []).length;
  assert.equal(once, 1, `the same string on screen ${once} times — it was in two boxes before`);
  assert.match(reg.get('sheetLog').textContent, /API key not valid/, 'the copyable log lost it');
});

/* ══ the fallback branch, where un-named wire prose actually arrives ═════════
 * Every specific error has a sentence of its own. The risk lives in the `else`, which is
 * where a message this file has never seen lands — and where an earlier version printed the
 * whole payload as the user-facing text.
 */
await endEverything();
reg.get('pttBtn').fire('click');
await settle(80);
const kidsUnk = (reg.get('thread').children || []).length;
sockets.at(-1).from({
  setupError: { message: 'Internal error encountered while preparing the model: upstream_deadline_exceeded (req 0x1f) trace 8a:2144' },
});
await settle(120);

check('an error with no branch of its own still keeps the wire prose out of the red box', () => {
  const errs = (reg.get('thread').children || []).slice(kidsUnk)
    .filter((c) => /(^|\s)err(\s|$)/.test(String(c.className)));
  assert.ok(errs.length >= 1, 'the unknown error printed no line at all');
  for (const n of errs) {
    assert.doesNotMatch(String(n.textContent), /upstream_deadline_exceeded|0x1f|trace 8a|Internal error encountered/,
      'the app echoed the API prose at the caller: ' + JSON.stringify(String(n.textContent).slice(0, 100)));
    assert.ok(String(n.textContent).length < 170, 'an unrecognised failure must not become a paragraph');
  }
  assert.match(String(errs.at(-1).textContent), /does not know how to read/,
    'the sentence does not admit what it does not know: ' + errs.at(-1).textContent);
  const raw = (reg.get('thread').children || []).slice(kidsUnk)
    .filter((c) => /(^|\s)raw(\s|$)/.test(String(c.className)));
  assert.equal(raw.length, 1, 'the payload should be folded under exactly one disclosure');
  assert.match((raw[0].children || []).flatMap((d) => (d.children || []).map((x) => String(x.textContent))).join(' '),
    /upstream_deadline_exceeded/, 'the folded copy lost the string a bug report needs');
  assert.match(reg.get('sheetLog').textContent, /upstream_deadline_exceeded/);
});

check('the failure that needs a new key opens the panel that has it', () => {
  assert.equal(reg.get('p-key').hidden, false, '401 says "check the key" without showing the key box');
  assert.ok(reg.get('say').textContent.length < 60, 'the orb headline grew into a paragraph');
});

/* ══ the technical log: folded, cumulative, copyable ══════════════════════════
 * The log is the one place raw text is allowed to be raw. Three things go wrong without
 * looking: a writer forgets to reveal it, "Test connection" replaces it, and a copy button
 * built on navigator.clipboard does nothing on the WebView (plain http = insecure context,
 * no clipboard API at all).
 */
check('one function owns the log, so revealing it cannot be forgotten', () => {
  const hiddenWrites = [...app.matchAll(/el\.sheetLog\.hidden\s*=/g)].length;
  assert.equal(hiddenWrites, 0, 'a call site still toggles the log panel by hand');
  const reveal = [...app.matchAll(/el\.logBox\.hidden\s*=/g)];
  assert.equal(reveal.length, 1, 'the reveal must live in exactly one place, saw ' + reveal.length);
  const writers = [...app.matchAll(/el\.sheetLog\.textContent\s*\+=/g)].length;
  assert.equal(writers, 1, 'log text is being appended outside logLine, which is where the count lives');
  assert.match(app, /logLine\(/, 'logLine is never called');
});

check('the box counts its lines, so it says whether it is worth opening', () => {
  const lines = Number(reg.get('sheetLog').getAttribute('data-lines'));
  assert.ok(lines >= 1, 'log lines were written but nothing counted them');
  // Written out, not computed with a ternary whose branches were identical — a check that
  // happens to agree with the code is not a check that reads the code.
  const want = lines === 1 ? '1 line' : lines + ' lines';
  assert.equal(reg.get('logCount').textContent.trim(), want,
    `the summary says "${reg.get('logCount').textContent.trim()}", the log holds ${lines} (${want})`);
  assert.equal(reg.get('logBox').hidden, false, 'lines exist but the box is still hidden');
});

check('“Test connection” adds to the log instead of replacing the evidence', () => {
  const before = String(reg.get('sheetLog').textContent);
  assert.match(before, /API key not valid|upstream_deadline_exceeded/,
    'the scenario needs a failure in the log first to mean anything');
  reg.get('sheetTest').fire('click');
  assert.notEqual(String(reg.get('sheetLog').textContent), before, 'the probe did not write at all');
  assert.ok(String(reg.get('sheetLog').textContent).startsWith(before.trim().slice(0, 40)),
    'the probe wiped the trail — the line a bug report needs is gone');
  assert.ok(String(reg.get('probeOut').textContent).length > 0, 'no answer shown next to the button');
  assert.ok(String(reg.get('probeOut').textContent).length < 130,
    'the answer under the buttons grew into the report again: ' + reg.get('probeOut').textContent.length + ' chars');
});

check('the probe is coloured by its verdict, not by its wording', () => {
  // Two states that must not look the same: "here is what your key can see, and your row is
  // among them" and "your row is missing". The first version of this read the sentence and
  // called everything red, which is the mistake of styling a status line by string-matching
  // the status line.
  const kind = String(reg.get('probeOut').dataset.kind || '');
  assert.ok(['ok', 'bad', 'wait'].includes(kind), 'probe state is not one of the three: ' + kind);
  for (const k of ['ok', 'bad', 'wait']) {
    assert.ok(new RegExp(`\\[data-kind="${k}"\\]`).test(css), `.probe[data-kind="${k}"] has no rule — that state renders unstyled`);
  }
  assert.match(css, /\.probe\[data-kind="bad"\][^{]*\{[^}]*--danger/, 'the bad verdict is not the danger colour');
  assert.match(css, /\.probe\[data-kind="ok"\][^{]*\{[^}]*--you/, 'the good verdict hard-codes a green that light mode will not forgive');
  // `var(--ok` is the failure mode: a token that does not exist resolves to nothing and the
  // rule silently stops applying. Named in a comment does not count, however tempting the
  // prose — this check flagged my own sentence explaining it, which is the right behaviour
  // for a scanner and the wrong thing to assert about.
  assert.doesNotMatch(css, /var\(--ok[,)]/, 'the palette has no --ok token; use --you');
});

check('copy works where there is no clipboard API, and says so either way', () => {
  // This sandbox has neither navigator.clipboard nor document.execCommand — which is exactly
  // the WebView over http, the primary place this app runs. A button that only handles the
  // API path would pass a laptop test and be a no-op on the phone.
  assert.doesNotMatch(String(sandbox.navigator.clipboard || ''), /writeText/, 'the harness grew a clipboard; this check no longer covers the degraded path');
  reg.get('logCopy').fire('click');
  const label = String(reg.get('logCopy').textContent);
  assert.match(label, /copied|hold/, 'the copy button went quiet: ' + JSON.stringify(label));
  assert.ok(!/\[object Object\]|undefined|null/.test(label), 'the label printed an object: ' + label);
  if (/hold/.test(label)) {
    assert.equal(reg.get('sheetLog').getAttribute('tabindex'), '0',
      'telling someone to hold the text only works if the text can be selected');
  }
});

check('one field gets one repair, and the ladder is capped', () => {
  const cap = Number(/const MAX_FIELD_REPAIRS = (\d+);/.exec(app)[1]);
  assert.ok(cap >= 2 && cap <= 6, `a repair cap of ${cap} is either a loop or a dead end`);
  const strip = /function stripRefused\([\s\S]*?\n\}/.exec(app)[0];
  assert.match(strip, /refusedFor !== cfg\.model/,
    'a field refused by one row must not be muted for every row forever');
  assert.match(strip, /for \(const seg of segs\)/,
    'stripRefused only knows two depths again, so a nested refusal is remembered but re-sent');
  const repair = /function repairField\([\s\S]*?\n\}/.exec(app)[0];
  assert.match(repair, /movedAway/, 'the move is unbounded: move, refuse, move again, forever');
});

// A suite that cannot finish must not look like a suite that passed. An early exit —
// a frozen event loop, a top-level throw — used to print nothing at all and leave the
// shell with a nonzero code but no reason, which is how a real recursion bug in
// teardown() went nearly unnoticed. Count the checks the file declares and insist every
// one reported a verdict.
const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
const declared = (src.match(/^\s*check\(['"]/gm) || []).length;
results.push([results.length === declared ? '  ok  ' : ' FAIL ', `every declared check reported a verdict (${results.length}/${declared})`]);

for (const [s, n] of results) console.log(s, n);
const failed = results.filter(([s]) => s.includes('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} boot checks passed`);
if (failed) process.exitCode = 1;
suiteFinished = true;
