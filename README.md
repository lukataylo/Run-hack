# FORM/COACH — a running coach called Runway who lives in your ears and judges you

**Live demo: https://form-coach-production-76e3.up.railway.app** ← open this on a phone. That's it. That's the install.

> "Oh good, you showed up. I had a whole speech ready about quitters." — Runway, every run

## What is this

Your AirPods contain a lab-grade motion sensor that Apple mostly uses to make
spatial audio feel fancy. We use it to catch you running badly — and then a
voice named **Runway** tells you about it. Politely at first. Then honestly.

While you run, the app measures your **cadence, bounce, impact, left/right
balance, head sway and posture** — analysed on-device at 25 Hz, no cloud, no
signal needed — and speaks **one short correction at a time**:

> "Quicker feet. Shorten your stride."
> "Your head is rocking. Eyes forward, run tall."
> "Your form is rubbish. Look straight."

Silence means your form is good. Runway's silence is a compliment. You will
learn to crave it.

## The sass is a feature, not a bug

We researched why people love CARROT Weather (the weather app that calls you a
meatbag) and built the same delight into a coach:

- **Sassy by default.** Motivation lines land every ~10 seconds, no matter
  what: *"This pace is fine. 'Fine' is also how people describe airline food."*
- **Stand still and it notices.** *"Interesting strategy — standing still.
  Bold. Wrong, but bold."*
- **Form score under 40?** *"You look terrible. Wonderful. That means it's
  working."*
- **The rules that keep it funny instead of annoying** (learned from CARROT):
  it punches at effort and excuses, never at bodies; corrective cues always
  stay sincere (the tonal drop signals "this one's real"); one jab per moment,
  never two in a row; and a Supportive mode is one tap away for the tender.
- All of it in a real **ElevenLabs voice**, pre-rendered so the coach works in
  cellular dead spots. 68 voice clips committed to this repo. Yes, we made an
  AI record "Blink twice if you stretched. Thought so."

## The AirPods trick (the thing nobody else measures)

`CMHeadphoneMotionManager` streams a ~25 Hz IMU from a single AirPod — the
only consumer sensor mounted on your **head**. That gives us two metrics no
wrist or phone can honestly produce:

- **Sway** — the fraction of your motion that's side-to-side wobble, computed
  from the horizontal covariance eigenratio (no compass needed).
- **Posture** — the angle between gravity *now* and gravity when you were
  looking straight ahead. Nod at your feet and the angle opens; turn a corner
  and nothing happens (gravity doesn't care about heading). Drift past 8° and
  your form score bleeds; hit 30° and it's **zero** — perfect legs or not.
  The level **auto-calibrates 3 seconds into every run**, wherever your head
  is pointing, because that's where "straight ahead" is.

The phone-in-hand mode does everything else (cadence/bounce/impact/balance),
so the web app alone is a complete product. The AirPods mode is the flex.

## Judge's demo script (5 minutes, no setup)

1. **Open https://form-coach-production-76e3.up.railway.app on a phone**
   (Safari/Chrome). Tap Share → *Add to Home Screen* if you want the full-app
   feel — it's a PWA with an offline service worker.
2. Tap the **Coach** tab. Runway greets you with a roast in a speech bubble,
   out loud. Tap the robot for more. This alone is the demo.
3. Tap **Enable motion**, then **Start Run**. Now do nothing. Within ~8
   seconds Runway comments on your standing still. Jog on the spot: the
   cadence dial, waveform, form score and impact sparkline go live.
4. Jog *badly* — slow shuffle, exaggerated bounce. Wait ~30s. You'll get a
   real corrective cue, chosen by an evidence-based policy (thresholds from
   Garmin's published zones and peer-reviewed gait literature — see
   `COACHING.md`, every number has a citation).
5. Stop the run → **Insights**: charts, deltas vs your last run, and the
   **"Did the coaching work?"** card — for every cue, the metric 60 s before
   vs 120 s after, scored in the motor-learning consolidation window. No other
   running app can draw this chart; you need a timestamped cue log next to a
   per-second metric timeline.
6. **The live mirror**: start a run on the phone, open the same URL on a
   laptop. Within seconds the laptop's Home screen shows the run *live* —
   cadence, score, distance, last spoken cue. Zero pairing needed.
7. **Peek behind the curtain** (optional, from any terminal):
   ```bash
   # who's running right now, live
   curl https://form-coach-production-76e3.up.railway.app/live-any
   # raw telemetry stream, one JSON snapshot per 5s of running
   curl https://form-coach-production-76e3.up.railway.app/telemetry
   # which devices are on which build
   curl https://form-coach-production-76e3.up.railway.app/devices
   # make Runway say anything, in her actual voice
   curl -o hi.mp3 "https://form-coach-production-76e3.up.railway.app/tts?text=Judges%20have%20excellent%20taste"
   ```

Bonus tour: **Calibration** (Profile → Calibration) shows the sensor chain
live — a 3D head that copies yours, a posture score that collapses when you
look at your feet, step counting you can test by marching, and jump detection
you can test by hopping. **Goal runs** (Coach tab): pick 400 m in 2:00 and
Runway keeps the clock: *"Behind the clock. I've seen glaciers negative-split
better than this."*

## Architecture (the whole thing fits in one diagram)

```
┌─ iPhone ────────────────────────────┐
│  index.html + 15 plain-JS modules   │   The ENTIRE product is a static
│  ├─ coach.js    signal processing   │   web page. No framework. No build
│  ├─ persona.js  the sass            │   step. No bundler. Push → deployed
│  ├─ session.js  GPS/timeline/sync   │   in seconds, mid-run if we want.
│  └─ runner3d.js articulated runner  │
│         ▲ 25 Hz motion samples      │
│  ┌──────┴───────────────┐           │
│  │ AirPods IMU          │ phone IMU │   One ~200-line Swift WKWebView
│  │ (native shell only — │ (browser  │   shell exists ONLY because
│  │  CMHeadphoneMotion   │  API)     │   headphone motion has no web API.
│  │  has no web API)     │           │   It adds a sensor. Nothing else.
│  └──────────────────────┘           │
└───────────────┬─────────────────────┘
                │ JSON every 5 s (fetch keepalive, retry queue)
                ▼
┌─ Railway: server.js — node:http, zero dependencies ─┐
│  static files · /telemetry · /live mirror · /sync   │
│  /tts (ElevenLabs) · /bodyimage (OpenAI renders)    │
│  API keys live HERE, never in the page              │
└─────────────────────────────────────────────────────┘
```

- **All analysis runs on the phone.** Autocorrelation cadence with parabolic
  interpolation, orientation-independent gravity projection, Robinson
  asymmetry, harmonic ratios (Bellanca 2013), stride-time variability
  (Meardon 2011), fatigue-onset detection. The server never sees a raw sample.
- **The form score is explainable arithmetic**, not a model: weighted
  deductions past literature-anchored thresholds. Ask us why any score is
  what it is and we can answer in one sentence.
- **`replay.js` is the entire CI**: 81 assertions, plain node, no framework,
  runs in a third of a second. Synthetic runs with known cadence/asymmetry/
  sway go in; the analyzer must recover them or the suite fails.
- **3D everywhere, procedurally**: an articulated runner with real joint
  pivots gaits at your actual cadence and glows orange where your form leaks;
  the AI body renders are generated server-side per heat signature and cached.

## Honest limitations (we'd rather tell you than have you find them)

- Left/right balance labels are a heuristic until calibrated with a known limp.
- Ground contact time is **not computable** at 25 Hz (the validated ear-worn
  study used 800 Hz) — so we don't ship a fake one.
- Head-mode cadence is coarser than phone-mode; sway and posture are the
  head's real contribution.
- Every threshold is literature-anchored but not yet tuned on big fixture data.
- Telemetry storage is ephemeral by design — race-day data, not a database.
- Sass is calibrated for PG-13. Runway roasts your effort, never you.

## Run it yourself

```bash
node server.js          # http://localhost:3000 — zero npm installs, zero deps
npm run check           # 81 tests, <1s
```

iOS shell: `cd ios && xcodegen generate && xcodebuild` (needs a personal team;
it's a WKWebView pointed at the deployed URL, with the AirPods motion bridge).

---

Built in one day at a hackathon by three parallel AI agent tracks and a human
with strong opinions about posture. The couch filed a missing persons report.
