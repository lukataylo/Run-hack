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

## Honest limitations

- Thresholds are literature-anchored but not yet fixture-tuned; the recorded
  `fixtures/` runs are the calibration path.
- Left/right labeling of the asymmetry index is an uncalibrated heuristic
  until validated with a deliberate-limp recording.
- Head-mode cadence is coarser (~25 Hz single-bud stream, neck damping); the
  head's real contribution is sway.
