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
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
  remove() {}
  focus() { this._focused = true; }
  blur() { this._focused = false; }
  querySelector(sel) {
    if (!this._q.has(sel)) this._q.set(sel, new El('span'));
    return this._q.get(sel);
  }
  addEventListener(ev, fn) { (this._h[ev] ??= []).push(fn); }
  classList = { toggle() {}, add() {}, remove() {} };
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
// Untick the half-duplex guard the way a headphones user would. With the guard
// on there is deliberately NO barge-in — the mic is muted while the agent talks
// so laptop speakers cannot make it interrupt itself. The barge-in policy tests
// below only mean anything with the guard off.
reg.get('fGuard').checked = false;
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
check('touch targets are at least 44px', () => {
  for (const cls of ['push', 'icon-btn', 'send', 'primary', 'ghost']) {
    // Base selector only: `.icon-btn svg` and `.push .glyph` legitimately have
    // no min-height of their own, and matching them would make this check fail
    // for reasons that have nothing to do with tap targets.
    const blocks = [...css.matchAll(new RegExp('\\.' + cls + '\\s*(?:,\\s*\.' + cls + ')*\\s*\{([^}]*)\}', 'g'))];
    const ok = blocks.some(([, body]) => {
      const m = /min-height:\s*(\d+)px/.exec(body);
      return m && Number(m[1]) >= 44;
    });
    assert.ok(ok, '.' + cls + ' has no min-height >= 44px on its base rule');
  }
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

for (const [s, n] of results) console.log(s, n);
const failed = results.filter(([s]) => s.includes('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} boot checks passed`);
if (failed) process.exitCode = 1;
