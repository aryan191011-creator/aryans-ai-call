# aryans-ai-call

A Hinglish voice assistant you can actually talk to. Budget: **₹0**. No credit card,
no subscription, no spare hardware.

```
mic ──► VAD ──► 16 kHz PCM ──► Gemini Live (speech-to-speech) ──► 24 kHz PCM ──► speaker
                                   ▲                                        │
                                   └──────── barge-in flushes playback ◄─────┘
```

One model hears you, decides when you have stopped talking, and speaks back. There is no
STT → LLM → TTS chain to tune, which is the only reason a ₹0 stack feels fast enough for
a phone call instead of a walkie-talkie.

## Run it

```bash
node server.mjs          # http://localhost:8787
```

Then open it, paste a **free** Gemini API key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) into ⚙, save, and talk.
No `npm install`, no build step, no dependencies — the whole app is three static files.

**Getting a key costs nothing but has two catches worth knowing up front:**

1. Google may use prompts sent on the free tier to improve its products. Paid tiers don't.
2. Free-tier quotas are per project and Google no longer publishes a fixed table — your live
   limits are only visible in AI Studio. A voice call burns requests fast (it is a long
   streaming call, not a chat message), so expect *tens* of calls a day, not thousands.
   `⚙ → Test connection` probes the model row before you burn anything on audio.

## The interface, and why each piece is shaped like that

Voice UI has unusually specific failure modes, so the design is pinned to rules
rather than taste. Every one of these is asserted by `npm run check:boot`, not just
claimed here.

| Rule | What the UI does |
| --- | --- |
| Silence reads as a dropped call; **voice has no spinner** | The orb has eight distinct states — idle, connecting, listening, thinking, speaking, interrupted, muted, error — each with its own motion, glyph *and* words |
| Show processing within **~200 ms** of end-of-speech or the caller talks over the agent | `thinking` is set on the VAD turn boundary itself, in the same callback, never on a timer |
| Identical animation for listening and speaking is the classic ambiguity bug | Their keyframe durations differ; a test fails if the two states ever share an `animation` declaration |
| Never convey state by colour alone | Icon + uppercase label + glyph change with state; colour is decoration |
| Barge-in is a **policy**, not a boolean | A short vocalisation ducks the agent to 35% and recovers; committed speech (>300 ms) cuts it; `ruko / stop / ruko` cuts on *words* from the transcript even before energy would; `Esc` always cuts |
| Cover any pause approaching **2 s** | A dead-air watchdog at 1800 ms says so in the UI and increments a counter — dead-air p95 is measured, not shrugged at |
| Audio cues must stay **under 150 ms** or they mask the first phoneme | Earcons are 110 ms with a 130 ms ceiling, synthesised in WebAudio (no asset, no network), mirrored as haptics, and can't take down a call if the node is missing |
| A live region inserted *with* its content is silent | `#a11yStatus` ships in the initial HTML with `role="status"` + `aria-live="polite"`; the transcript is `role="log"` polite so it announces without stealing focus |
| A pulsing background is invisible to assistive tech | The mic control is a real APG toggle button; `aria-pressed` tracks the session, and mute sets both `aria-pressed` and a matching `aria-label` |
| Auto-scroll must not yank a reader who scrolled up | `stick()` only follows while pinned within 90 px of the bottom; otherwise a "New reply ↓" pill appears and the scroll position is left alone |
| 44 px targets, 4.5:1 text, `prefers-reduced-motion` and `prefers-contrast` honoured | Sizes are asserted per base rule; motion/contrast/scale can also be overridden in-app and persist, because the OS setting is not always reachable from a phone browser |
| Latency averages hide the calls people remember | p50 **and p95** of silence→first-audio, plus false-cutoff count (caller resumes within 500 ms of the agent starting), shown in the footer |

Design decisions worth defending:

- **The half-duplex guard is on by default, and it disables barge-in.** On laptop
  speakers the agent hears itself and interrupts itself into nonsense. Headphones
  users untick it in Settings. That trade-off is explicit in config and tested,
  because a silent policy that changes what the interface can do is the kind of
  thing people should not have to discover.
- **The agent greets first.** The Live API has no opening-message concept: after
  `setupComplete` it waits for your audio, so a connected call was silence. We send
  one `clientContent` turn starting with a `<<connected>>` trigger that the persona
  documents, so the reply comes back as real speech through the same path as any
  answer. It is never echoed into the transcript, and it resets per call.
- **A blank persona cannot be saved.** `{...DEFAULTS, ...saved}` let a stored
  `prompt: ""` override the default, shipping an empty `systemInstruction` and
  silently stripping every phone-audio rule. Both load and save repair it.
- **`[hidden]{display:none !important}` is load-bearing, not decoration.** The UA's
  `[hidden]` rule is a *UA-origin* rule, so any author rule that sets `display` on the
  same element wins on cascade origin — specificity never gets a vote. `.sheet{display:
  grid}` did that: the settings dialog was visible on first paint, `closeSheet()` set
  `hidden = true` and nothing happened, and a `position:fixed; inset:0; z-index:20`
  layer ate every click, so the call could not be started at all. `#muteBtn` and
  `#hangup` were the same trap (controls shown before a call existed). No headless test
  can see this — there is no layout engine — so `check:boot` now asserts the guard
  exists *and* that no element hidden in the markup carries a competing `display` rule.
- **The dialog closes by every route a person tries**: the × button, Save, `Esc`, and a
  tap on the dimmed backdrop. A press that starts on a field and releases over the
  backdrop does not close it, so half-typed input is never lost.
- **There is a text field.** "I am on a bus" is a normal reason voice fails, and a
  voice-first UI that offers no keyboard fallback just loses the call.
- **Suggested openers replace the empty state.** Voice has no buttons, so
  discoverability has to come from somewhere.
- **`documentElement` access is guarded and the boot test caught it unguarded** —
  the harness has no real DOM, which is exactly the difference between "renders in
  Chrome" and "crashes on a phone with no oscillator".

## "It says connecting but not"

A failed WebSocket upgrade tells the browser nothing: no status, no body, sometimes only
code 1006 — and if the network drops it silently, *nothing at all*. So the handshake has
a 9 s deadline, and every way it can fail ends in a sentence naming the cause plus one
automated change, never a spinner:

| Failure | What the app does |
| --- | --- |
| Model row retired (free-tier names churn; from the socket it looks exactly like a bad key) | Asks the key which `*live*` rows exist, retries on one of those, and **banks the row that connected** so a reload doesn't start from the broken guess again |
| Row is fine | Says so, and retries with a minimal setup frame — the other variable |
| Key refused (400/401/403) | Says Google refused the key; no pointless retry |
| API unreachable at all | Says the browser and Google cannot talk from here — which is also the reason the call fails |
| Two tries used up | Stops, with the reason on screen, instead of looping |

Exactly one thing changes per attempt, so a success means something. Live rows are ranked
with native-audio first, because a row that connects and then has no audio to play is
misread as an audio bug forever. Settings shows how many Live rows your key can see and
flags a current row it cannot find **before** you press Start.

Two things found on the way, both real:

- **`teardown()` closed the socket, whose close event ran the diagnosis, which called
  `teardown()` again.** Handlers are now detached before closing, which also fixes the
  user-visible half: hanging up while stuck on "Connecting…" would have *reopened* a call
  you just cancelled.
- **`teardown()` used to `close()` the AudioContext every call.** Tidy, and wrong: Chrome
  caps live contexts per page and then refuses new ones *silently*, so by the seventh
  call of a session the output graph is simply gone — a "TTS stopped working after an
  hour" bug with no error anywhere. The context is a page-level resource; per-call
  teardown drops only that call's graph.

## The voice, and the microphone

**The voice you pick is the voice you get.** `setup.generationConfig.speechConfig.
voiceConfig.prebuiltVoiceConfig.voiceName` is where the Live API reads it. Sent flat on
`setup` instead — as a widely-copied snippet does — it is an unknown field: the call
works, the model speaks, and your choice is dropped in silence. That is the worst kind
of bug, because it looks like it is applying. Settings lists all **30 prebuilt voices**
with their character word, and a boot check fails if the picker and the JS table ever
drift, since an unrecognised name is either ignored or rejects the frame.

**Audition by ear, don't guess at adjectives.** "Warm", "Firm", "Breezy" mean different
things to different people, so the sheet renders the selected voice reading a real
Hinglish line via the TTS row (free tier, no dependency, raw 24 kHz PCM wrapped into a
WAV in the browser). It deliberately sends *no* style directive in the text, because some
TTS rows read an instruction aloud instead of acting on it. In keysafe mode the sample
goes through `POST /tts` so the key still never reaches the browser.

**Voice feel** is a small fixed chain on the output — low-shelf body, a 3.2 kHz cut for
the sibilance that makes synthetic voices hiss, and a compressor so an excited read does
not clip a phone speaker. No cost, no network, switchable off; changing it mid-call
applies to the rest of that call. The tests assert the filter nodes carry the numbers and
that the chain reaches `destination` — a chain built but not wired is exactly as silent
as no chain.

**A blocked microphone cannot cancel the call.** It used to: `getUserMedia` failed and
`connect()` returned, so no session at all — even though *hearing* the agent needs no
microphone. Now it classifies the cause (insecure origin, embedder that did not set
`allow="microphone"`, permission dismissed, no device, device busy, constraints refused),
says that one thing, offers *Open in a new tab*, and carries on as **text in · voice
out**. The state chip says so too, and hides mute and push-to-talk — controls for a
device the browser never handed over. Default voice is **Sulafat (Warm)** rather than a
firm read-aloud tone, because this is a phone call, not a narration.

## What's in the box

| File | Role |
| --- | --- |
| `web/index.html` | UI: orb state, transcript, latency meters, settings sheet |
| `web/app.js` | The pipeline: capture, resample, VAD, WebSocket, playback, barge-in, tools |
| `web/styles.css` | Mobile-first layout — a call is a phone thing |
| `server.mjs` | Static server + optional key-holding WebSocket relay |

Design decisions that are load-bearing, not decorative:

- **Sample rates are asymmetric on purpose.** Input is 16 kHz, output is 24 kHz. Feed it
  24 kHz and the model hears a pitch-shifted chipmunk and replies with garbage. Mic blocks
  are resampled by hand; playback buffers are *declared* at 24 kHz so the browser resamples
  on output — that sidesteps `sampleRate not supported` on Safari/iOS.
- **Half-duplex guard.** On laptop speakers the agent hears its own voice and talks over
  itself, so by default we stop feeding the mic while it speaks. Untick it with headphones
  and real interruption works. `Esc` force-flushes playback from either mode.
- **Config fields degrade instead of dying.** `speechConfig` / `realtimeInputConfig` /
  transcription field names have churned across model generations. If setup is rejected for
  an unknown field, the client retries with the minimal setup every Live model accepts.
- **Echo-back is a hard rule in the prompt.** Phone audio is 8 kHz-grade; models hallucinate
  confident digits. The persona must read every number, date, name and amount back digit by
  digit before trusting it. That rule matters more than the model choice.
- **Local tools.** `end_call` and `take_note` are implemented in the browser. Owning the loop
  is the point — a tool that hangs up a real call should not need a vendor's permission.

## Deploying for ₹0

Because the browser talks to Google directly, this is a **static site**. GitHub Pages or
Cloudflare Pages host it free forever, and they give you the HTTPS that `getUserMedia`
requires — which is how a friend "calls" the assistant: you send a link, they tap the mic.
A real phone number is not free at any price point, and that is not a gap in this repo.

**Do not deploy with a key in the page.** Anyone who opens the URL can read it and spend your
quota. For anything public, run the relay so the key stays on the server:

```bash
npm install ws
PROXY=1 GEMINI_API_KEY=AIza… node server.mjs
```

## The phone leg — read before you plan around it

Telephony is not software; every minute terminates on a carrier that charges for it. A ₹0
cloud will run the agent and cannot dial a number. Three honest ways out:

| Route | Cost | Reality |
| --- | --- | --- |
| **Bluetooth HFP, your Android as the modem** | ₹0 | BlueZ + oFono act as the headset. `ATD<number>;` dials, `ATA` answers, `+CLIP:` gives caller ID, and the audio rides a separate SCO link as 8 kHz PCM. Your number shows because the call really does leave your phone. Needs: one Linux box with Bluetooth, an Android phone, no cloud. Reference: `BadRed/bluetooth-ai-answering-machine`. |
| **Cloud telephony** | ~₹1–3/min | Twilio, Plivo, Exotel. Per-minute cost is small, but it is never zero, and India adds TRAI/DLT rules for commercial outbound plus a block on +91 caller IDs (`13247`). |
| **Your Jio Fiber number as caller ID** | ₹0 + fragility | Only possible by registering to Jio's IMS core as a fake JioCall device (`sivatheja10/jiofiber-bridge`: patched pjproject, TLS :5068, AMR↔PCMU). Works, breaks on carrier changes, and sits in ToS grey. Not for anything you depend on. |

Inbound for a personal assistant is simpler than outbound and needs no number: forward the
Jio Fiber landline to your mobile (`*401*<number>`, free service, domestic only), and the AI
answers the mobile over HFP.

## Next

1. **Quota-aware routing.** A second brain for when Google's free lane 429s: Groq's free tier
   gives `whisper-large-v3-turbo` (20 RPM / 2,000 req/day) and `llama-3.1-8b-instant`
   (14,400 req/day). Same turn boundary, cascade instead of speech-to-speech.
2. **Session continuity.** Live API connections cap around 10 minutes; long calls need
   reconnect + transcript replay. `goAway` is already surfaced in the UI.
3. **SCO transport.** Replace `getUserMedia` with the oFono SCO socket and this becomes a
   phone call. Keep the VAD, playback queue, tools and metrics untouched — only the pipe moves.
   Two gotchas: the kernel only accepts the phone's audio once you `read()` oFono's
   deferred-setup SCO socket, and PipeWire/PulseAudio must be out of the way or they grab the
   hands-free profile first.
4. **Hinglish ASR tuning.** If we fall back to cascade, `whisper-small` fine-tuned for Hindi
   beats the big general models on code-mixed speech at this audio quality.
