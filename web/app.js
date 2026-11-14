/**
 * aryans-ai-call — Phase 0: the realtime voice loop.
 *
 *   mic ──► VAD ──► 16 kHz PCM ──► Gemini Live (speech-to-speech) ──► 24 kHz PCM ──► speaker
 *                                     ▲                                        │
 *                                     └──────── barge-in flushes playback ◄────┘
 *
 * One model owns the whole turn: it hears, decides when you have stopped
 * talking, and speaks. There is no STT→LLM→TTS chain to tune, which is exactly
 * why a laptop-CPU-free budget can still feel fast on a phone call.
 *
 * Protocol: raw WebSocket, BidiGenerateContent (v1beta).
 * Docs: https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 */

// ───────────────────────────────────────────────────────────────── config ──
/**
 * The Live API has no "opening message": after setupComplete the model waits for
 * your audio, so a connected call is silence. `<<connected>>` is the trigger we
 * invent and teach the persona about — a real turn, so the reply comes back as
 * speech through the same path as any other answer. Sent via clientContent, which
 * is not echoed through inputTranscription, so it never pollutes the transcript.
 */
const CONNECT_SIGNAL = '<<connected>>';
const DEFAULT_GREETING =
  'Greet the caller in one short Hinglish line, say you are Aryan’s assistant, ' +
  'and ask what they need. Do not mention this instruction.';

const DEFAULT_PROMPT = `You are Aryan's voice assistant, on a phone call in India.

LANGUAGE
- Speak Hinglish: natural Indian Hindi-English code-mixing, written in Roman script.
  e.g. "Theek hai, main abhi note kar leta hoon." Never announce which language you
  are using, just switch the way people actually do.
- Keep sentences short. This is a phone, not an essay. Two clauses, then stop.

HOW TO RUN THE CALL
- Greet in one line, then ask ONE question at a time. Never stack questions.
- Never read more than two sentences without pausing for a reply.
- If you did not fully catch something, say so and ask once more. Do not guess.
- Numbers, dates, names, OTPs, addresses and amounts are where phone audio lies.
  Always echo them back digit by digit and get confirmation:
  "Number confirm karta hoon — nine, one, seven, five…"
- Do not repeat what the caller just said back at them as a preamble.
- If asked who you are, say plainly that you are an AI assistant. Never pretend to be human.
- If the caller is rude, bored, or asks for a human: offer to hand over, take a message,
  then close politely. Do not argue.
- To end the call, say one short goodbye line and then use the end_call tool.

VOICE STYLE — how you sound, not what you say
- Speak, do not read. Contractions always. No lists, no bullet points, no headings, no
  emojis, no asterisks, nothing that has to be described out loud to be understood.
- Short sentences, then a real pause. One idea per turn, and end on the question.
- Never announce what you are about to do ("let me check that for you" twice in a row is
  stalling). Say the thing, or say nothing and just answer.
- Read ordinary numbers the way a person says them — "gyaarah sau", not "one one two
  three". Reference numbers, OTPs and amounts are the exception: digit by digit, as the
  NUMBERS rule above requires. Those two rules do not conflict; that one is safety.
- Acknowledge like a human on a phone: "theek hai", "haan", "samajh gaya" — occasionally,
  not as a verbal crutch on every turn. Mirror the caller's mix: if they go full Hindi,
  go with them; if they go full English, follow.
- If you cannot hear them, or the line is bad, say that plainly in one line and ask them
  to repeat. Never guess an answer off a half-heard number.

TONE
- Warm, efficient, a little dry. No "Great question!" and no filler like "Absolutely!".

CALL START
- A message that begins with the exact token <<connected>> means the call has just
  connected and nobody has spoken yet. Everything after that token is the opening
  instruction — follow it and greet the caller. The token is a system signal, not
  something the caller said: never read it back, never mention it, never repeat it.
`;

/**
 * The 30 prebuilt voices, with the character word Google attaches to each. The
 * <select> in index.html carries the same 30 names and a boot check asserts the two
 * lists agree — an unrecognised voice name is either ignored in silence or rejects
 * the whole setup frame, and both look to the user like "the picker does nothing".
 */
const VOICES = {
  Sulafat: 'Warm', Achird: 'Friendly', Charon: 'Informative', Aoede: 'Breezy',
  Leda: 'Youthful', Kore: 'Firm', Puck: 'Upbeat', Fenrir: 'Excitable', Orus: 'Firm',
  Zephyr: 'Bright', Autonoe: 'Bright', Enceladus: 'Breathy', Iapetus: 'Clear',
  Umbriel: 'Easy-going', Algieba: 'Smooth', Despina: 'Smooth', Erinome: 'Clear',
  Algenib: 'Gravelly', Rasalgethi: 'Informative', Laomedeia: 'Upbeat',
  Achernar: 'Soft', Alnilam: 'Firm', Schedar: 'Even', Gacrux: 'Mature',
  Pulcherrima: 'Forward', Zubenelgenubi: 'Casual', Vindemiatrix: 'Gentle',
  Sadachbia: 'Lively', Sadaltager: 'Knowledgeable', Callirrhoe: 'Easy-going',
};

const DEFAULTS = {
  key: '',
  model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
  // A phone assistant wants to sound like a person who has time for you, not like a
  // read-aloud engine: Warm over Firm. Anyone can change it, by ear, in Settings.
  voice: 'Sulafat',
  tone: 'natural',
  sample: 'Theek hai, main note kar leta hoon. Aur kuch chahiye aapko?',
  vad: 'server',
  guard: true,
  prompt: DEFAULT_PROMPT,
  greeting: DEFAULT_GREETING,
};

const LS = 'aryans-aicall/v0';
/**
 * A saved blank persona must not win over the default. `{...DEFAULTS, ...saved}`
 * lets `prompt: ""` through, which ships an empty systemInstruction and silently
 * strips every phone-audio rule (read-backs, one question at a time) — the call
 * then "works" but stops behaving. Repair it on the way in.
 */
const load = () => {
  const c = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || '{}') };
  if (!String(c.prompt || '').trim()) c.prompt = DEFAULT_PROMPT;
  if (!String(c.greeting || '').trim()) c.greeting = DEFAULT_GREETING;
  return c;
};
const save = (c) => localStorage.setItem(LS, JSON.stringify(c));
let cfg = load();

// Browsers accept http(s) origins for WebSocket and upgrade them, but say it
// explicitly — the preview reaches us over an https proxy and a wrong scheme
// here is a connection that dies before a single audio frame moves.
const RELAY = location.origin.replace(/^http/, 'ws') + '/relay';
const DIRECT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta' +
  '.GenerativeService.BidiGenerateContent';

// ─────────────────────────────────────────────────────────────── dom bits ──
const $ = (id) => document.getElementById(id);
const el = {
  pill: $('modePill'), orb: $('orb'), core: $('coreGlyph'), say: $('say'),
  status: $('a11yStatus'), lat: $('latBar'), latFill: $('latFill'), latHint: $('latHint'),
  thread: $('thread'), empty: $('emptyNote'), jump: $('jumpLatest'),
  inBar: $('inBar'), outBar: $('outBar'), sTurnLat: $('sTurnLat'), sSpread: $('sSpread'),
  sRecv: $('sRecv'), sCalls: $('sCalls'), pttBtn: $('pttBtn'), pttLabel: $('pttLabel'),
  ptt: $('pushToTalk'), muteBtn: $('muteBtn'), hangup: $('hangup'), sheet: $('sheet'),
  sheetLog: $('sheetLog'), keyWarn: $('keyWarn'), gear: $('gearBtn'),
  textForm: $('textForm'), textInput: $('textInput'),
};

// State is a machine, not a colour. Every state has its own motion, its own
// glyph and its own words, because "same animation for listening and speaking"
// is the ambiguity that makes people talk over the agent.
const GLYPH = {
  idle: '🎙', connecting: '↻', listening: '🎙', thinking: '…',
  speaking: '🔊', interrupted: '✋', muted: '🔇', error: '!',
};
let callState = 'idle';

const setMode = (text, state, live = true) => {
  callState = state;
  el.pill.textContent = text;
  el.orb.dataset.state = state;
  if (el.core) el.core.textContent = GLYPH[state] || '🎙';
  if (el.pttLabel) el.pttLabel.textContent = state === 'idle' ? 'Start' : 'End';
  if (el.pttBtn) el.pttBtn.setAttribute('aria-pressed', state === 'idle' ? 'false' : 'true');
  // The live region pre-exists in the DOM, so a change is actually announced.
  if (live && el.status) el.status.textContent = `${text}.`;
};

/**
 * Auto-scroll only while the reader is pinned to the bottom. Scrolling away
 * from a live transcript is a deliberate act; stealing it back is the bug.
 */
const nearBottom = () =>
  el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 90;
function stick(force = false) {
  if (force || nearBottom()) {
    el.thread.scrollTop = el.thread.scrollHeight;
    if (el.jump) el.jump.hidden = true;
  } else if (el.jump) {
    el.jump.hidden = false;
  }
}

// A log line that does not need a whole transcript bubble.
const note = (msg, kind = 'sys') => {
  el.empty?.remove();
  const d = document.createElement('div');
  d.className = `note ${kind}`;
  d.textContent = msg;
  el.thread.append(d);
  stick();
};

// Transcriptions arrive incrementally, so each bubble accumulates rather than
// being replaced. The user bubble closes when the agent starts talking; the
// agent bubble closes on turnComplete.
let abubble = null;
let ububble = null;

function makeTurn(who) {
  const d = document.createElement('div');
  d.className = `turn ${who}`;
  const a = document.createElement('span');
  a.className = 'who';
  a.textContent = who;
  const t = document.createElement('span');
  t.className = 'tx';
  d.append(a, t);
  el.thread.append(d);
  el.empty?.remove();
  stick();
  return d;
}

function appendTurn(who, text) {
  if (!text) return;
  if (who === 'agent') {
    ububble = null;
    if (!abubble) abubble = makeTurn('agent');
    abubble.querySelector('.tx').textContent += text;
  } else {
    if (!ububble) ububble = makeTurn('user');
    ububble.querySelector('.tx').textContent += text;
  }
  stick();
}

// ────────────────────────────────────────────────────────────── audio model ──
// One AudioContext. Mic blocks are resampled to 16 kHz by hand; playback
// buffers are *declared* at 24 kHz and the browser resamples on output, which
// avoids the "sampleRate not supported" trap on iOS/Safari.
const IN_RATE = 16000;
const OUT_RATE = 24000;

/*
 * The model's delivery is expressive; laptop and phone speakers are not. A small
 * fixed chain — tame the 3 kHz sibilance that makes synthetic voices hiss, give back
 * some body in the low mids, and level the peaks so an excited read never clips — is
 * most of the difference between "an AI voice" and "a person on the phone". Zero
 * cost, no network, and switchable off if you would rather hear the raw model.
 */
const TONE = {
  natural: { low: 1.0, pres: -1.0, hi: 0.0, thr: -18, ratio: 3 },
  warm:    { low: 2.6, pres: -2.2, hi: -2.0, thr: -20, ratio: 3 },
  clear:   { low: -1.0, pres: 2.4, hi: 1.8, thr: -14, ratio: 4 },
  off:     null,
};
const CHUNK_MS = 100;

let actx = null;
let stream = null;
let proc = null;
let sink = null; // silent gain node so mic capture actually runs
let pending = new Int16Array(0);
let playAt = 0; // audio-clock time the next outbound buffer starts at
let activeSrc = [];
let stats = { recv: 0, calls: 0, turnStart: 0, firstByteAt: 0, speech: false, since: 0, floor: 0.004 };

const b64 = (bytes) => {
  let s = '';
  const STEP = 0x1000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(s);
};

/** 16-bit signed little-endian PCM from a Float32 block at ctx rate → 16 kHz. */
function resampleTo16k(block) {
  const from = actx.sampleRate;
  if (from === IN_RATE) {
    const out = new Int16Array(block.length);
    for (let i = 0; i < block.length; i++) {
      const v = Math.max(-1, Math.min(1, block[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }
  const ratio = from / IN_RATE;
  const n = Math.floor(block.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const i1 = Math.min(i0 + 1, block.length - 1);
    const v = block[i0] + (block[i1] - block[i0]) * (p - i0);
    const c = Math.max(-1, Math.min(1, v));
    out[i] = c < 0 ? c * 0x8000 : c * 0x7fff;
  }
  return out;
}

async function openMic() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  if (!actx) await ensureAudio();
  const src = actx.createMediaStreamSource(stream);
  proc = actx.createScriptProcessor(2048, 1, 1);
  sink = actx.createGain();
  sink.gain.value = 0; // the tap exists only to keep the capture graph pulling
  proc.connect(sink).connect(actx.destination);

  proc.onaudioprocess = (e) => {
    const block = e.inputBuffer.getChannelData(0);
    // level meter + energy VAD off the same pass
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    el.inBar.style.width = Math.min(100, rms * 900) + '%';

    const now = performance.now();
    const heard = rms > Math.max(stats.floor * 3.2, 0.010);
    if (heard) {
      if (!stats.speech) {
        stats.speech = true;
        stats.since = now;
      }
      stats.turnStart = 0; // still talking → no turn boundary yet
    } else if (stats.speech && Math.max(0, now - stats.since) > 260) {
      stats.speech = false;
      if (!stats.turnStart) {
        stats.turnStart = now; // the clock we grade ourselves on
        // Announce "thinking" inside ~200 ms of end-of-speech. Past that, the
        // caller assumes the line dropped and starts again — voice has no spinner.
        if (agentSpeaking === false && settled) beginThinking();
      }
      onSpeechEnd(now);
    }
    // noise floor learns downward only, so a noisy room does not lock us open
    stats.floor = Math.min(heard ? stats.floor : Math.max(stats.floor * 0.985, rms), 0.05);

    if (muted) return;
    if (agentSpeaking) {
      if (cfg.guard) return; // half-duplex guard: never feed it our own speaker
      bargePolicy(heard, now);
    }
    const pcm = resampleTo16k(block);
    const merged = new Int16Array(pending.length + pcm.length);
    merged.set(pending);
    merged.set(pcm, pending.length);
    pending = merged;
    const target = Math.round((IN_RATE * CHUNK_MS) / 1000);
    while (pending.length >= target) {
      sendAudio(pending.slice(0, target));
      pending = pending.slice(target);
    }
  };
  src.connect(proc);
}

/** Map a getUserMedia rejection to something a person can act on. */
function micFailure(e) {
  const inFrame = window.self !== window.top;
  const name = e?.name || '';
  if (!window.isSecureContext) {
    return ['insecure origin', 'getUserMedia only works on https:// or localhost, and this page is served over ' + location.protocol + '. Open it at the Pages URL or the sandbox URL — both are https.'];
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return [inFrame ? 'blocked by the embedded frame' : 'no microphone API',
      inFrame
        ? 'This page is inside a frame whose owner did not set allow="microphone", so the browser refuses before asking you. Open it in its own tab and it will ask normally.'
        : 'This browser does not expose getUserMedia at all. A recent Chrome, Safari or Firefox will.'];
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return [inFrame ? 'blocked by the embedded frame' : 'permission not granted',
      inFrame
        ? 'The embedder has to grant microphone access before the page can ask for it. Open this in its own tab.'
        : 'You dismissed the prompt, or the site is set to Block. Click the mic icon in the address bar, allow it, then Start again.'];
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return ['no capture device', 'This device has no microphone the browser can see, or it is disabled at the OS level.'];
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return ['in use by another app', 'A meeting, a recorder, or another tab is holding the microphone. Close it and press Start again.'];
  }
  if (name === 'OverconstrainedError') {
    return ['refused the requested settings', 'The device exists but rejected echo cancellation / mono / gain constraints. Some headsets do this; unplug and retry, or just type.'];
  }
  return ['could not open', e?.message || String(e)];
}

function showMicHelp(e) {
  const [why, how] = micFailure(e);
  const strip = $('micHelp');
  if (strip) {
    $('micWhy').textContent = `Mic blocked — ${why}.`;
    $('micHow').textContent = how;
    $('micOpenTab').href = location.href;
    strip.hidden = false;
  }
  setMode('text in · voice out', 'muted');
  el.say.textContent = 'Mic blocked — type below, I will answer out loud.';
  note(`Mic blocked (${why}). No problem: the call still works — write, and listen.`, 'err');
}

function closeMic() {
  try { proc?.disconnect(); sink?.disconnect(); } catch {}
  stream?.getTracks().forEach((t) => t.stop());
  proc = stream = sink = null;
  pending = new Int16Array(0);
}

/** Queue a 24 kHz mono PCM buffer; scheduled gaplessly against the audio clock. */
/*
 * "Warm", "Firm", "Breezy" are adjectives; two people hear two different voices in
 * them. One REST call to the TTS row plays the actual voice reading an actual line it
 * would say on this call — the choice gets made by ear. Free tier, no dependency.
 * Deliberately no style directive in the text: some TTS rows read an instruction aloud
 * instead of acting on it, which is worse than sending none.
 */
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_PATH = 'tts';
const TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`;

/** Canonical 44-byte header: the TTS row returns raw 24 kHz signed-16 mono. */
function pcmToWav(pcm, rate = 24000) {
  const len = pcm.length;
  const out = new Uint8Array(44 + len);
  const dv = new DataView(out.buffer);
  const ascii = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + len, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); // PCM, mono
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, 'data'); dv.setUint32(40, len, true);
  out.set(pcm, 44);
  return out;
}

const isRiff = (b) => b.length > 4 && b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70;

function unbase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function audition() {
  const btn = $('fAudition');
  const log = el.sheetLog;
  const name = $('fVoice').value;
  const line = (($('fSample').value || '').trim() || cfg.sample || DEFAULTS.sample).slice(0, 240);
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: line }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      // Same nesting as the Live setup frame, for the same reason.
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: name } } },
    },
  });
  // Keysafe mode keeps the key out of browser storage, so the audition goes through the
  // server too — otherwise voices could only be previewed in the weaker mode. A key
  // typed into the sheet but not yet saved still works: this is a preview, not a call.
  const typedKey = ($('fKey').value || '').trim();
  const key = cfg.key || typedKey;
  const viaServer = cfg.keysafe;
  if (!viaServer && !key) {
    if (log) log.textContent = 'Paste a key above first — it is needed to render a sample.';
    return;
  }
  const url = viaServer ? `${location.origin}/${TTS_PATH}` : TTS_URL;
  const headers = { 'content-type': 'application/json' };
  if (!viaServer) headers['x-goog-api-key'] = key;

  btn.disabled = true;
  if (log) { log.hidden = false; log.textContent = `rendering "${name}" on ${TTS_MODEL}…`; }
  try {
    await ensureAudio();
    const r = await fetch(url, { method: 'POST', headers, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    const part = (j?.candidates?.[0]?.content?.parts || []).find((x) => x?.inlineData?.data);
    if (!part) throw new Error('no audio in the response — the model or voice name may be off');
    const raw = unbase64(part.inlineData.data);
    const wav = isRiff(raw) ? raw : pcmToWav(raw, 24000);
    if (log) log.textContent = `${name} · ${VOICES[name] || '—'} · ${(wav.length / 1024) | 0} kB — plays through your Voice feel chain`;
    if (actx?.decodeAudioData) {
      const buf = await actx.decodeAudioData(wav.buffer.slice(0));
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.connect(el.outGain);
      src.start();
    } else if (typeof URL !== 'undefined' && URL.createObjectURL && typeof Blob !== 'undefined') {
      new window.Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))).play().catch(() => {});
    }
  } catch (e) {
    // Never throw the user into a dead button: say what failed and why.
    if (log) log.textContent = `Audition failed: ${e.message}`;
    note(`Audition failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

/** Wire outGain -> [tone chain] -> destination. outGain stays the duck point. */
function buildOutput() {
  const trim = actx.createGain();
  trim.gain.value = 1;
  let tail = trim;
  const t = TONE[cfg.tone] ?? TONE.natural;
  if (t && actx.createBiquadFilter) {
    const low = actx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 180; low.gain.value = t.low;
    const pres = actx.createBiquadFilter();
    pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.8; pres.gain.value = t.pres;
    const hi = actx.createBiquadFilter();
    hi.type = 'highshelf'; hi.frequency.value = 7000; hi.gain.value = t.hi;
    const comp = actx.createDynamicsCompressor ? actx.createDynamicsCompressor() : null;
    trim.connect(low); low.connect(pres); pres.connect(hi);
    tail = hi;
    if (comp) {
      comp.threshold.value = t.thr; comp.ratio.value = t.ratio;
      comp.attack.value = 0.003; comp.release.value = 0.12;
      hi.connect(comp); tail = comp;
    }
  }
  tail.connect(actx.destination);
  el.outGain = trim;
}

/**
 * Created on the tap that started the call, never after an await: build the context
 * *after* `await getUserMedia()` and the gesture has already expired — on iOS/Safari
 * that leaves a permanently suspended context, which is silent audio with no error and
 * nothing in the console. So this is called first, synchronously, from connect().
 */
async function ensureAudio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    actx = new AC();
  }
  if (actx.state === 'suspended') { try { await actx.resume(); } catch {} }
  if (!el.outGain) buildOutput();
  return Boolean(actx);
}

function playPcm(int16) {
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  const buf = actx.createBuffer(1, f.length, OUT_RATE);
  buf.copyToChannel(f, 0);
  const s = actx.createBufferSource();
  s.buffer = buf;
  s.connect(el.outGain);
  const t = Math.max(actx.currentTime + 0.012, playAt);
  s.start(t);
  playAt = t + buf.duration;
  stats.recv += buf.duration;
  el.sRecv.textContent = stats.recv.toFixed(1) + 's';
  activeSrc.push(s);
  s.onended = () => {
    activeSrc = activeSrc.filter((x) => x !== s);
    if (!activeSrc.length) {
      outBarOff();
      if (agentSpeaking) setAgentSpeaking(false);
    }
  };
}

const outBarOff = () => (el.outBar.style.width = '0%');

function flushPlayback() {
  activeSrc.forEach((s) => {
    try { s.onended = null; s.stop(); } catch {}
  });
  activeSrc = [];
  playAt = 0;
  outBarOff();
}

// ───────────────────────────────────────────────────────── the live session ──
let ws = null;
let agentSpeaking = false;
let muted = false;
let kickedOff = false;
let micBlocked = false;
let settled = false; // setupComplete seen
let triedMinimal = false;
let tools = {};

function setAgentSpeaking(on) {
  agentSpeaking = on;
  duck(1);
  if (on) {
    if (abubble) abubble.classList.add('pending');
    setMode('agent talking', 'speaking');
    el.say.textContent = 'Agent bol raha hai…';
    el.outBar.style.width = '40%';
    endThinking();
  } else {
    abubble?.classList.remove('pending');
    // 'muted' covers both cases where nothing is being captured: you muted it, and
    // the browser refused the microphone. Either way, claiming 'listening' would be
    // the one thing a voice UI must never do — show a state that is not happening.
    setMode(micBlocked ? 'text in · voice out' : muted ? 'muted' : 'listening',
      micBlocked || muted ? 'muted' : 'listening');
    el.say.innerHTML = muted
      ? 'Mic muted — tap <b>Unmute</b> to interrupt again.'
      : 'Boliye — <b>main sun raha hoon</b>.';
  }
}

let thinkTimer = null;
let duckUntil = 0;
function beginThinking() {
  setMode('thinking', 'thinking');
  if (el.lat) el.lat.hidden = false;
  // Any pause approaching 2 s reads as a dead line. Say so before the caller
  // hangs up or repeats themselves, and log it — dead-air p95 is the metric.
  clearTimeout(thinkTimer);
  thinkTimer = setTimeout(() => {
    if (callState === 'thinking') {
      if (el.latHint) el.latHint.textContent = 'still thinking';
      stats.deadair = (stats.deadair || 0) + 1;
      note('agent is slow this turn — dead air is a bug we count, not hide', 'sys');
    }
  }, 1800);
}
function endThinking() {
  clearTimeout(thinkTimer);
  if (el.lat) el.lat.hidden = true;
  if (el.latHint) el.latHint.textContent = 'thinking';
}

/** Barge-in is a policy with outcomes, not a boolean. */
const STOP_WORDS = /\b(ruko|reeh|chup|cancel|stop|never mind|hold on|badam)\b/i;
const BACKCHANNEL = /^\s*(haan|han|hm+h|mhm+|okay|ok|theek|accha|ji|yeah|sahi)\s*[.!?]?\s*$/i;
function duck(to) {
  if (el.outGain) el.outGain.gain.value = to;
}
function bargePolicy(heard, now) {
  if (!heard) {
    // A short vocalisation during playback is a backchannel ("haan"), not an
    // interrupt: duck, then come back up. Cutting for that is what makes people
    // stop using interruption at all.
    if (duckUntil && now > duckUntil) {
      duckUntil = 0;
      duck(1);
    }
    return;
  }
  const held = Math.max(0, now - (stats.since || now));
  if (!duckUntil) {
    duckUntil = now + 300;
    duck(0.35);
  }
  // Committed speech, or an explicit stop word, or Esc — that is a real interrupt.
  if (held > 300 && now - (stats.lastFlush || 0) > 320) {
    stats.lastFlush = now;
    duckUntil = 0;
    flushPlayback();
    setAgentSpeaking(false);
    setMode('interrupted by you', 'interrupted', false);
    stats.interrupts = (stats.interrupts || 0) + 1;
    setTimeout(() => {
      if (callState === 'interrupted') setAgentSpeaking(false);
    }, 700);
  }
}

/**
 * False cutoff — the user starts again within 500 ms of the agent beginning to
 * speak — is the number that says our endpointing is too eager. It is counted
 * because guessing at conversation quality is how you ship a walkie-talkie.
 */
function onSpeechEnd(now) {
  stats.turnEndAt = now;
  if (agentSpeaking && now - (stats.speakStartAt || 0) < 500) {
    stats.falseCutoff = (stats.falseCutoff || 0) + 1;
  }
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendAudio(int16) {
  send({
    realtimeInput: {
      audio: { data: b64(new Uint8Array(int16.buffer)), mimeType: `audio/pcm;rate=${IN_RATE}` },
    },
  });
}

function fullSetup() {
  const setup = {
      model: cfg.model,
      // These live under setup.generationConfig, not on setup itself — the Live API
      // reference is explicit. Sent flat, `speechConfig` is an unknown field: the call
      // still works, the model speaks, and the voice you picked is silently dropped.
      // That is the worst possible failure, because it looks like it is applying.
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
      },
      systemInstruction: { parts: [{ text: cfg.prompt }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Advertising the tools is what makes them callable. Declaring the handler
    // alone gives you a model that politely describes what it would have done.
    tools: [
      {
        functionDeclarations: [
          {
            name: 'end_call',
            description:
              'End the phone call. Call this only after you have said your goodbye line.',
            parameters: {
              type: 'object',
              properties: {
                reason: { type: 'string', description: 'Why the call is ending.' },
              },
            },
          },
          {
            name: 'take_note',
            description:
              'Save one durable fact from the call: a number, a date, an amount, a request. ' +
              'Put anything the caller must confirm in `confirm`.',
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The fact, one line.' },
                confirm: {
                  type: 'string',
                  description: 'Value that still needs read-back confirmation, else empty.',
                },
              },
              required: ['text'],
            },
          },
        ],
      },
    ],
  };
  if (cfg.vad === 'ptt') {
    setup.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };
  }
  return { setup };
}
const minimalSetup = () => ({
  setup: { model: cfg.model, responseModalities: ['AUDIO'] },
});

async function connect() {
  if (ws) return;
  if (!cfg.key) {
    openSheet();
    note('Gemini API key chahiye pehle — free hai, card nahi.', 'err');
    return;
  }
  await ensureAudio();
  micBlocked = false;
  try {
    await openMic();
  } catch (e) {
    // A blocked microphone used to end the attempt here. That was wrong: nothing about
    // *hearing* the agent needs a mic, and "your browser will not give me audio input"
    // is a normal state on an embedded preview, a locked-down work laptop, or a phone
    // with the mic switch on mute. So say exactly why, offer the way out, and carry on
    // as voice-out / text-in instead of failing the call.
    micBlocked = true;
    showMicHelp(e);
  }

  setMode('connecting', 'connecting');
  el.say.textContent = 'Connecting…';
  const url = cfg.keysafe ? `${RELAY}` : `${DIRECT}?key=${encodeURIComponent(cfg.key)}`;
  ws = new WebSocket(url);
  ws.onopen = () => send(triedMinimal ? minimalSetup() : fullSetup());
  ws.onmessage = onMessage;
  ws.onclose = (e) => {
    if (!settled && e.code === 1006) note('Socket died before setup — model name or key?', 'err');
    teardown();
  };
  ws.onerror = () => note('WebSocket error — open DevTools console for the frame.', 'err');
}

function onMessage(ev) {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }

  if (m.setupComplete) {
    settled = true;
    stats.calls++;
    el.sCalls.textContent = stats.calls;
    el.hangup.hidden = false;
    // A session with no microphone is not "listening" — claiming it would be the one
    // thing a voice UI must never do, showing a state that is not happening.
    el.muteBtn.hidden = micBlocked;
    el.ptt.hidden = cfg.vad === 'ptt' || micBlocked;
    if (!micBlocked) {
      setMode('listening', 'listening');
      el.say.textContent = 'Boliye — main sun raha hoon.';
    } else {
      setMode('text in · voice out', 'muted');
      el.say.textContent = 'Type below — I will answer out loud.';
    }
    blip('open');
    if (cfg.vad === 'ptt') el.say.textContent = 'Hold the button and talk.';
    // Ask for the opening turn. The caller should not have to speak first just to
    // find out whether the call is alive.
    if (!kickedOff) {
      kickedOff = true;
      send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: CONNECT_SIGNAL + '\n' + cfg.greeting }] }],
          turnComplete: true,
        },
      });
      beginThinking();
    }
    return;
  }

  // The agent started a turn. Measure what the caller actually feels:
  // silence → first audio out.
  const sc = m.serverContent;
  if (sc?.modelTurn?.parts) {
    for (const p of sc.modelTurn.parts) {
      const b64data = p.inlineData?.data;
      if (!b64data) continue;
      if (!agentSpeaking) {
        ububble = null;
        setAgentSpeaking(true);
        stats.speakStartAt = performance.now();
        if (stats.turnStart) {
          const ms = Math.round(performance.now() - stats.turnStart);
          el.sTurnLat.textContent = ms + 'ms';
          el.sTurnLat.dataset.bad = ms > 1200 ? '1' : '0';
          stats.turnStart = 0;
          // Averages hide the calls people remember. Track the tail.
          stats.lats = (stats.lats || []).concat(ms).sort((a, b) => a - b);
          const q = (f) => stats.lats[Math.min(stats.lats.length - 1, Math.floor(f * stats.lats.length))];
          el.sSpread.textContent = stats.lats.length > 2 ? q(0.5) + '/' + q(0.95) + 'ms' : q(0.5) + 'ms';
          el.sSpread.dataset.bad = q(0.95) > 1600 ? '1' : '0';
        }
      }
      const raw = atob(b64data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      playPcm(new Int16Array(bytes.buffer));
      el.outBar.style.width = Math.min(100, 30 + activeSrc.length * 18) + '%';
    }
  }
  if (sc?.inputTranscription?.text) {
    const heardText = sc.inputTranscription.text.trim();
    appendTurn('user', heardText);
    // The other half of the barge-in policy, decided on words rather than energy:
    // an explicit stop cuts at once, a backchannel just ducks the volume.
    if (agentSpeaking && STOP_WORDS.test(heardText)) {
      duckUntil = 0;
      flushPlayback();
      setAgentSpeaking(false);
      setMode('interrupted by you', 'interrupted');
    } else if (agentSpeaking && BACKCHANNEL.test(heardText)) {
      duckUntil = 0;
      duck(1);
    }
  }
  if (sc?.outputTranscription?.text) appendTurn('agent', sc.outputTranscription.text);
  if (sc?.turnComplete) {
    abubble = null;
    if (!activeSrc.length) setAgentSpeaking(false);
  }

  if (m.toolCall) handleToolCall(m.toolCall);
  if (m.setupError || m.error) reportError(m.setupError || m.error);
  if (m.relayError) note(`relay: ${m.relayError.reason || m.relayError.code}`, 'err');
  if (m.goAway) {
    note(`goAway at ${new Date(m.goAway.timeRemainingAfterMs / 1000).toISOString().slice(11, 19)} remaining — session ending, reconnect to keep talking.`, 'err');
  }
}

function reportError(err) {
  const msg = err?.message || JSON.stringify(err);
  if (!triedMinimal && /speechConfig|realtimeInputConfig|transcription|Unknown name|Invalid JSON/i.test(msg)) {
    // Field-name churn between model generations. Degrade to the one shape
    // every Live model accepts rather than dying on a config we cannot verify.
    triedMinimal = true;
    note('Config fields rejected → retrying with minimal setup (voice/VAD go default).', 'sys');
    // Full teardown first: connect() reopens the mic, and leaving the old
    // MediaStream + AudioContext alive leaks the recorder and stacks graphs.
    const k = cfg.key;
    teardown();
    cfg.key = k;
    // teardown() clears this on purpose (a fresh manual start should try full
    // config again); the auto-retry must stay on the minimal path or it loops.
    triedMinimal = true;
    setTimeout(start, 500);
    return;
  }
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    note('Free-tier quota hit for today. That is the ₹0 ceiling — wait for the day to roll, or use a second project.', 'err');
  } else if (/NOT_FOUND|404|no such model|unsupported/i.test(msg)) {
    note(`Model row not available to this key: "${cfg.model}". Try another in ⚙ (the free-tier list moves).`, 'err');
  } else {
    note(msg, 'err');
  }
  el.say.textContent = 'Setup fail hua — ⚙ khol ke dekho.';
  el.sheetLog.textContent += '\n' + msg;
  el.sheetLog.hidden = false;
}

// ───────────────────────────────────────────────────────── local tools ──
// The one honest advantage of owning the loop: a tool that hangs up a real
// call needs no model provider's permission.
tools.end_call = async ({ reason }) => {
  note(`agent ended the call (${reason || 'no reason given'})`, 'sys');
  setTimeout(teardown, 900);
  return { ok: true, note: 'call ended' };
};
tools.take_note = async ({ text, confirm }) => {
  appendTurn('user', `📝 ${text}${confirm ? ` — pending confirmation: ${confirm}` : ''}`);
  const all = JSON.parse(localStorage.getItem('aryans-aicall/notes') || '[]');
  all.push({ at: new Date().toISOString(), text, confirm: confirm || null });
  localStorage.setItem('aryans-aicall/notes', JSON.stringify(all));
  return { ok: true, saved: all.length };
};

async function handleToolCall(call) {
  const responses = [];
  for (const fc of call.functionCalls || []) {
    const fn = tools[fc.name];
    let payload;
    try {
      payload = fn ? await fn(fc.args || {}) : { error: `unknown tool ${fc.name}` };
    } catch (e) {
      payload = { error: String(e?.message || e) };
    }
    responses.push({ id: fc.id, name: fc.name, response: payload });
  }
  if (responses.length) send({ toolResponse: { functionResponses: responses } });
}

function teardown() {
  kickedOff = false;
  micBlocked = false; // a new call earns a new greeting
  flushPlayback();
  closeMic();
  try { ws?.close(); } catch {}
  ws = null;
  settled = false;
  triedMinimal = false;
  agentSpeaking = false;
  actx?.close().catch(() => {});
  actx = null;
  blip('close');
  el.muteBtn.hidden = true;
  muted = false;
  el.muteBtn.setAttribute('aria-pressed', 'false');
  el.core.textContent = '🎙';
  el.hangup.hidden = true;
  el.ptt.hidden = true;
  el.say.textContent = 'Tap the mic to start talking. Hinglish chalega.';
  setMode('idle', 'idle');
  // A call that ends mid-speech must not hand the next call a half-open turn:
  // without this, the first silence block closes a turn that started in the
  // previous session and reports it as a multi-thousand-millisecond "turn".
  stats.turnStart = 0;
  stats.speech = false;
  stats.since = 0;
  const help = $('micHelp');
  if (help) help.hidden = true;
  stats.lastFlush = 0;
  duckUntil = 0;
  clearTimeout(thinkTimer);
  if (el.lat) el.lat.hidden = true;
  el.outGain = null; // the context outlives the graph; rebuild the chain next call
}

async function start() {
  if (ws) return;
  await connect();
}

// ────────────────────────────────────────────────────────────── a11y prefs ──
// Honour the OS, but let the user override it in-app and keep that choice:
// prefers-reduced-motion is not a setting everyone can reach (iOS Safari,
// locked-down Android), and a voice app is used one-handed on a phone.
const A11Y_KEY = 'aryans-aicall/a11y';
const a11y = Object.assign(
  { motion: 'system', contrast: 'system', scale: '1', cues: true },
  JSON.parse(localStorage.getItem(A11Y_KEY) || '{}')
);
function applyA11y() {
  const r = document.documentElement;
  r.dataset.motion = a11y.motion === 'system' ? '' : a11y.motion;
  r.dataset.contrast = a11y.contrast === 'system' ? '' : a11y.contrast;
  r.style.setProperty('--font-scale', a11y.scale);
  localStorage.setItem(A11Y_KEY, JSON.stringify(a11y));
}
// A cue that outstays ~150 ms masks the first phoneme of what follows, which is
// precisely the syllable the ASR needed. Short and quiet, or not at all.
function blip(kind) {
  if (!a11y.cues || !actx) return;
  try {
  const t = actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.frequency.setValueAtTime(kind === 'open' ? 660 : 880, t);
  o.frequency.exponentialRampToValueAtTime(kind === 'open' ? 990 : 520, t + 0.09);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + 0.13);
    // Haptics carry the same event for anyone who cannot hear or feel a blip.
    if (navigator.vibrate) navigator.vibrate(kind === 'open' ? 12 : [8, 24, 8]);
  } catch {
    /* no oscillator, no call problem */
  }
}

// ────────────────────────────────────────────────────────────── wiring ui ──
el.pttBtn.addEventListener('click', () => (ws ? teardown() : start()));
// Esc closes the dialog rather than only cutting audio when a sheet is open.
el.hangup.addEventListener('click', teardown);
el.muteBtn.addEventListener('click', () => {
  muted = !muted;
  el.muteBtn.setAttribute('aria-pressed', String(muted));
  el.muteBtn.querySelector('.lbl').textContent = muted ? 'Unmute' : 'Mute';
  el.muteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  setMode(muted ? 'muted' : agentSpeaking ? 'agent talking' : 'listening',
    muted ? 'muted' : agentSpeaking ? 'speaking' : 'listening');
  if (!agentSpeaking) el.say.innerHTML = muted
    ? 'Mic muted — the agent still speaks, it just cannot hear you.'
    : 'Boliye — <b>main sun raha hoon</b>.';
});
el.muteBtn.hidden = false;

// Type instead of speak: a real failure mode of voice is "I am on a bus".
el.textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.textInput.value.trim();
  if (!text) return;
  if (!ws) return note('Start the session first, then type.', 'err');
  send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  appendTurn('user', text);
  el.textInput.value = '';
  beginThinking();
});

// Jump-to-latest instead of yanking the scroll when the reader scrolled up.
el.jump?.addEventListener('click', () => stick(true));
el.thread?.addEventListener('scroll', () => {
  if (nearBottom() && el.jump) el.jump.hidden = true;
});

// "How interruption works" disclosure — discoverability, since there are no buttons.
$('bargeInfo')?.addEventListener('click', (e) => {
  const fold = $('bargeHelp');
  const open = fold.hidden;
  fold.hidden = !open;
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

// push to talk: explicit turn boundaries instead of server VAD
let pttOn = false;
const pttSet = (on) => {
  if (on === pttOn) return;
  pttOn = on;
  el.ptt.classList.toggle('held', on);
  if (on) {
    send({ realtimeInput: { activityStart: {} } });
    setMode('you talk', 'listening');
  } else {
    send({ realtimeInput: { activityEnd: {} } });
    stats.turnStart = performance.now();
    setMode('thinking', 'connecting');
  }
};
for (const ev of ['pointerdown', 'pointerenter']) el.ptt.addEventListener(ev, () => pttSet(true));
for (const ev of ['pointerup', 'pointercancel', 'pointerleave'])
  el.ptt.addEventListener(ev, () => pttSet(false));

// Barge-in. The model already handles interruption server-side; what it cannot
// do is un-ring your speakers. We own the flush.
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !el.sheet.hidden) {
    closeSheet();
    return;
  }
  if (e.code === 'Escape' && agentSpeaking) {
    flushPlayback();
    setAgentSpeaking(false);
    note('interrupted by you', 'sys');
  }
  if (e.code === 'Space' && cfg.vad === 'ptt' && ws) {
    e.preventDefault();
    pttSet(true);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && pttOn) pttSet(false);
});

// settings sheet
const openSheet = () => {
  $('fKey').value = cfg.key;
  $('fModel').value = cfg.model;
  $('fVoice').value = cfg.voice;
  $('fVad').value = cfg.vad;
  $('fGuard').checked = cfg.guard;
  $('fTone').value = cfg.tone;
  $('fSample').value = cfg.sample;
  $('voiceHint').textContent = `${cfg.voice} · ${VOICES[cfg.voice] || '—'}`;
  $('fPrompt').value = cfg.prompt;
  $('fGreet').value = cfg.greeting;
  $('fMotion').value = a11y.motion;
  $('fContrast').value = a11y.contrast;
  $('fScale').value = a11y.scale;
  $('fCues').checked = a11y.cues;
  el.sheet.hidden = false;
  $('gearBtn').setAttribute('aria-expanded', 'true');
  // Move focus into the dialog, then hand it back on close.
  setTimeout(() => $('fKey').focus(), 30);
};
const closeSheet = () => {
  el.sheet.hidden = true;
  $('gearBtn').setAttribute('aria-expanded', 'false');
  $('gearBtn').focus();
};
$('gearBtn').addEventListener('click', () => (el.sheet.hidden ? openSheet() : closeSheet()));
$('sheetClose').addEventListener('click', closeSheet);
// Dismiss by tapping the dimmed area — the reflex everyone has on a bottom sheet.
// Compare the event target to the sheet itself, so a press that starts on a field
// and releases over the backdrop cannot close the dialog and lose what was typed.
el.sheet.addEventListener('click', (e) => {
  if (e.target === el.sheet) closeSheet();
});
$('fVoice').addEventListener('change', () => {
  const n = $('fVoice').value;
  $('voiceHint').textContent = `${n} · ${VOICES[n] || 'unknown to this build'}`;
});
$('fAudition').addEventListener('click', () => audition());
// The defaults improve; a copy saved last month does not. One click back, without
// touching storage — saving stays an explicit act.
$('fReset').addEventListener('click', () => {
  $('fPrompt').value = DEFAULT_PROMPT;
  $('fGreet').value = DEFAULT_GREETING;
  $('fSample').value = DEFAULTS.sample;
  note('Defaults restored in the form. Save to keep them.', 'sys');
});
$('sheetSave').addEventListener('click', () => {
  cfg = load();
  cfg = {
    ...cfg,
    key: $('fKey').value.trim(),
    model: $('fModel').value.trim(),
    voice: $('fVoice').value,
    tone: $('fTone').value,
    sample: $('fSample').value.trim() || DEFAULTS.sample,
    vad: $('fVad').value,
    guard: $('fGuard').checked,
    // Blank resets rather than persists: an empty persona silently removes every
    // rule that makes this behave like a phone agent.
    prompt: $('fPrompt').value.trim() || DEFAULT_PROMPT,
    greeting: $('fGreet').value.trim() || DEFAULT_GREETING,
  };
  Object.assign(a11y, {
    motion: $('fMotion').value,
    contrast: $('fContrast').value,
    scale: $('fScale').value,
    cues: $('fCues').checked,
  });
  applyA11y();
  save(cfg);
  // Tone is live: rebuilding the output graph applies it to the rest of this call
  // instead of making the user hang up to hear whether it helped.
  if (actx) { el.outGain = null; buildOutput(); }
  closeSheet();
  note('Saved. Restart the session to apply.', 'sys');
  if (ws) { teardown(); note('Session restarted with the new settings — tap the mic again.', 'sys'); }
});

$('sheetTest').addEventListener('click', async () => {
  el.sheetLog.hidden = false;
  el.sheetLog.textContent = 'probing…';
  const k = $('fKey').value.trim();
  if (!k) return (el.sheetLog.textContent = 'no key');
  // A cheap REST probe: no audio, no quota burn, answers "does this key exist
  // and can it see that model row".
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model.replace('models/', ''))}?key=${encodeURIComponent(k)}`
    );
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      el.sheetLog.textContent = `OK — ${cfg.model}\nmethods: ${(j.supportedGenerationMethods || []).join(', ')}`;
      if (!String(j.supportedGenerationMethods || '').includes('streamGenerateContent')) {
        el.sheetLog.textContent += '\n⚠ no streaming method listed — Live API may refuse this row.';
      }
    } else {
      el.sheetLog.textContent = `${r.status} ${j?.error?.status || ''}\n${j?.error?.message || 'no body'}`;
    }
  } catch (e) {
    el.sheetLog.textContent = 'fetch failed: ' + e.message + '\n(brain is behind the proxy? use PROXY=1 mode)';
  }
});

(async () => {
  cfg = load();
  applyA11y();
  try {
    const c = await (await fetch('/config')).json();
    cfg.keysafe = Boolean(c.keysafe);
    save(cfg);
    if (cfg.keysafe) el.keyWarn.textContent = 'Server holds the key (proxy mode). Nothing to paste.';
  } catch {}
  if (!cfg.key && !cfg.keysafe) {
    openSheet();
  }
  if (!window.isSecureContext) {
    note('Insecure origin: getUserMedia needs https:// or localhost.', 'err');
  }
})();
