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

TONE
- Warm, efficient, a little dry. No "Great question!" and no filler like "Absolutely!".`;

const DEFAULTS = {
  key: '',
  model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
  voice: 'Kore',
  vad: 'server',
  guard: true,
  prompt: DEFAULT_PROMPT,
};

const LS = 'aryans-aicall/v0';
const load = () => ({ ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || '{}') });
const save = (c) => localStorage.setItem(LS, JSON.stringify(c));
let cfg = load();

const RELAY = location.origin + '/relay';
const DIRECT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta' +
  '.GenerativeService.BidiGenerateContent';

// ─────────────────────────────────────────────────────────────── dom bits ──
const $ = (id) => document.getElementById(id);
const el = {
  dot: $('statusDot'), pill: $('modePill'), orb: $('orb'), core: $('coreGlyph'),
  say: $('say'), thread: $('thread'), empty: $('emptyNote'), inBar: $('inBar'),
  outBar: $('outBar'), sTurnLat: $('sTurnLat'), sRecv: $('sRecv'), sCalls: $('sCalls'),
  pttBtn: $('pttBtn'), ptt: $('pushToTalk'), hangup: $('hangup'), sheet: $('sheet'),
  sheetLog: $('sheetLog'), keyWarn: $('keyWarn'),
};

const setMode = (text, state) => {
  el.pill.textContent = text;
  el.orb.dataset.state = state;
  el.dot.dataset.state = state;
};

// A log line that does not need a whole transcript bubble.
const note = (msg, kind = 'sys') => {
  el.empty?.remove();
  const d = document.createElement('div');
  d.className = `note ${kind}`;
  d.textContent = msg;
  el.thread.append(d);
  el.thread.scrollTop = el.thread.scrollHeight;
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
  el.thread.scrollTop = el.thread.scrollHeight;
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
  el.thread.scrollTop = el.thread.scrollHeight;
}

// ────────────────────────────────────────────────────────────── audio model ──
// One AudioContext. Mic blocks are resampled to 16 kHz by hand; playback
// buffers are *declared* at 24 kHz and the browser resamples on output, which
// avoids the "sampleRate not supported" trap on iOS/Safari.
const IN_RATE = 16000;
const OUT_RATE = 24000;
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
  actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') await actx.resume();
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
    } else if (stats.speech && now - stats.since > 260) {
      stats.speech = false;
      if (!stats.turnStart) stats.turnStart = now; // the clock we grade ourselves on
    }
    // noise floor learns downward only, so a noisy room does not lock us open
    stats.floor = Math.min(heard ? stats.floor : Math.max(stats.floor * 0.985, rms), 0.05);

    if (agentSpeaking) {
      if (cfg.guard) return; // half-duplex guard: never feed it our own speaker
      // True barge-in. The model stops itself upstream, but it cannot un-ring
      // these speakers — and a flush every 40 ms would stutter, so cooldown.
      if (heard && performance.now() - (stats.lastFlush || 0) > 320) {
        stats.lastFlush = performance.now();
        flushPlayback();
        setAgentSpeaking(false);
      }
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

function closeMic() {
  try { proc?.disconnect(); sink?.disconnect(); } catch {}
  stream?.getTracks().forEach((t) => t.stop());
  proc = stream = sink = null;
  pending = new Int16Array(0);
}

/** Queue a 24 kHz mono PCM buffer; scheduled gaplessly against the audio clock. */
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
let settled = false; // setupComplete seen
let triedMinimal = false;
let tools = {};

function setAgentSpeaking(on) {
  agentSpeaking = on;
  el.core.textContent = on ? '🔊' : '🎙';
  setMode(on ? 'agent talking' : 'listening', on ? 'speaking' : 'listening');
  if (on) {
    el.outBar.style.width = '40%';
  } else {
    el.say.textContent = 'Boliye — I am listening.';
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
    responseModalities: ['AUDIO'],
    systemInstruction: { parts: [{ text: cfg.prompt }] },
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
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
  try {
    await openMic();
  } catch (e) {
    note(`Mic blocked: ${e.message}. Chrome needs https:// or localhost for getUserMedia.`, 'err');
    return;
  }
  el.outGain = actx.createGain();
  el.outGain.gain.value = 1;
  el.outGain.connect(actx.destination);

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
    setMode('listening', 'listening');
    el.say.textContent = 'Boliye — main sun raha hoon.';
    el.hangup.hidden = false;
    el.ptt.hidden = cfg.vad === 'ptt';
    if (cfg.vad === 'ptt') el.say.textContent = 'Hold the button and talk.';
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
        el.say.textContent = 'Agent bol raha hai…';
        if (stats.turnStart) {
          const ms = Math.round(performance.now() - stats.turnStart);
          el.sTurnLat.textContent = ms + 'ms';
          el.sTurnLat.dataset.bad = ms > 1200 ? '1' : '0';
          stats.turnStart = 0;
        }
      }
      const raw = atob(b64data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      playPcm(new Int16Array(bytes.buffer));
      el.outBar.style.width = Math.min(100, 30 + activeSrc.length * 18) + '%';
    }
  }
  if (sc?.inputTranscription?.text) appendTurn('user', sc.inputTranscription.text.trim());
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
  flushPlayback();
  closeMic();
  try { ws?.close(); } catch {}
  ws = null;
  settled = false;
  triedMinimal = false;
  agentSpeaking = false;
  actx?.close().catch(() => {});
  actx = null;
  el.core.textContent = '🎙';
  el.hangup.hidden = true;
  el.ptt.hidden = true;
  el.say.textContent = 'Tap the mic to start talking. Hinglish chalega.';
  setMode('idle', 'idle');
  stats.turnStart = 0;
}

async function start() {
  if (ws) return;
  await connect();
}

// ────────────────────────────────────────────────────────────── wiring ui ──
el.pttBtn.addEventListener('click', () => (ws ? teardown() : start()));
el.hangup.addEventListener('click', teardown);

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
  $('fPrompt').value = cfg.prompt;
  el.sheet.hidden = false;
};
const closeSheet = () => (el.sheet.hidden = true);
$('gearBtn').addEventListener('click', openSheet);
$('sheetClose').addEventListener('click', closeSheet);
$('sheetSave').addEventListener('click', () => {
  cfg = load();
  cfg = {
    ...cfg,
    key: $('fKey').value.trim(),
    model: $('fModel').value.trim(),
    voice: $('fVoice').value,
    vad: $('fVad').value,
    guard: $('fGuard').checked,
    prompt: $('fPrompt').value,
  };
  save(cfg);
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
