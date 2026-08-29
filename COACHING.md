# Why the coach says what it says

Every threshold and every timing rule in the cue policy is anchored in
published evidence or shipped products. This file is the receipts. The code in
`coach.js` uses these numbers; if you tune one from fixtures, update it here.

## The four faults and their thresholds

### Cadence — cue below 95% of the runner's own baseline, floored at 153 spm

The popular "always run at 180 spm" target is a misreading of one observation
of elite racers. The intervention evidence (Heiderscheit et al. 2011, *Effects
of step rate manipulation on joint mechanics during running*) increased step
rate by **+5–10% of the runner's own preferred cadence** and measured reduced
energy absorption at the knee and hip. Relative-to-self is the defensible
target, so the cue fires when the ~20-tick smoothed cadence drops below **95%
of the session's own trimmed-mean cadence**.

The absolute floor comes from Garmin's published running-dynamics zones:
cadence **< 153 spm is Garmin's red zone** (bottom ~5% of their reference
population). Below that we cue regardless of personal baseline. RunnerUp
(open-source Android running coach) takes the same shape of approach in its
targets: coach against a configured personal target, not a universal number.

### Bounce (vertical oscillation) — cue above 10.5 m/s² RMS

Garmin's vertical-oscillation zones put roughly **> 10.1–11 cm in the
orange/red bands**. On our signal (RMS of gravity-projected acceleration over
a 6 s window) 10.5 m/s² RMS tracks that boundary for recreational cadences. An
earlier draft used 7 m/s² and flagged runners Garmin rates green — too strict,
an alarm not a coach. 10.5 flags only genuinely bouncy gait. Calibration knob:
re-fit against recorded fixtures.

### Asymmetry — cue above 0.10, always lowest priority

The index is Robinson's symmetry index (|a−b| / mean(a,b)) on alternating
footfall peak heights; 0.10 is the conventional "notable asymmetry" line in
gait literature. It is deliberately the **lowest-priority** cue: an RCT-grade
prospective study following ~800 runners found baseline gait asymmetry did
**not** predict running injury. It is worth mentioning to a runner; it is not
worth interrupting a cadence or bounce correction for.

### Sway (head stability, AirPods only) — self-calibrating, fallback 0.62

No published absolute threshold exists for head lateral sway measured at the
ear — this metric is the product's novel contribution. So it self-calibrates:
after **60 moving seconds**, the threshold is this runner's session
**mean + 2 SD** (a statistical outlier vs their own steady state), capped at
the fallback **0.62** eigenvalue ratio (fraction of horizontal motion that is
across the direction of travel). Before 60 s, the 0.62 fallback applies.
Gated to ears mode: from a hand, arm swing IS lateral motion and the number is
meaningless.

## Etiquette timing (why the coach is mostly silent)

A cue you hear twice a minute is noise. The timing table:

| Rule | Value | Reason |
|---|---|---|
| Start-of-run mute | 20 s | Metrics windows are still filling; first impressions are junk |
| Decision signal | ~20-tick trimmed mean | One pothole, one curb, one dropped phone is not a fault |
| Fault persistence before cue | 12 s | Fault must survive the smoothed view; transients never speak |
| Minimum gap between any two cues | 30 s | One instruction at a time is the limit of attention under load |
| Same-fault repeat interval | 90 s | Motor-learning literature: a gait correction takes ~300 strides (~90 s at 170–200 spm) to consolidate. Re-cueing sooner nags about a change still in progress |
| Faults per utterance | 1 | Dual instruction under fatigue = neither lands |
| Good form | silence | Silence is the reward signal. The music (and mascot) carry positive feedback so the voice never has to |

Priority order when several faults persist simultaneously: cadence > bounce >
sway > asymmetry (asymmetry last per the injury-prediction evidence above).

## Cue vocabulary (frozen contract)

Pre-rendered to `audio/*.mp3` so the run never needs the network:

```
cadence:   "Quicker feet. Shorten your stride."
bounce:    "Too much bounce. Run softer, drive forward."
asymmetry: "You're favouring one side. Even it out."
sway:      "Your head is rocking. Eyes forward, run tall."
```

Each is one breath long, imperative first, reason second — hearable and
actionable at threshold pace.

## Metrics evidence (the reported, non-cued metrics)

The four faults above drive the voice. The metrics below are **measured and
reported, never spoken** — they are the run analysis, not the coach. Each one
gets its citation, its one-line algorithm, and an honest confidence rating for
what a **~25 Hz single-bud AirPods stream** can actually support.

### Harmonic ratio — gait smoothness / step-to-step symmetry

- **What it is.** How cleanly your two steps match each other, as one number.
  Higher = smoother, more symmetric.
- **Citation.** Bellanca, Lowry, VanSwearingen, Brach & Redfern 2013, *Harmonic
  ratios: a quantification of step to step symmetry* (J Biomech 46:828–831),
  building on Menz, Lord & Fitzpatrick 2003, *Acceleration patterns of the head
  and pelvis when walking on level and irregular surfaces* (Gait & Posture
  18:35–46) — which is also the paper that establishes measuring gait from an
  accelerometer **at the head** in the first place.
- **Algorithm.** Stride frequency `f = (spm/60)/2`; a Goertzel bank gives the
  amplitude at `k·f` for `k = 1..8` on the Hann-windowed, mean-removed vertical
  series; `HR = Σ even / Σ odd` (the mediolateral axis inverts to `odd / even`).
  Two identical steps repeat every half stride, so all their energy sits in the
  even harmonics; asymmetry leaks it into the odd ones.
- **Confidence at 25 Hz single-ear: MEDIUM for trend, ZERO for absolute.** The
  8th harmonic must sit under the 12.5 Hz Nyquist, so `harmonicRatio()` returns
  `null` above ~187 spm — a fast runner simply gets no number, which is the
  honest outcome. And there are **no published harmonic-ratio norms for
  running**, none at all at the ear: the literature is walking, at the pelvis or
  trunk. So the value is a **self-baseline** only ("smoother than your own
  usual"), and nothing is ever cued from it.

### Stride-time variability (CV%) — rhythm consistency

- **What it is.** How much your stride time wanders, as a coefficient of
  variation. Rises with fatigue and with injury history.
- **Citation.** Meardon, Hamill & Derrick 2011, *Running injury and stride time
  variability over a prolonged run* (Gait & Posture 33:36–40): healthy running
  sits at roughly **1–3% CV**, and CV rises over a prolonged run — more so in
  runners with an injury history.
- **Algorithm.** Footfalls are the local maxima of the vertical series; each
  peak is refined by **parabolic interpolation over its 3 samples** for
  sub-sample timing. A stride is **two** steps, so stride time is the interval
  between *alternate* footfalls; `CV% = SD/mean × 100`.
- **Confidence at 25 Hz single-ear: TREND ONLY — the absolute number is
  inflated and must never be quoted against Meardon.** At 25 Hz a sample is
  40 ms. Timing a peak by its raw sample index quantizes to ±20 ms on a ~700 ms
  stride, which **manufactures a ~5–6% CV floor out of pure sampling, before any
  biology**. Parabolic interpolation cuts that floor to about **1.5–2%** — still
  the same order as the 1–3% signal we are trying to see. Because the floor is
  constant across a run it cancels out of a comparison, so **first-quarter vs
  last-quarter (`fatigue.cvTrendPct`) is valid and the raw value is not.**
  (The same interpolation improves the asymmetry index for free: discrete
  sampling used to clip alternate peaks by different amounts and inflate the
  Robinson index on its own.)

### Head orientation stability (wobble) — pitch/roll RMS

- **What it is.** How much your head rotates about its own average attitude,
  in degrees. The thing no wrist or hand sensor can measure.
- **Citation.** Pozzo, Berthoz & Lefort 1990, *Head stabilization during various
  locomotor tasks in humans* (Exp Brain Res 82:97–106): during locomotion the
  head is actively stabilized in space by the vestibulocollic reflex, holding
  pitch and roll within roughly **7° peak-to-peak**. Sustained excursion past
  ~10° is therefore defensible as a fault.
- **Algorithm.** Pitch and roll per sample from the AirPods **attitude
  quaternion**, averaged circularly (so a ±180° wrap cannot fake a swing);
  `wobbleDeg = sqrt(RMS_pitch² + RMS_roll²)` about the window means.
- **Confidence at 25 Hz single-ear: GOOD on the quaternion path, WORTHLESS on
  the fallback.** Orientation is a low-frequency quantity — 25 Hz is ample, and
  CoreMotion always ships an attitude, so the real sensor takes the good path.
  The gravity-vector fallback (used when `q*` is absent) **conflates "the head
  tilted" with "the body accelerated"**, because a raw `g*` vector is gravity
  *plus* linear acceleration and during running those are the same order: on
  synthetic 8 m/s² running it reads ~19° where the true tilt is 0°. Low-passing
  that away would also remove the stride-band head motion we want, so there is
  no fix — it is a degraded-mode readout. `headStability()` returns a `source`
  field; **trust `'quaternion'` only.** `CONFIG.HEAD_WOBBLE_MAX = 10` is a
  **calibration knob**: ours is an RMS, Pozzo's is a peak-to-peak, so the
  mapping between them is approximate until fixtures settle it.

### Run-level fatigue (`run.fatigue`, computed once at stop)

- **Cadence drift** — Hunter & Smith 2007, *Preferred and optimal stride
  frequency, stiffness and economy: changes with fatigue during a 1-h
  high-intensity run* (Eur J Appl Physiol 100:653–661): stride frequency drifts
  **down** with fatigue. We report a least-squares slope in **spm per 10 min**.
  Honest caveat: the red flag is a falling cadence **at constant pace**, and the
  slope alone cannot see pace — read it beside km/estKmh.
- **Fatigue onset** — first second at which a trailing 3-minute mean of cadence
  departs by more than 2 SD from the first-10-minute baseline. `null` under
  ~12 minutes of run, and `null` when the baseline has no spread to test
  against. A short run has no fatigue story and must say so.
- **Head impact drift** — Derrick 2002 (*Energy absorption of impacts during
  running at various stride lengths*) and the shock-attenuation literature: the
  head's impact acceleration is **regulated to stay roughly constant** while
  tibial impact varies with stride length, so an **upward drift at the head** is
  a real signal that the regulation is failing. Reported as last-quarter vs
  first-quarter %. **Naming discipline: this is "head impact drift", never
  "shock attenuation".** Shock attenuation is a tibia-to-head *transfer ratio*
  and needs a second sensor on the shank, which we do not have. Any UI or copy
  calling it shock attenuation is wrong.

### The "Did the coaching work?" view

Per cue, the cued metric's own 60 s before it (baseline mean ± SD) against the
**30–90 s window after** it, scored in the improving direction for that fault.
The 30–90 s window is not arbitrary: it is the same motor-learning consolidation
window as the 90 s same-fault repeat rule above (~300 strides). Measuring the
first 30 s would measure the runner *reacting*, not the correction *holding*.
Honest caveat: this is **observational, n = 1, uncontrolled**. A cadence rise
after a cadence cue may be the cue landing, or a downhill, or the runner
speeding up anyway. It is a conversation starter, not evidence of causation.

### Ground contact time — deliberately NOT shipped

GCT is the metric people ask for next, and **it is not computable from this
sensor.** Detecting foot strike and toe-off from head-mounted acceleration means
resolving the impact transient, whose energy sits **well above our 12.5 Hz
Nyquist**. The validated ear-worn GCT work samples at **800 Hz**;
`CMHeadphoneMotionManager` gives us **~25 Hz, one bud at a time**. That is a
32× shortfall in bandwidth, not a tuning problem — no filter, no interpolation
and no model recovers a transient that was never sampled. We could emit a
plausible-looking number, and it would be fiction. We do not ship it, and this
paragraph exists so nobody adds it later thinking it was an oversight.

## Honest limitations

- Thresholds are literature-anchored but not yet fixture-tuned; the recorded
  `fixtures/` runs are the calibration path.
- Left/right labeling of the asymmetry index is an uncalibrated heuristic
  until validated with a deliberate-limp recording.
- Head-mode cadence is coarser (~25 Hz single-bud stream, neck damping); the
  head's real contribution is sway.
- Harmonic ratio has no published running norms and returns `null` above
  ~187 spm (Nyquist); stride-time CV is inflated by 25 Hz quantization and is
  trend-only; head wobble is trustworthy only on the quaternion path. See
  "Metrics evidence" above for each.
- Ground contact time is **not computable at 25 Hz** and is deliberately not
  shipped — the validated ear-worn study used 800 Hz.
- Goal runs: GPS accuracy is ±10–30 m and `watchPosition` fixes arrive at
  ~1 Hz, so 100 m goals are coarse — treat sub-400 m goals as demo-grade, and
  timing precision is bounded by the fix cadence. When GPS is stale the goal
  tracker falls back to a cadence proxy, which measures rhythm/effort, not
  speed — a shortening stride at constant cadence is invisible to it.
