# Prompt: build "Form Coach" from scratch

> Hackathon brief: https://shore-dingo-75a.notion.site/How-The-Hack-Works-3c8c9ef714788041b796ef14bccd438a

You are an autonomous coding agent. Build a running-form coach, end to end, in one
day. AirPods and a phone are the sensors; a voice in your ears is the product. This
document is the complete specification: architecture, algorithms, exact thresholds,
UI, native shell, adaptive music, deployment and verification. Follow it in order.

Ground rules: plain JS and stdlib over frameworks; fewest files possible; every
commit deployable; verify each stage in a real browser (with simulated sensors)
before moving on; commit early — first-commit evidence matters at hackathons. When
this prompt gives a number, use it; when it marks something a calibration knob,
leave a comment saying so.

## The product

While you run, the app reads an IMU, detects form faults, and speaks one short
correction at a time: "Quicker feet. Shorten your stride." It stays silent when your
form is good. Two sensor modes: **phone in hand** (cadence, bounce, left/right
balance) and **AirPods in ears** (all of those plus head stability — the thing no
wrist or hand sensor can measure). Three runner profiles share one phone (relay
format). After a run: an analysis screen with charts, deltas vs last run, and a
suggested focus. Live telemetry streams to a server so a teammate can tune thresholds
mid-run.

## Architecture — the one decision everything hangs on

**The whole product is a static web page.** Motion via `DeviceMotionEvent` in Safari,
all analysis in plain JS on the phone, voice out through pre-rendered audio clips.
No build step, no framework, no bundler, no database.

Why: it ships in minutes, works with no signal (tracks have dead spots), and can be
changed while someone is running — push, redeploy, pull-to-refresh. A native app on
the critical path would cost the day.

Two things genuinely need more than the page:

1. **AirPods motion has no web API.** `CMHeadphoneMotionManager` is native-only. So
   the native app is a ~150-line Swift `WKWebView` shell that loads the same deployed
   page and injects head samples into it. It adds a sensor; it reimplements nothing.
2. **Serving + telemetry** needs ~100 lines of `node:http`. No Express, no deps.

**Hard constraint you must design around:** `CMHeadphoneMotionManager` delivers
motion from ONE bud at a time (~25 Hz). `sensorLocation` says which; the system
switches based on in-ear state. There is no parallel left/right stream — do not plan
a two-bud feature. And tell users to disable Automatic Ear Detection, or the stream
dies when a pod leaves an ear.

## Files (all at repo root; fewest possible)

| File | Contents |
|---|---|
| `index.html` | The entire app: 5 screens, styles, app logic in one `<script type=module>` |
| `coach.js` | Pure analysis + cue policy. Zero deps. Runs identically in browser and node |
| `session.js` | GPS distance, per-second timeline, telemetry beacon, per-runner localStorage history |
| `voice.js` | Audio out: ElevenLabs clip → native bridge → speechSynthesis |
| `head.js` | AirPods sample buffer; filled by the native shell via `window.__head(sample)` |
| `bot.js` + `bot-data.js` | Animated mascot face (see Mascot) |
| `pods3d.js` + `vendor/three*` | Procedural 3D AirPods for the home screen (see 3D) |
| `music.js` + `vendor/tone*` | Generative soundtrack driven by the live metrics (see Adaptive music) |
| `server.js` | Static files + telemetry endpoints, `node:http` only |
| `replay.js` | The entire test suite: `npm run check`, no framework, <1s |
| `gen-voice.mjs` | One-off build script: renders cue strings to `audio/*.mp3` via ElevenLabs |
| `ios/` | `project.yml` (XcodeGen) + one Swift file + Info.plist |

## The signal processing (`coach.js`)

Sample shape everywhere: `{t, ax, ay, az, gx, gy, gz}` — t in ms, a* gravity-removed
acceleration (m/s²), g* including gravity. The iOS shell converts CoreMotion g-units
to m/s² so both sensors produce identical samples.

Work on a rolling ~6 s window. All metrics must be **orientation-independent** — the
phone may be in a hand, armband or pocket:

1. **Gravity direction** = normalized mean of (gx,gy,gz) over the window (running
   acceleration averages out; what remains is g).
2. **Vertical series** v = samples projected onto gravity, mean-removed.
3. **Cadence**: autocorrelation of v, search lags for 130–210 spm, take the peak,
   then parabolic interpolation around it (gives ~1 spm resolution instead of ~9 at
   25 Hz). Do not peak-count raw accel — double impacts miscount.
4. **Bounce** = RMS of v (m/s²). **Impact** = max |v| / 9.81 (g).
5. **Footfalls**: local maxima of v above 0.8×RMS, minimum gap 0.6× step period.
6. **Asymmetry**: split footfalls into alternating odd/even groups; Robinson-style
   index |a−b|/((a+b)/2) of the group mean peak heights. Which group is "left" is
   decided by the sign of lateral acceleration at footstrike — mark this heuristic
   `uncalibrated` in a comment; a deliberate-limp recording settles it.
7. **Sway** (head-only metric): build an orthonormal frame from the data — up =
   gravity; fore = principal axis of the 2×2 horizontal-acceleration covariance
   (eigendecomposition), which IS the direction of travel when running; sway =
   sqrt(λ2/λ1), the fraction of horizontal motion that is across the direction of
   travel. Needs no compass. **Gate sway to ears mode only** — from a hand, arm
   swing IS the lateral motion and the number is meaningless.
8. **Moving gate**: overall accel RMS < 3 m/s² → not running → no metrics, no cues.
9. **Form score** 0–100: weighted, explainable deductions — 32×cadence shortfall,
   28×bounce excess, 24×asymmetry, 16×sway, each as clamped distance past its
   threshold. Not a model. A judge can ask why any score is what it is.

## The cue policy (evidence-based — this is what makes it a coach, not an alarm)

These numbers come from RunnerUp's source, Garmin's published zones, Heiderscheit
2011, and motor-learning literature. Keep the reasoning in a COACHING.md.

- Decide cues on a **~20-tick trimmed mean** of the metrics, not one 6 s window
  (one pothole is not a fault).
- **Cadence**: cue when smoothed cadence < 95% of the runner's own session baseline
  (trimmed mean of all session cadence), floored at 153 spm (Garmin red). Never use
  an absolute 180 target — the evidence says +5–10% of your own cadence.
- **Bounce**: > 10.5 m/s² RMS (≈ Garmin orange vertical oscillation). 7 is too
  strict — it flags runners Garmin rates green.
- **Sway**: after ~60 moving seconds, threshold = this runner's mean + 2 SD
  (capped at the fallback 0.62); before that, 0.62. No published absolute exists.
- **Asymmetry**: > 0.10, and ALWAYS the lowest-priority cue (an 800-runner RCT
  found asymmetry doesn't predict injury).
- Etiquette: **20 s start-of-run mute**; a fault must persist **12 s** on the
  smoothed view; **30 s minimum** between any two cues; **90 s** before repeating
  the same fault (a correction takes ~300 strides to land). One fault per
  utterance. Silence = good form.

Cue vocabulary — exactly four strings, fixed, so they can be pre-rendered to audio:

```
cadence:   "Quicker feet. Shorten your stride."
bounce:    "Too much bounce. Run softer, drive forward."
asymmetry: "You're favouring one side. Even it out."
sway:      "Your head is rocking. Eyes forward, run tall."
```

## Voice (`voice.js`, `gen-voice.mjs`, `audio/`)

Run `gen-voice.mjs` ONCE at build time: ElevenLabs TTS (voice "Adam",
`eleven_turbo_v2_5`, `mp3_44100_64`) for each cue string → `audio/<fault>.mp3`
(~20 KB each). **Commit the mp3s.** The run must never call an API — no signal on
the back straight. API key from env only; never in a file or commit.

Playback priority in `say(text, fault)`: preloaded `Audio` clip → native
`webkit.messageHandlers.say` bridge (survives locked screen) → `speechSynthesis`.
`unlock()` must run inside the Start tap's gesture handler: play one muted clip and
speak an empty utterance — iOS unlocks audio per user gesture.

## Sessions & telemetry (`session.js`, `server.js`)

- **Users**: Runner 1/2/3 segmented control on Home. Active user in
  `localStorage['user']`; runs saved under `runs:<n>` (keep last 20, full
  timelines). This is how a relay team shares one phone.
- **Session**: GPS via `watchPosition` (highAccuracy; ignore accuracy > 30 m and
  jumps > 50 m; haversine-sum distance). One timeline entry per second: cadence,
  bounce, impact, asym, sway, score, balance-left. Cue log with timestamps.
- **Telemetry**: every 10 s, `sendBeacon` (fallback fetch keepalive) a JSON snapshot
  — user, mode, km, last 5 cues, last 12 timeline entries — to
  `POST /telemetry/<runner>`. Fire-and-forget; a dead spot must never touch the run.
- **Server**: static files (block path traversal: resolve and require the path stays
  under root) + telemetry: POST appends JSONL to `/tmp/telemetry/runner-N.jsonl`
  (cap 512 KB body, 20 MB file, validate JSON, runners 1–3 only);
  `GET /telemetry` lists who has data; `GET /telemetry/N` streams the JSONL
  (stat first — a bare createReadStream error crashes the process);
  `?latest=1` returns the last line. CORS `*`. Storage is ephemeral by design —
  race telemetry, not a system of record. The workflow it exists for: a teammate
  curls the stream into a Claude session mid-run and tunes CONFIG.

## UI (`index.html`) — dark, dense, one accent

Design tokens: bg #09090b, cards #17171a radius 18px, text #f4f4f5, dim #8e8e96,
accent orange #ff5b14 (gradient to #ff8a3d), good green #3ddc84. Uppercase 10px
letterspaced eyebrow labels over huge tight-tracked tabular numerals. Tab bar: Home,
Insights, Coach, Profile — inline SVG stroke icons ONLY (no emoji, no unicode
glyphs anywhere; play/record/sound/back/share/chevron as hand-drawn 24px paths).

Five screens, `display:none` switching:

1. **Home**: brand "FORM/COACH", headline "Run better. / Every run.", 3D AirPods
   canvas, Runner 1/2/3 selector, connection pill (AirPods streaming? phone ready?),
   big Start Run CTA, Activity History button.
2. **Live run** (tab bar hidden): LIVE badge, timer, GPS indicator; cadence dial —
   270° SVG arc with ticks, huge number, "Target 170–180"; scrolling vertical-accel
   waveform (canvas); form score + distance card; impact card with dot sparkline
   (green under 3 g, amber over); gait balance donut with L/R percentages and bias
   note; mascot + cue line; record-fixture toggle, big stop button, voice toggle.
3. **Insights / Run Analysis**: hero card (orange gradient, radiating rings —
   headline names the dominant fault from the cue log, e.g. "Fixing overstride is
   your fastest win", small 3D pod; green variant when no faults); suggested-focus
   + form-score row; impact-over-time area chart and cadence bar chart with
   0:00/mid/end axis and green/orange % deltas vs previous run; head-stability
   chart (ears runs only); run summary row (km, duration, cue count, mode);
   activity history list (score chip, per-run rows, tap to open past run).
4. **Coach**: big mascot + the four cues with their trigger names + one paragraph
   on the etiquette.
5. **Profile**: sensor mode toggle (Phone/AirPods), voice on/off, AirPods stream
   status, export-last-recording button (downloads `.jsonl`).

**Two rendering traps (you will hit both):** (1) canvases measured while their
screen is `display:none` size to 0 — always `show()` the screen before rendering
charts; (2) drive all animation (mascot, meters) with `setInterval`, not
`requestAnimationFrame` — rAF freezes in occluded windows and throttled webviews.

The app loop: one `setInterval` at 1 Hz — analyze window, paint, `coach.update()`,
on cue: speak, log, flash the line, set mascot to alerting. Wake lock while running;
re-acquire on visibilitychange.

Recorder: Record toggle buffers raw samples of the active mode; Export downloads
JSONL. These files go to `fixtures/` and are the calibration data.

## Mascot (`bot.js`, `bot-data.js`)

An animated SVG robot face: blob body in card colour, two orange eyes that morph
between expressions (spring interpolation: `vel += (-14*vel - 49*(morph-1))*dt`),
blink on a per-state random interval, gaze wander. States: idle, listening (waiting
for sensor), working, happy (score ≥ 85), suspicious (fault building), alerting
(cue spoken), sleeping (stopped), celebrate, proud.

Source the expression data from an MIT-licensed open project if you can (we
extracted 19 expressions from LaoA-GrokBot, attribution kept — **check the license
before taking character art**; a popular alternative was non-commercial-only and
unusable). Otherwise draw ~6 simple eye-pair path sets by hand; the spring morph is
what sells it, not the art.

## 3D AirPods (`pods3d.js`)

Do NOT download an AirPods model — the free ones are rips of Apple's AR assets with
unusable provenance. Build procedurally with vendored three.js (MIT, committed):
scaled spheres for head + angled tip, capsule stem, dark grille circle, metallic
foot ring; `MeshPhysicalMaterial` white with clearcoat 1; `RoomEnvironment` PMREM
lighting; ACES tone mapping; warm key light; slow oscillating rotation; the right
bud is `scale.x = -1` of the left. Decorative: wrap the mount in a dynamic import
with catch — a WebGL failure must never take the app down.

## iOS shell (`ios/`)

XcodeGen `project.yml` (commit it, gitignore the generated xcodeproj): one target,
bundles ALL web files (index.html, all js, vendor/, audio/) as resources — offline
cold-start fallback. Info.plist: `NSMotionUsageDescription`, `UIBackgroundModes:
[audio]`, portrait only. No `UIRequiredDeviceCapabilities`.

One Swift file: SwiftUI `App` → `UIViewRepresentable` `WKWebView` loading the
deployed URL (`.reloadRevalidatingCacheData`; on navigation failure load the
bundled index.html once). Coordinator: `AVAudioSession` `.playback/.spokenAudio`
with `.duckOthers .mixWithOthers`; a `say` script message handler speaking via
`AVSpeechSynthesizer` (rate 0.52); on page load start `CMHeadphoneMotionManager`
updates and for each sample `evaluateJavaScript("window.__head({...})")` with
t = (timestamp − first) × 1000 and all axes × 9.81. `isIdleTimerDisabled = true`.

Build/deploy: `xcodegen generate`, then `xcodebuild -allowProvisioningUpdates` with
a personal team, install via `xcrun devicectl device install app`. New devices need
Developer Mode on and one Xcode-GUI run to register (free-team limitation). 7-day
cert expiry — fine for a hackathon.

## Adaptive music (`music.js`) — the run generates its soundtrack

A generative layer where form drives the music. Prior art says: Spotify Running died
switching between licensed tracks; Weav Run got it right by recomposing one piece
from stems. We synthesize everything, so there are no assets, no licensing and no
time-stretching.

**Engine**: Tone.js (MIT, vendored like three.js). All scheduling on one
`Tone.Transport` (it implements lookahead scheduling internally). Genre: lo-fi trap
at **half-time** — cadence 150–190 spm → `bpm = spm/2`, clamped 70–100,
`Transport.bpm.rampTo(bpm, 2)` so it glides, never jumps. Every footfall lands on
an 8th-note hat. Everything in C minor pentatonic — no wrong notes possible.

**Five `Tone.Loop` layers**: (1) kick+snare boom-bap, always on — the pacemaker;
(2) hats, 8ths with probabilistic 16ths; (3) 2-bar bass riff C–Eb–G–Bb;
(4) pad chords Cm7–Abmaj7–Eb–Bb through a lowpass + reverb; (5) reward arp with
ping-pong delay, unlocked by sustained good form.

**Mapping** (smooth every metric with a ~4 s EMA; apply changes only at bar
boundaries, except BPM):

| Metric | Musical response |
|---|---|
| cadence | Transport BPM, half-time, 2 s ramp |
| form score | pad filter cutoff 400 Hz–8 kHz; score > 75 adds the 9th to chords |
| bounce | hat velocity + 16th probability: soft feet = busier, crisper hats |
| asymmetry | percussion pan drifts ~0.3 toward the weak side — subtle, self-correcting |
| sway | reverb wet 0.1→0.4: a steady head = a tight mix |
| score > 80 for 8 bars | arp layer in; out again below 70 (4-bar hysteresis) |
| cue event | at next bar: duck master −8 dB, two-note sting, hold 1.5 s for the voice, ramp back |

**Anti-annoyance rules**: hysteresis on every threshold, bar-quantized changes, max
one layer change per 4 bars, rotate bass/arp patterns every 16 bars regardless of
metrics so a steady runner still gets variation. Silence stays an option — music is
a toggle on the Profile screen, off by default during judging of the voice cues.

**iOS traps**: start the Transport inside the same tap gesture as `unlock()` (`await
Tone.start()`); set `navigator.audioSession.type = 'playback'` where available or
loop a silent `<audio>` element so the ring/silent switch doesn't mute WebAudio;
screen lock suspends WebAudio with no workaround — the wake lock you already hold is
the mitigation. Duck the music through one master gain the voice path also uses.

## Checks (`replay.js` — the whole CI)

`npm run check`, plain node, assert-style PASS/FAIL lines, exit 1 on failure:

- Synthesize runs (footfall = narrow Gaussian spike per step + flight-arc cosine,
  NOT a sine — the harmonic structure matters to autocorrelation; ~0.6× peak→RMS)
  at known cadence/bounce/asymmetry/sway → assert `analyze()` recovers each (cadence
  within 4 spm; asymmetry flagged when planted; sway eigenratio separates steady
  from wobble; standing still not coached).
- Score: good form ≥ 85, bad ≤ 50, ranks correctly.
- Cue policy: slow-cadence run gets the cadence cue; nothing before the grace
  period; ≥ 30 s between cues; same fault never repeats inside 90 s; clean run
  gets zero cues; sway cued in ears mode, never from hand.
- Replay every `fixtures/*.jsonl` and print its metrics + cue timeline.

CI beyond this: push to main + Railway auto-redeploy. Nothing else. (Deliberate:
GitHub Actions adds nothing you can read mid-lap that `curl`ing the live site
doesn't.)

## Deployment

Railway: `railway init`, `railway up --ci --service form-coach`, `railway domain`.
`package.json`: `{"type":"module","scripts":{"start":"node server.js","check":"node replay.js"}}`.
HTTPS is mandatory — iOS refuses motion sensors without it. After every deploy,
verify: curl each file for 200 AND grep the live HTML for a marker you just added
(deploys can silently serve stale).

## Verification workflow (how to build this without a treadmill)

Desktop Chrome has no IMU. Drive the app with synthetic sensors in the console:
construct `DeviceMotionEvent`s for hand mode (dispatch at real 16 ms cadence —
browsers throttle timers in unfocused windows, so bursty dispatch corrupts the
timestamps; if you see impossible cadence, that's why), and call `window.__head()`
with synthetic-t samples for ears mode (immune to throttling — preferred). Run the
full loop: start → watch dial/score/balance → wait for the cue → stop → verify the
analysis screen, then curl the production telemetry endpoint and confirm the
snapshots arrived. Screenshot every screen before shipping.

## Order of work

1. `coach.js` + `replay.js` green → commit (this is the eligibility timestamp).
2. `index.html` MVP + `server.js` → deploy → verify live on a phone.
3. iOS shell → device install. Freeze it; all iteration is now web-only.
4. Polish UI, mascot, 3D, ElevenLabs, telemetry, users — each its own deployable
   commit.
4b. Adaptive music: drums+bass against a fake cadence slider first, then wire the
   real metrics, then the cue duck. Keep it behind a toggle.
5. Record real fixtures on the track; tune CONFIG from them; lock with asserts.

## Register of honest limitations (put these in the README)

- Balance left/right labels are a heuristic until calibrated with a known limp.
- Head-mode cadence is coarser (~25 Hz, neck damping); sway is the head's real
  contribution.
- Every threshold is literature-anchored but not yet fixture-tuned.
- Telemetry is ephemeral; personal-team builds expire in 7 days.

State these rather than let a judge discover them.
