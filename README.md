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
