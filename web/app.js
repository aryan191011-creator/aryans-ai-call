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
  // The Live rows are preview rows: they get renamed and retired on a schedule. This is
  // a starting point, not a fact — Settings probes your key for the rows it can actually
  // see, and a failed handshake retries against that list rather than blaming you.
  model: 'models/gemini-3.1-flash-live-preview',
  // A phone assistant wants to sound like a person who has time for you, not like a
  // read-aloud engine: Warm over Firm. Anyone can change it, by ear, in Settings.
  voice: 'Sulafat',
  tone: 'natural',
  sample: 'Theek hai, main note kar leta hoon. Aur kuch chahiye aapko?',
  vad: 'server',
  // Say "my turn is over" to the server instead of waiting for its silence timer.
  guard: true,
  hybrid: true,
  // Capable rows get the richer session: word timestamps, a Hinglish-friendly
  // vocabulary, transcript cleanup, and a resumable handle so a dropped line or the
  // 15-minute session cap costs the call nothing. Older rows get the smaller frame
  // they actually accept — sending fields a row does not know is how a call dies.
  caps: 'auto',
  prompt: DEFAULT_PROMPT,
  greeting: DEFAULT_GREETING,
};

/**
 * The row family decides which setup fields exist. Written as a test, not a table, so
 * a new row name is judged by what it says rather than by whether this file was
 * updated the week it shipped.
 */
const is25Row = (m) => /2\.5|native-audio/.test(String(m || ''));
const is3Row = (m) => /3\.[0-9]/.test(String(m || ''));
/**
 * 'auto' asks only what the row documents. Positive on 3.x, not "everything that is not
 * 2.5": an old `gemini-live-2.0-flash-exp` row is a Live row too, and a setup frame it
 * cannot parse is a dead socket blamed on your key. Full and Lean let you overrule a
 * guess this file got before the next row shipped.
 */
const capable = (m) => (cfg.caps === 'full' ? true : cfg.caps === 'lean' ? false : is3Row(m));

/**
 * Terms the model hears on a phone call in India. Order numbers, apps, money words:
 * the ones a generic ASR turns into "code" and "order for fee". Biasing is free,
 * costs no latency, and is the difference between "WhatsApp par bhej do" surviving
 * and becoming "what's app par bhej do".
 */
const BIAS_WORDS = [
  'WhatsApp', 'Paytm', 'PhonePe', 'UPI', 'OTP', 'COD', 'INR', 'rupees', 'lakh', 'crore',
  'Aryan', 'Hinglish', 'Jio', 'Airtel', 'Bolt', 'Rapido', 'Zomato', 'Swiggy', 'Flipkart',
  'Meesho', 'Amazon', 'kirana', 'bhai', 'ji', 'theek', 'kal', 'subah', 'shaam',
];
/** Up to 1,000 are allowed; 100 is where Google reports the best results. */
const CUSTOM_VOCAB = BIAS_WORDS.slice(0, 100);

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
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS_PATH = 'models';

/*
 * A WebSocket that is refused, blocked or pointed at a retired model row tells the
 * browser almost nothing: no status, no body, sometimes only code 1006 — and if the
 * handshake is silently dropped, nothing at all. So "Connecting…" gets a deadline, and
 * every way it can fail gets a sentence that names the cause. A spinner that never
 * resolves is the state people hate most in a voice app, and it is also the one that
 * makes them blame their own key.
 */
const HANDSHAKE_MS = 9000;
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
  sRecv: $('sRecv'), sCalls: $('sCalls'), sTokens: $('sTokens'), pttBtn: $('pttBtn'), pttLabel: $('pttLabel'),
  ptt: $('pushToTalk'), muteBtn: $('muteBtn'), hangup: $('hangup'), sheet: $('sheet'),
  sheetLog: $('sheetLog'), logBox: $('logBox'), logCount: $('logCount'), logCopy: $('logCopy'),
  logClear: $('logClear'), probeOut: $('probeOut'),
  keyWarn: $('keyWarn'), gear: $('gearBtn'),
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

/**
 * Turn a wire error into a sentence.
 *
 * A phone call that has failed does not need the API's prose: it needs to know whose fault
 * this looks like and what to do next. The raw string is not thrown away — `noteError` keeps
 * it under a collapsed disclosure and the settings log keeps it for a bug report — but it is
 * no longer the loudest thing on screen. This exists because a screenshot of this app showed
 * ten lines of red monospace protobuf (`Unknown name "responseModalities" at 'setup': Cannot
 * find field.`) as the entire user-facing error, twice, on a 6-inch screen.
 */
function humanError(raw) {
  const msg = String(raw || '').trim();
  if (!msg) return 'Something went wrong, and the endpoint had nothing to say about it.';
  const unknown = unknownFieldOf(msg);
  if (unknown) return `This row does not recognise the config field "${unknown.field}".`;
  if (/1007|Invalid JSON payload/i.test(msg)) return 'The endpoint refused the request format, so the call never started.';
  if (/401|UNAUTHENTICATED|API key not valid|invalid.*key/i.test(msg)) return 'Google does not accept that API key — check it was pasted whole, with no space at the end.';
  if (/403|PERMISSION_DENIED|hasn't used project/i.test(msg)) return 'This key is not allowed to reach that row for this project.';
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) return 'Free-tier quota is used up for now.';
  if (/404|NOT_FOUND|no such model|unsupported/i.test(msg)) return 'That model row is not available to this key.';
  if (/network|ERR_|Failed to fetch|dns|enotfound|timed? ?out/i.test(msg)) return 'The request never got to Google — this looks like the network, not the key.';
  if (/1006|closed before it opened|socket error/i.test(msg)) return 'The line dropped before the call could start.';
  if (/media|getUserMedia|permission denied.*microphone|notallowed/i.test(msg)) return 'The microphone refused to open.';
  // Nothing recognised. Do NOT echo the message: cutting machine prose at the first full stop
  // is a shorter stack trace, not a diagnosis, and on a phone it is still the loudest thing on
  // the screen. Say what is known — the endpoint answered, so the network is fine and the key
  // got through — and where the detail went.
  if (/^socket closed|^the Live socket|^the live socket/i.test(msg)) {
    return 'The line to Google dropped before the call could start.';
  }
  return 'The endpoint answered with something this app does not know how to read. Your key and your network are both fine — it got that far.';
}

/** One failure, one place: a sentence you can act on, with the raw text under it. */
function noteError(human, raw, kind = 'err') {
  note(human, kind);
  if (!raw) return;
  el.empty?.remove();
  const d = document.createElement('div');
  d.className = 'note raw';
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = 'technical detail';
  const pre = document.createElement('pre');
  pre.textContent = String(raw).slice(0, 2000);
  det.append(sum, pre);
  d.append(det);
  el.thread.append(d);
  // The raw payload belongs in the log, where a bug report can copy it — and only there.
  // Appending it to the transcript *as well* is what put the same string on screen twice.
  logLine(raw);
  stick();
}

/**
 * Append one line to the technical log and make the box visible.
 *
 * Every writer used to remember `hidden = false` on its own, and the ones that forgot left a
 * log that existed but could not be seen. The count in the summary is there so the box says how
 * much is in it before you open it — "3 lines" is a reason to look, an empty triangle is not.
 */
let logLines = 0;
function logLine(text) {
  el.sheetLog.textContent += `\n[${new Date().toISOString().slice(11, 19)}] ${String(text).slice(0, 600)}`;
  logLines++;
  el.sheetLog.setAttribute('data-lines', String(logLines));
  if (el.logCount) el.logCount.textContent = ` ${logLines} line${logLines === 1 ? '' : 's'}`;
  if (el.logBox) el.logBox.hidden = false;
}

/**
 * Copy the log. On the WebView this app ships in, the page is served over plain http, so
 * `navigator.clipboard` does not exist at all — an insecure context — and a copy button built
 * only on that API is a button that works on a laptop and fails on the phone that needs it.
 * So: clipboard if there is one, a selection the user can copy themselves if there is not,
 * and never a silent no-op.
 */
async function copyLog() {
  const text = String(el.sheetLog.textContent || '').trim();
  if (!text) { el.logCopy.textContent = 'nothing to copy yet'; return; }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      el.logCopy.textContent = 'copied ✓';
      return;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (ok) { el.logCopy.textContent = 'copied ✓'; return; }
  } catch {}
  // Last resort, and an honest one: put the text where a long-press will grab it.
  el.sheetLog.setAttribute('tabindex', '0');
  el.sheetLog.focus?.();
  el.logCopy.textContent = 'press and hold the text to copy';
}

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

/**
 * A call log without positions is a quote, not a record. Offsets arrive as a proto
 * Duration — "74s", or {seconds, nanos} — so both spellings are read. A line the row
 * gives no offset for simply carries no time; nothing here is invented.
 */
const mmss = (d) => {
  let secs = null;
  if (typeof d === 'number') secs = d;
  else if (typeof d === 'string') secs = parseFloat(d);
  else if (d && d.seconds != null) secs = Number(d.seconds) + (Number(d.nanos || 0) / 1e9);
  if (!Number.isFinite(secs) || secs < 0) return '';
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
};

/** Stamp a bubble with its offset from the start of the call, when the row sends one. */
function stampTurn(node, offset) {
  const at = mmss(offset);
  if (!at || !node) return;
  node.dataset.t = at;
  let ts = node.querySelector('.ts');
  if (!ts) {
    ts = document.createElement('span');
    ts.className = 'ts';
    node.querySelector('.who').append(ts);
  }
  ts.textContent = ` · ${at}`;
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

/*
 * Live captions for the caller's own speech. The interim transcript is overwritten, not
 * appended, and it is a throwaway node: the final `inputTranscription` owns the real
 * bubble. Keeping them separate is what stops the half-heard version of a sentence
 * sticking into the log next to the whole one — two copies of "mera order" is how a
 * transcript becomes untrustworthy, and this transcript is evidence.
 */
let interimNode = null;
function showInterim(text) {
  const t = String(text || '').trim();
  if (!t) return;
  if (!interimNode) {
    interimNode = makeTurn('user');
    interimNode.classList.add('live');
  }
  interimNode.querySelector('.tx').textContent = t;
  stick();
}
function dropInterim() {
  if (!interimNode) return;
  const n = interimNode;
  interimNode = null;
  n.classList.remove('live');
}

/**
 * The 15-minute audio-session cap is the number that ends calls mid-sentence. The
 * server tells us via goAway, but a row that never sends one still ends, so the
 * countdown is armed locally as well: refresh the line while the call is idle rather
 * than let Google do it at an arbitrary moment.
 */
let sessionTimer = null;
const SESSION_SOFT_MS = 13 * 60 * 1000;
function armSessionCap() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    // Only rotate when it is safe: mid-playback would cut a sentence, and a call the
    // user is watching is a call that can wait for a quieter second.
    if (!ws || !settled) return;
    if (agentSpeaking || activeSrc.length) { setTimeout(armSessionCap, 8000); return; }
    rotate('13 minute line — refreshing before the server ends it. Bilkul normal hai.');
  }, SESSION_SOFT_MS);
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
let sentStreamEnd = false; // one audioStreamEnd per utterance, or the server hears a stutter
let playAt = 0; // audio-clock time the next outbound buffer starts at
let activeSrc = [];
let stats = { recv: 0, calls: 0, turnStart: 0, firstByteAt: 0, speech: false, since: 0, floor: 0.004, tokens: 0 };

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
      stats.silenceAt = 0;
      sentStreamEnd = false;
    } else if (stats.speech && Math.max(0, now - stats.since) > 260) {
      stats.speech = false;
      if (!stats.turnStart) {
        stats.turnStart = now; // the clock we grade ourselves on
        // Announce "thinking" inside ~200 ms of end-of-speech. Past that, the
        // caller assumes the line dropped and starts again — voice has no spinner.
        if (agentSpeaking === false && settled) beginThinking();
      }
      stats.silenceAt = now;
      onSpeechEnd(now);
    } else if (!stats.speech && stats.turnStart && !sentStreamEnd) {
      // Hybrid endpointing: the server's own silence wait is ~800 ms, which the caller
      // feels as dead air at the end of every sentence. `audioStreamEnd` says "that was
      // my turn" and generation starts now — but only after 560 ms of real silence,
      // because Google's own guidance is that a client EOU tighter than ~500 ms cuts
      // people off mid-thought. Trading latency for interruption is a bad deal: the
      // caller repeating themselves costs more than the 200 ms saved.
      if (cfg.hybrid && cfg.vad !== 'ptt' && now - stats.silenceAt > 560) {
        sentStreamEnd = true;
        send({ realtimeInput: { audioStreamEnd: true } });
      }
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
 * them. So the picker plays the actual voice reading an actual line it would say on
 * this call, and the choice gets made by ear.
 *
 * It is the *Live* row that speaks, not a separate TTS model — one engine end to end.
 * A REST TTS row and the Live row are different models with different prosody, so an
 * audition through them is a promise the call cannot keep: people report "the sample
 * sounded nicer than the call", and that report is literally correct. Same socket,
 * same voice frame, same 24 kHz PCM, and the same Voice feel chain on the way to the
 * speakers, so what you hear in Settings is what the caller hears.
 *
 * Deliberately no style directive in the text: a Live session reads instructions as
 * content, so "say this warmly" comes back as the model saying the words "say this
 * warmly". Style belongs in the persona, where it already is.
 */
function pcmToWav(pcm, rate = OUT_RATE) {
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

let auditionWav = null;   // last rendered sample, offered as a file
let auditioning = false;

/** The sample is a real audio buffer; a file is what makes it shareable. */
function downloadAudition() {
  const btn = $('fAuditionSave');
  if (!auditionWav) {
    if (btn) btn.textContent = 'Nothing rendered yet — press Hear this voice first';
    return;
  }
  const name = $('fVoice') ? $('fVoice').value : 'voice';
  try {
    const url = URL.createObjectURL(new Blob([auditionWav], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `aryans-aicall-${String(name).toLowerCase()}-${OUT_RATE / 1000}k.wav`;
    a.click();
    // The object URL would otherwise live for the life of the page.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (btn) btn.textContent = 'Saved ✓ — press again for another copy';
  } catch (e) {
    // A browser or embed that refuses a programmatic download: say so, and leave the
    // button doing something the next time.
    if (btn) btn.textContent = 'This browser will not save a file from the page — play it instead';
    // The button right above already carries the remedy, so the note does not repeat it; the
    // browser's complaint goes in the log, where it can be read if "play it instead" is not
    // enough. One sentence, one remedy, per failure — the whole rule this pass is about.
    noteError('This browser refused to save the sample — it is still playing fine above.', e.message);
  }
}

/**
 * One throwaway Live session, no microphone: setup, one text turn, stream the audio
 * back as it arrives, close on the first of turnComplete / timeout / failure.
 */
async function audition() {
  if (auditioning) return;
  const btn = $('fAudition');
  const log = el.sheetLog;
  const name = ($('fVoice') && $('fVoice').value) || cfg.voice;
  const line = ((($('fSample') && $('fSample').value) || '').trim() || cfg.sample || DEFAULTS.sample)
    .slice(0, 240);
  const key = cfg.key || (($('fKey') && $('fKey').value) || '').trim();
  // Keysafe mode keeps the key out of browser storage, so the audition goes through the
  // relay too — otherwise voices could only be previewed in the weaker mode. A key typed
  // into the sheet but not yet saved still works: this is a preview, not a call.
  if (!cfg.keysafe && !key) {
    if (log) { log.hidden = false; log.textContent = 'Paste a key above first — it is needed to render a sample.'; }
    return;
  }
  auditioning = true;
  auditionWav = null;
  const saveBtn = $('fAuditionSave');
  if (saveBtn) saveBtn.hidden = true;
  btn.disabled = true;
  if (log) { log.hidden = false; log.textContent = `rendering "${name}" on ${shortModel(cfg.model)} (Live)…`; }

  // A separate setup from the call's: no mic, no tools, no persona. Asking for an
  // opening turn is the only input, so this cannot drift into a real session.
  const sample = liveSetup({
    model: cfg.model,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: name } } },
    },
    outputAudioTranscription: {},
  });
  let sock = null;
  let pcm = new Int16Array(0);
  let heard = '';
  let closed = false;
  const finish = (why) => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    const s = sock;
    // Detach before close, exactly as a hangup does: a deliberate close that reaches
    // the failure path would tell the user their key is broken because they previewed
    // a voice.
    if (s) { s.onclose = null; s.onerror = null; s.onmessage = null; try { s.close(); } catch {} }
    auditioning = false;
    btn.disabled = false;
    return why;
  };
  const deadline = setTimeout(() => {
    if (closed) return;
    finish('timeout');
    const got = pcm.length ? ` · ${(pcm.length / OUT_RATE).toFixed(1)}s of audio before it stopped` : '';
    if (log) log.textContent = `No audio from ${name} in 15s${got}. The row may be busy or retired — Test connection will say which.`;
  }, 15000);

  try {
    await ensureAudio(); // the tone chain is what we are auditioning, so it must exist
    sock = await openLiveSocket(key);
    // The socket is already open by the time we get it back, so the setup frame goes
    // now — and setup must be the first message on the wire, which is why it is not
    // left to an onopen that has already fired.
    sock.send(JSON.stringify(sample));
    sock.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.setupComplete) {
        // Text in, spoken audio out: the same turn shape the typed composer uses, so
        // this path is exercised on every call as well as every audition.
        sock.send(JSON.stringify({
          clientContent: { turns: [{ role: 'user', parts: [{ text: line }] }], turnComplete: true },
        }));
        return;
      }
      const sc = m.serverContent;
      if (sc?.modelTurn?.parts) {
        // 3.x rows put audio and transcript in ONE event; looping every part, rather
        // than taking the first, is what stops the caption going missing.
        for (const p of sc.modelTurn.parts) {
          const d = p?.inlineData?.data;
          if (d) {
            const raw = unbase64(d);
            const chunk = new Int16Array(raw.buffer, raw.byteOffset, (raw.byteLength / 2) | 0);
            const merged = new Int16Array(pcm.length + chunk.length);
            merged.set(pcm); merged.set(chunk, pcm.length);
            pcm = merged;
            // Streamed, so the tail arrives while you are already listening — and kept
            // off the call's meters and playback queue on purpose.
            playBuffer(chunk, { meter: false, track: false });
          } else if (p?.text) heard += p.text;
        }
      }
      if (sc?.outputTranscription?.text) heard = sc.outputTranscription.text;
      // A rejected setup is the most likely failure of all — a retired row, a voice name
      // this row does not know — and the row says exactly what it disliked. Reporting it
      // now beats fifteen seconds of spinner.
      if (m.setupError || m.error) {
        const msg = (m.setupError || m.error)?.message || JSON.stringify(m.setupError || m.error);
        finish('setupError');
        fail(`${msg} — the same row is used by calls, so fix it in the Model box`);
        return;
      }
      if (sc?.turnComplete) { finish('turnComplete'); report(); }
    };
    sock.onclose = () => {
      if (closed) return;
      finish('close');
      // Half a sample is still a sample: playing what arrived beats an error, because the
      // length of the line was never the point of the button.
      if (pcm.length) report();
      else fail('the socket closed before any audio came back');
    };
    sock.onerror = () => { if (!closed) { finish('error'); fail('the Live socket could not be opened from this page'); } };
  } catch (e) {
    finish('throw');
    fail(e.message);
  }

  function report() {
    if (!pcm.length) { fail('the model replied with no audio for this line'); return; }
    auditionWav = pcmToWav(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), OUT_RATE);
    const secs = (pcm.length / OUT_RATE).toFixed(1);
    if (log) {
      log.textContent = `${name} · ${VOICES[name] || '—'} · ${secs}s · ${(auditionWav.length / 1024) | 0} kB — heard through your Voice feel chain, same as a call`
        + (heard ? `\nhearing: “${heard}”` : '')
        + `\nThat was ${shortModel(cfg.model)} speaking. Change the row or the voice and press again.`;
    }
    if (saveBtn) saveBtn.hidden = false;
  }
  function fail(msg) {
    // Never throw the user into a dead button: say what failed and why, and what to press.
    if (log) log.textContent = `Audition failed: ${msg}`;
    noteError('The voice preview could not start. Nothing you changed is broken — the detail is folded below.', msg);
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

/** Schedule a buffer on the tone chain. `meter` keeps it out of the call's counters. */
function playBuffer(int16, { meter = true, track = true } = {}) {
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
  // An audition is not a turn of a call: counting it would inflate the very numbers
  // that tell you whether the call feels fast, and joining activeSrc would leave the
  // call stuck on "agent talking" for as long as a preview is in flight.
  if (meter) {
    stats.recv += buf.duration;
    el.sRecv.textContent = stats.recv.toFixed(1) + 's';
  }
  if (!track) return;
  activeSrc.push(s);
  s.onended = () => {
    activeSrc = activeSrc.filter((x) => x !== s);
    if (!activeSrc.length) {
      outBarOff();
      if (agentSpeaking) setAgentSpeaking(false);
      // The pause the server signalled mid-queue only becomes the truth once the
      // caller has heard the end of what was already queued.
      if (waitingForInput) { waitingForInput = false; showWaitingForInput(); }
    }
  };
}

function playPcm(int16) {
  playBuffer(int16);
}

const outBarOff = () => (el.outBar.style.width = '0%');

function flushPlayback() {
  waitingForInput = false; // a flushed queue must not fire a stale state change later
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

/**
 * The model stopped generating because it thinks you have more to say. Shown as "waiting
 * for you" and not as an answer or as plain "listening", because both of those make the
 * caller either answer nothing or start their sentence twice.
 */
/**
 * The server's own answer to "am I done talking to you?", from `interactionStatus`.
 * IN_PROGRESS means more output may still follow — background reasoning finishing after
 * the turn looked complete — and IDLE means the server has completed all processing.
 * It matters because the two states a caller cannot tell apart ("it is still thinking"
 * and "it is waiting for me") are the two that decide whether they start talking or
 * hang up. A row that never sends it leaves this false, which is the old behaviour.
 */
let serverBusy = false;
let busyWatchdog = null;
function setInteractionStatus(v) {
  const up = String(v || '').toUpperCase();
  if (!up) return;
  clearTimeout(busyWatchdog);
  serverBusy = up === 'IN_PROGRESS';
  if (serverBusy) {
    // Say it, rather than let the pill silently keep claiming "thinking" forever: a
    // model that thinks for 20 s is a fact about the row, not a dead line.
    if (!activeSrc.length && !muted) {
      setMode('still reasoning', 'thinking');
      el.say.textContent = 'Woh soch raha hai — rukiye, awaaz aayegi.';
    }
    busyWatchdog = setTimeout(() => {
      if (serverBusy) { serverBusy = false; stats.stalled = (stats.stalled || 0) + 1; }
    }, 20000);
  } else if (callState === 'thinking') {
    // IDLE while we are still showing 'thinking' means there is nothing more coming:
    // hand the floor over instead of leaving the caller talking into a 'thinking' orb.
    showWaitingForInput();
  }
}

let waitingForInput = false;
/**
 * That this turn's ending has already been explained, so the generic turn-end handler
 * must not repaint it. Both cases arrive on the same message as `turnComplete` and then
 * lose to it: `waitingForInput` / `NEED_MORE_INPUT` get "listening" written over
 * "waiting for you" a few milliseconds later, and a refusal gets folded back into an
 * ordinary end of turn. Same words to a casual reader, different instruction to the
 * caller — and in both cases the state that got clobbered is the one they needed.
 */
let holdPill = false;
function showWaitingForInput() {
  if (!settled) return;
  setAgentSpeaking(false);
  setMode('waiting for you', 'listening');
  el.say.textContent = 'Woh ruk gaye — aap boliye.';
  holdPill = true;
}

function setAgentSpeaking(on) {
  agentSpeaking = on;
  if (on) holdPill = false; // it answered — it is not waiting any more
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
  holdPill = false; // the caller spoke: the floor moved, whatever the pill said
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

/**
 * The setup frame, in one place, for both the call and the audition.
 *
 * Two rules the Live API enforces silently, so they are encoded here:
 *  - generation config lives under `setup.generationConfig`. Sent flat on `setup`,
 *    `speechConfig` is an unknown field: the call connects, the model speaks, and the
 *    voice you picked is dropped. The worst failure there is, because it looks applied.
 *  - anything a row may not know must be gated on the row. An unknown field is a
 *    rejected setup — a dead 1006, indistinguishable from a bad key — so the newer,
 *    richer fields (transcription biasing, resumption, always-answer) only go to rows
 *    that document them.
 */
/**
 * Which half of the setup frame a field belongs to.
 *
 * `BidiGenerateContentSetup` is one proto with two levels: the generation knobs go under
 * `generationConfig`, everything else sits flat on `setup`. Both the docs and the SDK's own
 * converters agree on this split, and getting it wrong is not a warning — the endpoint answers
 * with a 1007 close whose reason is `Unknown name "responseModalities" at 'setup': Cannot find
 * field.`, and the call never starts. This file shipped exactly that bug in `minimalSetup`,
 * which passed `responseModalities` flat: the frame that exists to *survive* a rejection was
 * itself the thing being rejected, so a session that degraded once could never connect again
 * for the rest of the page load.
 */
const GENERATION_FIELDS = new Set([
  'responseModalities', 'speechConfig', 'temperature', 'topP', 'topK', 'maxOutputTokens',
  'mediaResolution', 'seed', 'thinkingConfig', 'enableAffectiveDialog', 'translationConfig',
]);

/**
 * The other half of the split: what may sit flat on `setup` at all.
 *
 * Verified against the wire by reading the converter in google-genai 3.3.0
 * (`_LiveConnectConfig_to_mldev`), which is the list Google's own client emits — not against
 * a memory of the docs page, which is how the last attempt at this went wrong. A warning from
 * here is not a verdict: rows gain fields faster than this file learns them, so an unknown name
 * is logged and *still sent*, and the repair ladder is what actually reacts if the endpoint
 * disagrees. The point is that a field added by mistake shows up in ⚙ on the first call instead
 * of arriving as a dead socket blamed on the key.
 */
const SETUP_FIELDS = new Set([
  'model', 'systemInstruction', 'tools', 'safetySettings', 'realtimeInputConfig',
  'sessionResumption', 'labels', 'historyConfig', 'inputAudioTranscription',
  'outputAudioTranscription', 'proactivity', 'avatarConfig', 'explicitVadSignal',
  'contextWindowCompression', 'generationConfig',
]);

function auditSetup(setup) {
  const odd = Object.keys(setup).filter((k) => !SETUP_FIELDS.has(k));
  for (const k of Object.keys(setup.generationConfig || {})) {
    if (!GENERATION_FIELDS.has(k)) odd.push(`generationConfig.${k}`);
  }
  if (odd.length) {
    logLine(`[setup audit] ${odd.map((k) => `\`${k}\``).join(', ')} ${odd.length === 1 ? 'is' : 'are'} not in the field list this build knows about — sent anyway; if the call dies, that is the suspect`);
  }
  return odd;
}

/** Fields this row has refused, and the row they were refused by. */
let refused = new Set();
let refusedFor = '';
let fieldRepairs = 0;
const MAX_FIELD_REPAIRS = 3;
// A move is tried once per field. If a field is still refused after being nested where it
// belongs, escalating to dropping it is the only honest step left — and repeating the same
// repair would be a retry loop wearing a ladder's clothes.
const movedAway = new Set();

/** `Unknown name "X" at 'setup.generationConfig': Cannot find field.` → { field, path }. */
function unknownFieldOf(msg) {
  const m = /Unknown name "([A-Za-z_][\w.]*)"(?:\s+at '([\w.]*)')?/.exec(String(msg || ''));
  return m ? { field: m[1], path: m[2] || 'setup' } : null;
}

const refusalKey = (info) => `${info.path || 'setup'}.${info.field}`;

/**
 * Put every generation knob where the proto says it goes, whatever the caller wrote.
 *
 * Done on the way out, in one place, for both the call and the audition, so the rule cannot be
 * broken by a frame builder again. An existing value under `generationConfig` wins: a caller
 * that already nested `speechConfig` and also left a flat copy is stating a preference twice,
 * and the nested one is the one that reaches the API.
 */
function nestGenerationFields(setup) {
  for (const f of Object.keys(setup)) {
    if (f === 'generationConfig' || !GENERATION_FIELDS.has(f)) continue;
    // Created on the way past, not assumed: the whole reason this function exists is the
    // caller that put `responseModalities` flat with no generationConfig to put it in. Copy
    // only when the target is empty — a caller that states a thing twice means the nested one.
    const gen = (setup.generationConfig ||= {});
    if (gen[f] === undefined) gen[f] = setup[f];
    delete setup[f];
  }
  if (setup.generationConfig && Object.keys(setup.generationConfig).length === 0) {
    delete setup.generationConfig;
  }
  return setup;
}

/**
 * Drop what this row has already said it does not accept, provided it is still this row.
 *
 * The remembered key is the full path the server gave back — `setup.responseModalities`,
 * `setup.generationConfig.speechConfig`, `setup.outputAudioTranscription.wordTimestamp` — so
 * walk it instead of special-casing the two levels that happened to be handy. A refusal at any
 * depth is otherwise remembered but re-sent forever, and the ladder's last resort becomes
 * "stop trying", which is exactly where a user gives up on a voice app.
 */
function stripRefused(setup) {
  if (refusedFor !== cfg.model || refused.size === 0) return setup;
  for (const key of refused) {
    const segs = key.split('.');
    if (segs.shift() !== 'setup' || segs.length === 0) continue;
    const leaf = segs.pop();
    let node = setup;
    for (const seg of segs) node = node && typeof node === 'object' ? node[seg] : null;
    if (node && typeof node === 'object') delete node[leaf];
  }
  return setup;
}

/**
 * One repair step for a named field, and the sentence that says what was done.
 *
 * The sentence matters as much as the fix: "voice and VAD fall back to defaults" is what the
 * old code said when all it really needed to do was move one field, and it taught the user that
 * their settings get thrown away whenever Google renames something.
 */
function repairField(info, raw) {
  if (refusedFor !== cfg.model) { refusedFor = cfg.model; refused.clear(); fieldRepairs = 0; movedAway.clear(); }
  const key = refusalKey(info);
  let said;
  if (info.path === 'setup' && GENERATION_FIELDS.has(info.field) && !movedAway.has(info.field)) {
    movedAway.add(info.field);
    said = `"${info.field}" belongs under generationConfig, not flat on setup. Moved it there — nothing you set in ⚙ is being dropped.`;
  } else {
    refused.add(key);
    if (info.path === 'setup' && GENERATION_FIELDS.has(info.field)) {
      // The move was tried and the field was refused at `setup` again, which means the two
      // locations are being read as one by something that disagrees with us. Stripping only
      // the path named in the error would produce a byte-identical next frame — a retry loop
      // that cannot terminate. Retire the field everywhere it could live.
      refused.add(`setup.generationConfig.${info.field}`);
    }
    said = `This row does not accept "${info.field}" at ${info.path}. That one field is off for this row; voice, VAD and captions stay exactly as you set them.`;
  }
  logLine(`[setup repair] ${key} — ${raw || ''}`.trimEnd());
  return said;
}

const liveSetup = (setup) => {
  const frame = stripRefused(nestGenerationFields(setup));
  auditSetup(frame);
  return { setup: frame };
};

function fullSetup() {
  const capableRow = capable(cfg.model);
  const setup = {
      model: cfg.model,
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
  if (capableRow) {
    // Hinglish is the hardest thing this call asks of a recogniser: Roman-script Hindi
    // words mixed into English, plus the app and money vocabulary of an Indian phone
    // call. Biasing is free, adds no latency, and is not a guess at the sentence —
    // it only lifts the terms the ASR was already close to.
    setup.inputAudioTranscription.customVocabulary = CUSTOM_VOCAB;
    // Captions with positions. The field is `wordTimestamp` in AudioTranscriptionConfig
    // — `enableWordTimestamps` reads like it and is not — and an unknown name here
    // rejects the whole setup, which is a dead socket blamed on the key. Worth the risk
    // because a transcript is the artifact of a call: "2:14 pe bola tha" is checkable,
    // "woh bola tha" is not.
    setup.outputAudioTranscription.wordTimestamp = true;
    setup.inputAudioTranscription.wordTimestamp = true;
    // Do NOT "improve" this later by adding `mode: 'SMART'` (disfluency removal, tidier
    // Hinglish): SMART and timestamps are mutually exclusive in the API, and a setup that
    // asks for both is rejected outright — a dead socket, blamed on the key.
    // Ask for a resumption handle so a dropped line or the session cap costs the
    // caller nothing: the next socket reattaches to this conversation instead of
    // starting one where the caller has to say "maine kaha tha" all over again.
    setup.sessionResumption = sessionHandle ? { handle: sessionHandle } : {};
  }
  if (cfg.caps !== 'lean' && is25Row(cfg.model)) {
    // Proactivity lets a model decide some input does not deserve a reply. Wrong
    // default for a phone agent: the caller cannot tell "ignored" from "dead line", and
    // unlike the newer fields this one is only on the 2.5 rows, where it is supported.
    setup.proactivity = { proactiveAudio: false };
  }
  return liveSetup(setup);
}
// Nested on purpose, and not only because liveSetup would fix it: this is the frame that has to
// work when everything fancier was refused, so it is written in the shape the endpoint actually
// takes rather than the shape that used to. No voiceConfig, no transcription, no tools — that is
// what "minimal" means — but `responseModalities` is not optional, and neither is its parent.
const minimalSetup = () => liveSetup({
  model: cfg.model,
  generationConfig: { responseModalities: ['AUDIO'] },
});

/**
 * One throwaway Live socket, no mic: used by the voice audition so the sample is
 * produced by the same row and the same frame as the call. Resolves once the socket is
 * open; the caller owns setup and teardown.
 */
function openLiveSocket(key) {
  return new Promise((resolve, reject) => {
    let sock;
    try {
      sock = cfg.keysafe ? new WebSocket(RELAY) : new WebSocket(`${DIRECT}?key=${encodeURIComponent(key || '')}`);
    } catch (e) { reject(e); return; }
    const t = setTimeout(() => {
      detachSocket(sock);
      reject(new Error('the Live socket never opened within 8s — a blocked wss:// or a busy network looks exactly like this'));
    }, 8000);
    sock.onopen = () => { clearTimeout(t); resolve(sock); };
    // A close before `open` is still reported: on the stubbed/embedded paths Chrome can
    // fail the upgrade without ever firing `error`.
    sock.onerror = () => { clearTimeout(t); reject(new Error('the Live socket was refused before it opened')); };
    sock.onclose = (e) => {
      clearTimeout(t);
      reject(new Error(`the Live socket closed before it opened${e?.code ? ` (code ${e.code})` : ''}`));
    };
  });
}

/**
 * Open the call socket and wire the handlers. Used for the first connect and for the
 * mid-call rotation that dodges the session cap, so the two cannot drift apart.
 */
function openCallSocket(reason) {
  const url = cfg.keysafe ? RELAY : `${DIRECT}?key=${encodeURIComponent(cfg.key)}`;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    // A thrown constructor means the URL itself is unusable — a config bug, not a
    // Google problem, and it used to escape into an unhandled rejection while the chip
    // stayed on "connecting" forever.
    setMode('error', 'error');
    el.say.textContent = 'Connect failed.';
    noteError('Could not open the socket at all — the address this page is calling is not usable.', e.message);
    return false;
  }
  armHandshake();
  ws.onopen = () => send(triedMinimal ? minimalSetup() : fullSetup());
  ws.onmessage = onMessage;
  ws.onclose = (e) => {
    if (rotating) return; // we closed this one on purpose, mid-call
    if (!settled) {
      failHandshake(`socket closed${e.code ? ` with code ${e.code}` : ''}${e.reason ? `: ${e.reason}` : ''}`);
      return; // failHandshake owns the teardown
    }
    teardown();
  };
  ws.onerror = () => {
    if (!settled) failHandshake('socket error before setup');
  };
  if (reason) setMode('reconnecting', 'connecting');
  return true;
}

/** A socket whose handlers must not outlive it, and a close that must not look like a failure. */
function detachSocket(sock) {
  if (!sock) return;
  sock.onclose = null;
  sock.onerror = null;
  sock.onmessage = null;
  sock.onopen = null;
  try { sock.close(); } catch {}
}

let rotating = false;
let goAwayTimer = null;
let sessionHandle = '';

/**
 * Google ends a Live session on a schedule, not on request: `goAway` says when, and
 * the audio-only cap is around 15 minutes. A call that dies at 15:00 with no warning is
 * the single most annoying thing a hosted voice agent does, so the line is refreshed
 * before the server does it for us — the mic, the audio graph and the transcript all
 * stay, and the new socket resumes the conversation from the handle.
 */
function rotate(reason) {
  if (rotating || !ws || !settled) return;
  rotating = true;
  clearTimeout(goAwayTimer);
  clearTimeout(handshakeTimer);
  // `sessionResumption` is not offered on every row. Without a handle the audio carries
  // on but the model starts blank, and a caller who is not told will repeat themselves
  // and assume the line broke instead.
  note((reason || 'session cap approaching — refreshing the line, you do not need to do anything')
    + (sessionHandle ? '' : ' (this row cannot resume — the agent will not remember the earlier part of the call)'),
    'sys');
  const sock = ws;
  ws = null;
  detachSocket(sock);
  // The new socket has to earn its own setupComplete. Left true from the previous one,
  // a failed refresh would fall straight through to teardown() — a silently dead call
  // instead of a sentence about why, which is the exact failure this whole ladder
  // exists to prevent.
  settled = false;
  openCallSocket('rotate');
  // If the fresh socket fails, the ladder takes over from here; the caller is still
  // on the old audio graph either way, so nothing about the mic is re-requested.
  setTimeout(() => { rotating = false; }, 2500);
}

async function connect() {
  if (ws) return;
  if (!cfg.key) {
    openSheet();
    note('Gemini API key chahiye pehle — free hai, card nahi.', 'err');
    return;
  }
  // The context is built first, on the tap, before the mic: build it after the gesture
  // has expired and iOS/Safari leaves it permanently suspended — silent audio, no
  // error, nothing in the console. So the ordering here is a correctness property.
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
  // One owner for the socket and its handshake, shared with the mid-call line refresh.
  openCallSocket();
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
    clearTimeout(handshakeTimer);
    handshakeTries = 0;
    // A connect that worked is the only evidence worth resetting on: the budget is per
    // run of failures, not per page load, or a mid-call rotation that tripped one repair
    // would leave the next hour of calls with no ladder at all. `refused` deliberately
    // survives — that row was seen to reject the field, and re-offering it every call
    // would re-earn the same 1007 every time.
    fieldRepairs = 0;
    if (pendingModelFix) {
      // The row that actually connected is worth keeping; the one in the file is a
      // guess about what Google shipped when it was written.
      const fixed = pendingModelFix;
      pendingModelFix = '';
      save({ ...cfg, model: fixed });
      note(`Connected on ${shortModel(fixed)} — saved as your model row.`, 'sys');
    }
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
    // The line has a hard end; say nothing about it, and refresh it while idle.
    armSessionCap();
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
    if (interimNode) {
      // The provisional caption and its final version are the same sentence, so the
      // node is written rather than followed by a second one. A transcript that shows
      // "mera order" twice is a transcript nobody trusts, and this one is evidence.
      const tx = interimNode.querySelector('.tx');
      tx.textContent = heardText || tx.textContent;
      const done = interimNode;
      interimNode = null;
      done.classList.remove('live');
      stampTurn(done, sc.inputTranscription.startOffset);
      ububble = null;
    } else {
      appendTurn('user', heardText);
      stampTurn(ububble, sc.inputTranscription.startOffset);
    }
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
  if (sc?.outputTranscription?.text) {
    appendTurn('agent', sc.outputTranscription.text);
    stampTurn(abubble, sc.outputTranscription.startOffset);
  }
  // Partial input transcription arrives while the caller is still talking. It is the
  // only way to answer "kya suna tumne?" before the turn ends, and on a phone line it
  // is worth more than the final transcript: a caller who sees their own words appear
  // stops repeating themselves. Overwritten, never appended, and dropped on the final.
  if (sc?.interimInputTranscription?.text) showInterim(sc.interimInputTranscription.text);
  // The server says it interrupted the model: that is the authoritative signal to stop
  // playing, ahead of anything the local energy VAD inferred.
  if (sc?.interrupted) {
    flushPlayback();
    setAgentSpeaking(false);
    if (callState === 'speaking') setMode('interrupted by you', 'interrupted');
  }
  // A reason attached to the end of a turn is worth more than the end itself:
  // NEED_MORE_INPUT is "I stopped so you can continue", RESPONSE_REJECTED and
  // MALFORMED_FUNCTION_CALL are "nothing is coming, and here is why". Without them a
  // refusal is indistinguishable from a slow answer, which is how people restart a
  // call that was working.
  if (sc?.turnCompleteReason && sc.turnCompleteReason !== 'TURN_COMPLETE_REASON_UNSPECIFIED') {
    if (/NEED_MORE_INPUT/.test(sc.turnCompleteReason)) {
      if (activeSrc.length) waitingForInput = true; else showWaitingForInput();
    } else if (/REJECTED|PROHIBITED|MALFORMED/.test(sc.turnCompleteReason)) {
      dropInterim();
      setAgentSpeaking(false);
      setMode('nothing to say', 'error');
      holdPill = true; // the turn ends in this same message and would repaint it
      el.say.textContent = 'Is baar jawab nahi — Google ne is line ko rok diya.';
      note(`the model ended the turn without answering (${sc.turnCompleteReason}) — try rephrasing, or ask it a narrower question`, 'err');
    }
  }
  if (sc?.interactionStatus) setInteractionStatus(sc.interactionStatus);
  if (sc?.turnComplete) {
    // A turn can "complete" while the server is still reasoning in the background, and
    // the turn-end is not the truth about that — interactionStatus is. Held here means
    // the orb keeps saying *thinking* instead of inviting the caller over the top of an
    // answer that is on its way.
    if (serverBusy) { setMode('still reasoning', 'thinking'); }
    abubble = null;
    dropInterim();
    if (!activeSrc.length && !serverBusy && !holdPill) setAgentSpeaking(false);
    // The turn is over; the endpoint clock restarts, so a long pause while the agent
    // waits does not read as "the line died" and then fire a stale audioStreamEnd.
    stats.turnEndAt = performance.now();
  }
  // "I'm done speaking" and "you have the floor" are different states, and only the
  // model knows which one this is. Showing *listening* while it is still expecting the
  // caller to continue is how people start twice and talk over the reply.
  if (sc?.waitingForInput) {
    endThinking();
    // Do NOT flush here: generation runs ahead of playback, so the caller may still be
    // mid-sentence as far as their ears are concerned. Flip to "waiting" when the local
    // queue drains, which is the moment it is actually true.
    if (activeSrc.length) waitingForInput = true;
    else showWaitingForInput();
  }

  if (m.toolCall) handleToolCall(m.toolCall);
  // A cancelled tool call must not be answered: the server has already dropped it, and
  // a toolResponse for an unknown id is a protocol error that kills the socket.
  if (m.toolCallCancellation?.ids?.length) {
    const gone = new Set(m.toolCallCancellation.ids);
    pendingToolIds = (pendingToolIds || []).filter((id) => !gone.has(id));
    note(`tool call cancelled by the server (${gone.size})`, 'sys');
  }
  // The server's own warning that it is about to hang up. `timeLeft` is a Duration
  // (either "60s" or {seconds}), older rows used timeRemainingAfterMs — read all three,
  // because a missed goAway is a dead call in the middle of a sentence.
  if (m.goAway) {
    const g = m.goAway;
    const secs = typeof g.timeLeft === 'string'
      ? parseFloat(g.timeLeft)
      : g.timeLeft?.seconds != null
        ? Number(g.timeLeft.seconds) + (g.timeLeft.nanos || 0) / 1e9
        : typeof g.timeRemainingAfterMs === 'number' ? g.timeRemainingAfterMs / 1000 : 0;
    const inMs = Math.max(400, (secs - 5) * 1000);
    note(`the line refreshes in ${Math.max(1, Math.round(secs))}s — nothing you need to do`, 'sys');
    clearTimeout(goAwayTimer);
    goAwayTimer = setTimeout(() => rotate('goAway reached — reopening the line with the same session'), inMs);
  }
  if (m.sessionResumptionUpdate) {
    const u = m.sessionResumptionUpdate;
    const tok = u.newHandle || u.token || u.handle || '';
    if (tok && u.resumable !== false) {
      sessionHandle = tok;
    } else if (u.resumable === false) {
      sessionHandle = '';
    }
  }
  if (m.usageMetadata?.totalTokenCount != null) {
    // `totalTokenCount` is the session's running total, not a delta — adding it up
    // would double-count everything and send a free-tier user hunting a quota wall that
    // is not there. High-water mark, and never down.
    stats.tokens = Math.max(stats.tokens || 0, m.usageMetadata.totalTokenCount);
    if (el.sTokens) el.sTokens.textContent = stats.tokens >= 10000 ? (stats.tokens / 1000).toFixed(0) + 'k' : String(stats.tokens);
  }
  if (m.setupError || m.error) reportError(m.setupError || m.error);
  if (m.relayError) noteError(`This page's own relay reported a problem: ${m.relayError.reason || m.relayError.code}`, JSON.stringify(m.relayError));
}

function reportError(err) {
  const msg = err?.message || JSON.stringify(err);
  // Same repair ladder as the close-code path, because the same refusal arrives either way —
  // sometimes as a setupError message on a live socket, sometimes as a 1007 that kills it.
  // One ladder, two entrances, or the fix works in one case and not the other.
  const bad = unknownFieldOf(msg);
  if (bad && fieldRepairs < MAX_FIELD_REPAIRS && !refused.has(refusalKey(bad))) {
    fieldRepairs++;
    note(`Setup refused — ${repairField(bad, msg)}`, 'sys');
    const k = cfg.key;
    teardown();
    cfg.key = k;
    setTimeout(start, 500);
    return;
  }
  if (!triedMinimal && /speechConfig|realtimeInputConfig|transcription|Unknown name|Invalid JSON/i.test(msg)) {
    // Field-name churn between model generations, with no field named to aim at. Degrade to
    // the one shape every Live model accepts rather than dying on a config we cannot verify.
    triedMinimal = true;
    note('The endpoint refused the richer config fields, so the call is running on the plain one. Voice and pause-detection go to that row’s defaults.', 'sys');
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
  // Each branch says the thing a caller can act on, and only then keeps the raw text folded
  // under it. The previous version put `msg` in the transcript AND the sheet log, which is how
  // one protobuf complaint ended up on screen twice.
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    noteError('Free-tier quota hit for today. That is the ₹0 ceiling — wait for the day to roll, or use a second project.', msg);
  } else if (/NOT_FOUND|404|no such model|unsupported/i.test(msg)) {
    noteError(`Model row not available to this key: "${shortModel(cfg.model)}". The free-tier list moves — pick one of the rows the picker offers.`, msg);
    // Say "go change the row" and then take them there: the row box is the one field that
    // fixes this, and hunting for it mid-failure is how people give up and reload.
    openSheet('model');
  } else if (/401|UNAUTHENTICATED|API key not valid/i.test(msg)) {
    noteError('Google does not accept that key. Check it was pasted whole — no space, no quote, and it has to be a *Gemini API* key, not a Cloud one.', msg);
    openSheet('key');
  } else {
    noteError(humanError(msg), msg);
  }
  // The headline under the orb is the only part a caller reads twice. It stays one clause long,
  // and it never carries the wire text: no caller has ever debugged a phone call by reading a
  // field path off the thing they are trying to have a conversation on.
  el.say.textContent = 'Setup fail hua — \u2699 khol ke dekho.';
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

let pendingToolIds = [];
async function handleToolCall(call) {
  const responses = [];
  pendingToolIds = (pendingToolIds || []).concat((call.functionCalls || []).map((f) => f.id));
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
  if (responses.length) {
    const answered = new Set(responses.map((r) => r.id));
    pendingToolIds = pendingToolIds.filter((id) => !answered.has(id));
    send({ toolResponse: { functionResponses: responses } });
  }
}

const shortModel = (m) => String(m || '').replace(/^models\//, '');
const qualify = (m) => (String(m || '').startsWith('models/') ? m : `models/${m}`);

/**
 * Ask the key which Live rows exist, rather than guessing from a list baked into this
 * file. Preview model rows get retired and renamed on a schedule, and from the socket's
 * side a retired row is indistinguishable from a bad key — both are a dead 1006.
 */
async function listLiveModels() {
  // Keysafe mode holds the key on the server, so discovery goes through it too; a
  // picker that only works in the weaker mode is not a picker.
  const r = cfg.keysafe
    ? await fetch(`${location.origin}/${MODELS_PATH}`)
    : await fetch(`${API_ROOT}/models?pageSize=200&key=${encodeURIComponent(cfg.key)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status });
  const rows = Array.isArray(j.models) ? j.models : [];
  // `/live/` alone is not enough: `gemini-2.5-flash-native-audio-preview-*` is a Live
  // row whose name never says so, and a probe that does not know it will tell you your
  // saved row "is not visible to this key" — a wrong diagnosis aimed at your key.
  const live = rows
    .map((m) => m.name)
    .filter((n) => typeof n === 'string' && /live|native-audio/i.test(n));
  // Rank, do not just collect. Two rules, in order:
  //   1. newest major wins — a 3.x row speaks natively, handles multi-part events and
  //      has the better Hindi/English code-mixing, which is the whole point here;
  //   2. inside a generation, a `native-audio` row beats one without it, because a Live
  //      row that cannot speak connects and then plays nothing — and "connected but
  //      silent" reads as an audio bug, never as a model-choice bug.
  // Both the picker and the retry ladder read from this one order.
  const rank = (n) => {
    const three = /3\.(\d+)/.exec(n);
    if (three) return 10 + Number(three[1]);
    if (/2\.5/.test(n)) return /native-audio/i.test(n) ? 5 : 1;
    return 0;
  };
  return live.sort((a, b) => rank(b) - rank(a));
}

/** Refresh the picker, validate the current choice, and return what it found. */
async function refreshModels(quiet = false) {
  if (!cfg.key && !cfg.keysafe) return null;
  let live;
  try {
    live = await listLiveModels();
  } catch (e) {
    const bad = e.status === 400 || e.status === 401 || e.status === 403;
    const msg = bad
      ? `Google refused this key (${e.status}): ${e.message}`
      : `The API could not be reached to check (${e.message}). A browser that cannot reach the model list cannot reach the call either — that is usually the sandbox/proxy, not your key.`;
    if (!quiet) note(msg, 'err');
    const hint = $('modelHint');
    if (hint) { hint.textContent = msg; hint.dataset.bad = '1'; }
    return { error: msg, live: [], ok: false, best: '' };
  }
  // The picker is a convenience; the validation below it is what prevents a failed
  // call. Build the whole list, then write it once: a save-time refresh and a
  // connect-failure refresh running at the same moment would otherwise clear each
  // other half-done. And a DOM write must never take the diagnosis down with it.
  try {
    const dl = $('modelList');
    if (dl) {
      const opts = live.map((n) => {
        const o = document.createElement('option');
        o.value = n;
        return o;
      });
      if (dl.replaceChildren) dl.replaceChildren(...opts);
      else for (const o of opts) dl.appendChild(o);
    }
  } catch {}
  const cur = qualify(cfg.model);
  const ok = !live.length || live.includes(cur);
  const best = live[0] || ''; // already ranked by listLiveModels
  const hint = $('modelHint');
  if (hint) {
    hint.textContent = !live.length
      ? 'This key sees no Live rows at all — free-tier rows move; another key or tomorrow usually fixes it.'
      : ok
        ? `${live.length} Live rows on this key, including ${shortModel(cur)}.`
        : `${shortModel(cur)} is not visible to this key. It will fail to connect. Try ${shortModel(best)}.`;
    hint.dataset.bad = ok ? '' : '1';
  }
  return { live, ok, best: best ? qualify(best) : '' };
}

let pendingModelFix = '';

/** The socket died or never answered: name why, then change exactly one thing. */
let handshakeTimer = null;
let diagOnce = false;
let handshakeTries = 0;

function armHandshake() {
  clearTimeout(handshakeTimer);
  diagOnce = false;
  handshakeTimer = setTimeout(() => {
    if (!settled) failHandshake(`no setupComplete within ${HANDSHAKE_MS / 1000}s`);
  }, HANDSHAKE_MS);
}

async function failHandshake(tag) {
  if (diagOnce) return; // error and close both fire for one failure; diagnose once
  diagOnce = true;
  clearTimeout(handshakeTimer);
  // A close reason that names a field is the server telling you exactly what it disliked, and
  // it proves the request reached Google — which is more than the network could do. So repair
  // that one field and go again, rather than probing the model list (true, useless: "the row is
  // fine") and then throwing away the whole config for the sake of one name.
  const bad = unknownFieldOf(tag);
  if (bad && fieldRepairs < MAX_FIELD_REPAIRS && !refused.has(refusalKey(bad))) {
    fieldRepairs++;
    setMode('connecting', 'connecting');
    el.say.textContent = 'Fixing the setup frame…';
    note(`Setup frame refused by the endpoint — ${repairField(bad, tag)}`, 'sys');
    teardown();
    setTimeout(start, 400);
    return;
  }
  setMode('connecting', 'connecting');
  el.say.textContent = 'Not connected — checking what your key can see…';
  const info = await refreshModels(true);
  let why = `Could not connect (${tag}).`;
  let one = '';
  let swapped = false;
  if (info?.error) {
    why = info.error;
  } else if (info && !info.ok && info.best && info.best !== qualify(cfg.model)) {
    why += ` "${shortModel(cfg.model)}" is not a row this key can see.`;
    one = `Retrying with "${shortModel(info.best)}".`;
    pendingModelFix = info.best;
    cfg.model = info.best;
    swapped = true;
  } else if (info) {
    // Two different failures look identical from here and are not: silence (nothing came back,
    // which is what a blocked socket looks like) and an answer we did not like (which no proxy
    // can produce — it got through). Saying "or a proxy, or the frame" covers both and fixes
    // neither, so pick by what actually arrived.
    why += /no setupComplete|never opened|closed before it opened/i.test(tag)
      ? ' Nothing came back at all, which is a blocked wss://: a corporate proxy, an extension, or an embedder without the right policy.'
      : ' The row is fine and the endpoint answered, so it is the setup frame it refused. Nothing about your network is implicated.';
    one = fieldRepairs >= MAX_FIELD_REPAIRS
      ? 'Retrying with the minimal setup frame — voice and VAD fall back to defaults, and everything else about this call still works.'
      : `Repairing one field at a time first (${fieldRepairs}/${MAX_FIELD_REPAIRS} used), so the voice you picked survives.`;
  } else {
    why += ' Nothing to probe from here: no key on this page and no server route.';
    one = 'Paste a key in Settings, then Start again.';
  }
  if (handshakeTries >= 2) {
    // The previous attempt already printed this reason, verbatim. Repeating a four-sentence
    // paragraph in a second colour is not emphasis, it is the transcript turning into a log
    // dump — which is what the screenshot of this app looked like. One line here, pointing at
    // the thing above it and at the sheet that holds the raw response.
    note('Stopped retrying after 2 attempts — the reason is the line just above. The raw response is in ⚙ → the log at the bottom.', 'err');
    handshakeTries = 0;
    fieldRepairs = 0;
    teardown();
    return;
  }
  handshakeTries++;
  // Vary one thing per try, so a success means something: the model row when the row is
  // what is missing, otherwise the frame. Decided now, in a local, because teardown()
  // clears triedMinimal and reading the flag after it would always say "full frame".
  const useMinimal = !swapped;
  triedMinimal = useMinimal;
  noteError(`${why}${one ? ' ' + one : ''}`, tag, 'sys');
  teardown();
  // Set again *after* teardown, which resets it on purpose so a manual Start gets a
  // fresh full attempt. Without this the retry changes two things at once and a
  // success tells you nothing about which fix worked.
  if (useMinimal) triedMinimal = true;
  setTimeout(start, 400);
}

function teardown() {
  clearTimeout(handshakeTimer);
  dropInterim(); // a caption left blinking "live" after a hangup is claiming a state that ended
  clearTimeout(sessionTimer);
  clearTimeout(goAwayTimer);
  rotating = false;
  // Both are turn-scoped claims about the model, not facts about the line: kept across a
  // hangup, the next call starts out refusing to repaint its own state.
  holdPill = false;
  serverBusy = false;
  clearTimeout(busyWatchdog);
  // A hangup ends the conversation; the next Start must not try to resume it. That
  // would be a genuinely wrong thing to do to a person who called back about something
  // else, and the API would accept it silently.
  sessionHandle = '';
  kickedOff = false;
  micBlocked = false; // a new call earns a new greeting
  flushPlayback();
  closeMic();
  // Detach before closing. Two reasons, both real: (1) a deliberate close must not be
  // diagnosed as a connection failure — hanging up while the handshake is still pending
  // used to fire onclose -> failHandshake -> teardown -> close() recursion, and would
  // reopen a call the user just cancelled; (2) the handlers must not outlive the socket
  // they were written for.
  const sock = ws;
  ws = null;
  if (sock) {
    sock.onclose = null;
    sock.onerror = null;
    sock.onmessage = null;
    sock.onopen = null;
    try { sock.close(); } catch {}
  }
  settled = false;
  triedMinimal = false;
  agentSpeaking = false;
  // The AudioContext is a *page* resource, not a per-call one. Closing it here used to
  // look tidy and was not: Chrome caps live contexts per page (~6) and then refuses new
  // ones silently, so the seventh call of a session would have no output graph at all —
  // a "TTS stopped working" bug that only shows up after an hour of use. Reuse the
  // context, tear down only this call's graph, and stay ready for the next one.
  try { el.outGain?.disconnect(); } catch {}
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

/*
 * The sheet was one long scroll in which the two fields that decide whether a call works
 * at all — the key and the row — sat underneath earcon preferences. Ten panels, one topic
 * each, in the order you would actually fill them in, and the current one is in the URL:
 * when the diagnosis says "fix it in the Model box", that sentence can be a link, and a
 * person on a phone can land on the one box they need instead of hunting for it.
 *
 * replaceState, not pushState. A dialog that the Back button walks through, panel by
 * panel, is a dialog you cannot leave: one press of the phone's back key should end the
 * detour, not step back to 'Key'. So the hash says *where you are*, and Esc closes.
 */
const PANELS = ['key', 'model', 'voice', 'audition', 'turns', 'session', 'words', 'comfort', 'quality', 'phone'];
const PANEL_NAMES = {
  key: 'Key', model: 'Model row', voice: 'Voice', audition: 'Hear it', turns: 'Turns',
  session: 'Session frame', words: 'Its words', comfort: 'Comfort', quality: 'Quality',
  phone: 'Phone call',
};
/** Where focus lands in each panel — a panel with no field still has to hold the focus. */
const PANEL_FOCUS = {
  key: 'fKey', model: 'fModel', voice: 'fVoice', audition: 'fAudition', turns: 'fVad',
  session: 'fCaps', words: 'fGreet', comfort: 'fMotion', quality: 'statsReset',
  phone: 'sheetClose',
};
let panel = 'key';
const panelFromHash = () => {
  const m = /setup-([a-z]+)/.exec((typeof location !== 'undefined' && location.hash) || '');
  return m && PANELS.includes(m[1]) ? m[1] : '';
};
const writeHash = () => {
  const want = '#setup-' + panel;
  try {
    if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', want);
    else if (typeof location !== 'undefined') location.hash = want;
  } catch {}
};
const clearHash = () => {
  try {
    if (typeof history !== 'undefined' && history.replaceState) {
      history.replaceState(null, '', location.pathname + location.search);
    } else if (typeof location !== 'undefined') location.hash = '';
  } catch {}
};
const showPanel = (name, opts = {}) => {
  if (!PANELS.includes(name)) return false;
  const moving = name !== panel;
  panel = name;
  for (const p of PANELS) {
    const sec = $('p-' + p), tab = $('t-' + p);
    if (sec) sec.hidden = p !== name;
    // 'false', not removal: aria-current="" on ten tabs reads as "all of them are here".
    if (tab) tab.setAttribute('aria-current', p === name ? 'true' : 'false');
  }
  const title = $('sheetTitle');
  if (title) title.textContent = `Setup · ${PANEL_NAMES[name]}`;
  const prev = $('panelPrev'), next = $('panelNext');
  const i = PANELS.indexOf(name);
  // Disabled rather than hidden or wrapped: a stepper that loops tells you nothing about
  // where you are, and one that vanishes looks like a bug in the page.
  if (prev) prev.disabled = i === 0;
  if (next) next.disabled = i === PANELS.length - 1;
  writeHash();
  if (opts.focus !== false && (moving || opts.force)) {
    const target = $(PANEL_FOCUS[name]);
    if (target && target.focus) setTimeout(() => target.focus(), 30);
  }
  return true;
};
const stepPanel = (dir) => {
  const i = PANELS.indexOf(panel) + dir;
  if (i >= 0 && i < PANELS.length) showPanel(PANELS[i]);
};
for (const p of PANELS) {
  const b = $('t-' + p);
  if (b) b.addEventListener('click', () => showPanel(p, { focus: false }));
}
$('panelNext').addEventListener('click', () => stepPanel(1));
$('panelPrev').addEventListener('click', () => stepPanel(-1));
// Left and right walk the panels — but only away from a field, or the arrow keys stop
// being usable in a select and in the persona box.
document.addEventListener('keydown', (e) => {
  if (el.sheet.hidden) return;
  const tag = ((e.target && e.target.tagName) || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.code === 'ArrowRight') stepPanel(1);
  else if (e.code === 'ArrowLeft') stepPanel(-1);
});
// A pasted #setup-model is an instruction from someone who already knows what you need to
// change. Follow it, including while the sheet is open on another panel.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', () => {
    const name = panelFromHash();
    if (name) { if (el.sheet.hidden) openSheet(); else showPanel(name, { focus: false }); }
    else if (!el.sheet.hidden) closeSheet();
  });
}

// settings sheet. `wanted` is the panel a caller knows it needs — a retired row opens on
// Model, not on the top of the sheet — and an explicit #setup-* hash outranks it, because
// that is the person's own choice over the app's guess.
const openSheet = (wanted) => {
  $('fKey').value = cfg.key;
  $('fModel').value = cfg.model;
  $('fVoice').value = cfg.voice;
  $('fVad').value = cfg.vad;
  $('fHybrid').checked = cfg.hybrid !== false;
  $('fCaps').value = cfg.caps || 'auto';
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
  setBackgroundInert(true);
  $('gearBtn').setAttribute('aria-expanded', 'true');
  // Move focus into the dialog, then hand it back on close — into the panel that was
  // asked for, which is the field the person came here to change.
  showPanel(panelFromHash() || wanted || panel, { force: true });
};
// ── keeping the keyboard inside the dialog ─────────────────────────────────
// `aria-modal` tells a screen reader to ignore the page behind the sheet. It does nothing to
// Tab: nine presses from the first control land you in a composer button that is invisible,
// focused, and still able to start a call. `inert` is the real fix and it is one line per
// element — it removes the whole subtree from tab order, from clicking, and from the
// accessibility tree at once, which a hand-rolled keydown handler only manages for Tab.
//
// It is applied to the sheet's siblings rather than to a wrapper, because there is no wrapper:
// the page's header, main and footer are body children, and putting `inert` on `body` while the
// dialog lives inside it would inert the dialog too.
const setBackgroundInert = (on) => {
  const kids = (typeof document !== 'undefined' && document.body && document.body.children) || [];
  for (const node of kids) {
    if (!node || node === el.sheet) continue;
    const tag = ((node.tagName || '') + '').toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;   // never focusable; nothing to take away
    node.inert = on;
  }
};
// And a guard for the browsers that do not have it, where `inert` above is a property assignment
// on a DOM node that nothing reads. Rather than ordering every focusable control in the sheet —
// a list that goes stale the day a button is added, and which the hidden panels make longer
// still — this watches for focus that has already left and pulls it back to the field the
// current panel is about. It is a correction, not a ring: it cannot get the direction wrong,
// because it never tries to predict the order.
document.addEventListener('focusin', (e) => {
  if (el.sheet.hidden) return;
  const t = e.target;
  if (!t || !el.sheet.contains || el.sheet.contains(t)) return;
  const back = $(PANEL_FOCUS[panel]) || $('sheetClose');
  if (back && back.focus) back.focus();
});
const closeSheet = () => {
  // Un-inert first, then focus. The other order does nothing at all: focus on an inert element
  // is refused, and the refusal is silent, so the bug is "the gear is not focused after you
  // close settings" reported against the keyboard handler rather than against this line.
  setBackgroundInert(false);
  el.sheet.hidden = true;
  $('gearBtn').setAttribute('aria-expanded', 'false');
  clearHash();
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
$('fAuditionSave').addEventListener('click', () => downloadAudition());
// The counters are the only evidence that a setting helped, so they need a zero. Without
// one, "hybrid felt snappier" is a memory, and p95 carries every call since the reload.
$('statsReset').addEventListener('click', () => {
  stats.recv = 0; stats.lats = []; stats.deadair = 0; stats.falseCutoff = 0;
  stats.interrupts = 0; stats.stalled = 0; stats.turnStart = 0; stats.firstByteAt = 0;
  stats.tokens = 0;
  el.sRecv.textContent = '0.0s';
  el.sTurnLat.textContent = '–';
  el.sSpread.textContent = '–';
  el.sTokens.textContent = '0';
  if (el.sTurnLat) el.sTurnLat.dataset.bad = '0';
  if (el.sSpread) el.sSpread.dataset.bad = '0';
  note('counters reset — p50/p95 measure from here', 'sys');
});
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
    hybrid: $('fHybrid').checked,
    caps: $('fCaps').value,
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
  refreshModels(true); // validate the row this key can actually see
  closeSheet();
  note('Saved. Restart the session to apply.', 'sys');
  if (ws) { teardown(); note('Session restarted with the new settings — tap the mic again.', 'sys'); }
});

/**
 * The one answer "Test connection" gives, shown where the finger already is, and also
 * written to the log. It used to *replace* the log with its report — so testing the
 * connection after a failure deleted the failure, which is the one moment a person wants
 * both the diagnosis and the evidence.
 */
function probeSay(line, detail, kind = 'wait') {
  // The colour has to follow the *verdict*, not a guess at the wording: a status line that
  // reads "3 Live rows visible — your row is not there" is bad news in a calm voice, and the
  // first version of this pattern-matched the sentence and painted every probe red.
  if (el.probeOut) {
    el.probeOut.textContent = line;
    el.probeOut.dataset.kind = kind;
    el.probeOut.hidden = false;
  }
  logLine(`probe: ${line}${detail ? `\n${detail}` : ''}`);
}

$('sheetTest').addEventListener('click', async () => {
  probeSay('probing…');
  const k = $('fKey').value.trim();
  if (!k && !cfg.keysafe) return probeSay('no key to test — paste one above', '', 'bad');
  // Same code path the connect failure uses, so "Test" cannot pass while the real
  // thing is broken — two probes with two answers is how these drift.
  const was = cfg.key;
  cfg.key = k || cfg.key;
  const info = await refreshModels(false);
  cfg.key = was;
  if (!info) return probeSay('nothing to ask: no key on this page', '', 'bad');
  if (info.error) return probeSay(info.error, '', 'bad');
  const rows = info.live.map((n) => `  · ${shortModel(n)}${n === qualify(cfg.model) ? '  ← in use' : ''}`).join('\n');
  probeSay(
    `${info.live.length} Live row${info.live.length === 1 ? '' : 's'} visible to this key — `
      + (info.ok ? 'and your pick is one of them' : 'but your row is not, so pick one from Model'),
    info.ok ? `current row OK: ${shortModel(cfg.model)}\n${rows}` : `current row MISSING: ${shortModel(cfg.model)}\n${rows}`,
    info.ok ? 'ok' : 'bad',
  );
});

if (el.logCopy) el.logCopy.addEventListener('click', () => { copyLog(); });
if (el.logClear) el.logClear.addEventListener('click', () => {
  el.sheetLog.textContent = '';
  logLines = 0;
  el.sheetLog.setAttribute('data-lines', '0');
  if (el.logCount) el.logCount.textContent = '';
  el.logCopy.textContent = 'Copy for a bug report';
});

(async () => {
  cfg = load();
  applyA11y();
  try {
    const c = await (await fetch('/config')).json();
    cfg.keysafe = Boolean(c.keysafe);
    // Know before you tap Start: a retired row and a bad key look identical from the
    // socket (a dead 1006), so ask the REST endpoint instead and say so up front.
    refreshModels(true);
    save(cfg);
    if (cfg.keysafe) el.keyWarn.textContent = 'Server holds the key (proxy mode). Nothing to paste.';
  } catch {}
  if (!cfg.key && !cfg.keysafe || panelFromHash()) {
    // Either we have nothing to work with, or the URL named a panel: both mean the sheet
    // should be open when the page settles, on the panel that was asked for.
    openSheet();
  }
  if (!window.isSecureContext) {
    note('Insecure origin: getUserMedia needs https:// or localhost.', 'err');
  }
})();
