// coach.js — pure analysis + cue policy. Zero deps. Identical in browser and node.
// Sample shape everywhere: {t, ax, ay, az, gx, gy, gz} — t ms, a* gravity-removed
// m/s², g* including gravity.

export const CONFIG = {
  // cadence search band (spm) — physiological running range
  CADENCE_MIN: 130,
  CADENCE_MAX: 210,
  // cue thresholds (the contract — do not rename/renumber)
  CADENCE_FLOOR: 153,          // Garmin red zone floor (spm)
  CADENCE_BASELINE_FRAC: 0.95, // cue when below 95% of own session baseline
  CADENCE_HEALTHY: 170,        // bottom of the healthy target zone — never cue at/above this
  BOUNCE_MAX: 10.5,            // m/s² RMS ≈ Garmin orange vertical oscillation
  ASYM_MAX: 0.10,              // Robinson index
  SWAY_FALLBACK: 0.62,         // eigenratio fallback until per-runner calibration
  SWAY_CALIB_S: 60,            // moving seconds before per-runner sway threshold
  MOVING_RMS: 3,               // m/s² — below this: not running, no metrics, no cues
  // posture guard (opt-in; needs a Set-level calibration) — calibration knobs
  TILT_DEV_DEG: 12,            // degrees off the calibrated neutral before it's a fault
  // head orientation stability (ears mode) — CALIBRATION KNOBS.
  // Pozzo & Berthoz 1990 measured head pitch/roll held under ~7° peak-to-peak
  // during locomotion by the vestibulocollic reflex; >10° sustained is a
  // defensible fault line. Our number is an RMS of combined pitch+roll, not a
  // peak-to-peak, so the mapping from their figure to ours is approximate —
  // re-fit from fixtures before trusting it.
  HEAD_WOBBLE_MAX: 10,         // deg — sustained combined pitch/roll RMS = fault
  // harmonic ratio (Bellanca 2013 / Menz 2003) — calibration knobs except the
  // Nyquist ceiling, which is physics, not taste
  HR_HARMONICS: 8,             // harmonics k·f summed into the odd/even ratio
  HR_NYQUIST_HZ: 12.5,         // AirPods stream ~25 Hz → hard ceiling, NOT a knob
  HR_MIN_WINDOW_S: 4,          // frequency resolution floor for the Goertzel bank
  // accel-only speed estimate: v ≈ SPEED_K · stepHz · sqrt(vertical oscillation).
  // SPEED_K self-calibrates against GPS when it is live — calibration knob
  SPEED_K: 4.3,
  // etiquette (ms)
  MUTE_MS: 20000,              // start-of-run mute
  PERSIST_MS: 12000,           // fault must persist this long on the smoothed view
  GAP_MS: 30000,               // minimum between any two cues
  REPEAT_MS: 90000,            // before repeating the same fault (~300 strides)
  TRIM_TICKS: 20,              // trimmed-mean window for cue decisions
  // form score weights (explainable deductions)
  WEIGHTS: { cadence: 32, bounce: 28, asym: 24, sway: 16 },
  // score normalizers: full deduction this far past threshold — calibration knobs
  CADENCE_SPREAD: 20,          // spm below floor for full cadence deduction
  BOUNCE_SPREAD: 4,            // m/s² past BOUNCE_MAX for full deduction
  ASYM_SPREAD: 0.15,           // past ASYM_MAX
  SWAY_SPREAD: 0.2,            // past SWAY_FALLBACK
  // goal run (distance + target time) — additive knobs
  GOAL_BASELINE_S: 120,        // moving ticks of cadence that lock the fallback baseline
  GOAL_ONPACE_FRAC: 0.97,      // cadence proxy: on pace while >= 97% of own baseline
  GOAL_BEHIND_S: 10,           // GPS branch: continuous behind-seconds before a nudge
  GOAL_CADENCE_BEHIND_S: 20,   // cadence-proxy branch: continuous below-seconds before a nudge
  GOAL_BEHIND_KM_MIN: 0.005,   // km — GPS behind threshold floor (GPS noise floor)
  GOAL_BEHIND_FRAC: 0.05,      // GPS behind threshold as a fraction of the goal distance
  GOAL_NUDGE_GAP_MS: 45000,    // minimum between two behind nudges
  GOAL_MILESTONES: [0.5, 0.9], // half / ninety one-shots
  GOAL_OVERRUN_FRAC: 0.10,     // silent forever past goalS * 1.10
  GOAL_SMOOTH_TICKS: 10,       // rolling trimmed-mean window for the cadence proxy
};

export const CUES = {
  cadence: 'Quicker feet. Shorten your stride.',
  bounce: 'Too much bounce. Run softer, drive forward.',
  asymmetry: "You're favouring one side. Even it out.",
  sway: 'Your head is rocking. Eyes forward, run tall.',
  // posture guard (opt-in mode): deviation from the CALIBRATED head level
  posture: "Head's dropping. Chin up, run tall.",
};

// priority order for cue selection (asymmetry ALWAYS lowest — RCT: doesn't predict injury)
const PRIORITY = ['cadence', 'bounce', 'sway', 'posture', 'asymmetry'];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function median(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function trimmedMean(arr, frac = 0.1) {
  const n = arr.length;
  if (n === 0) return 0;
  if (n < 4) return arr.reduce((s, x) => s + x, 0) / n;
  const a = arr.slice().sort((x, y) => x - y);
  const k = Math.max(1, Math.floor(n * frac)); // always trim ≥1/side: one pothole is not a fault
  let s = 0;
  for (let i = k; i < n - k; i++) s += a[i];
  return s / (n - 2 * k);
}

// Vertical acceleration series: gravity-removed accel projected onto the gravity
// direction (normalized mean of g*), mean-removed. Orientation-independent.
// Exported for the live waveform canvas.
export function verticalSeries(samples) {
  const n = samples.length;
  if (n === 0) return { v: [], up: [0, 0, 1] };
  let ux = 0, uy = 0, uz = 0;
  for (const s of samples) { ux += s.gx; uy += s.gy; uz += s.gz; }
  let norm = Math.hypot(ux, uy, uz);
  if (norm < 1e-9) { ux = 0; uy = 0; uz = 1; norm = 1; }
  ux /= norm; uy /= norm; uz /= norm;
  const v = new Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    v[i] = s.ax * ux + s.ay * uy + s.az * uz;
    m += v[i];
  }
  m /= n;
  for (let i = 0; i < n; i++) v[i] -= m;
  return { v, up: [ux, uy, uz] };
}

// Linear resample onto a uniform grid — autocorrelation needs even spacing.
function resample(t, v, dtMs) {
  const dur = t[t.length - 1] - t[0];
  // guard: one bad timestamp must not allocate an unbounded array
  if (!Number.isFinite(dur) || dur <= 0) return v.slice();
  const n = Math.max(2, Math.min(2000, Math.floor(dur / dtMs) + 1));
  const out = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[0] + i * dtMs;
    while (j < t.length - 2 && t[j + 1] < ti) j++;
    const span = t[j + 1] - t[j] || 1;
    const f = (ti - t[j]) / span;
    out[i] = v[j] + (v[j + 1] - v[j]) * Math.min(1, Math.max(0, f));
  }
  return out;
}

export function analyze(samples, mode = 'hand') {
  // hr / strideCv / wobble are ADDITIVE fields (null = not measurable this
  // window). Everything already in this shape keeps its meaning and its type.
  const out = {
    // balance is null until enough footfalls are seen to actually split
    // left from right — 0.5 would be an invented "perfectly balanced"
    cadence: 0, bounce: 0, impact: 0, asym: 0, sway: 0, score: 0, moving: false, balance: null,
    hr: null, strideCv: null, wobble: null,
  };
  if (!samples || samples.length < 32) return out;
  const n = samples.length;

  // moving gate: overall gravity-removed accel RMS
  let acc2 = 0;
  for (const s of samples) acc2 += s.ax * s.ax + s.ay * s.ay + s.az * s.az;
  const rmsAll = Math.sqrt(acc2 / n);
  if (!Number.isFinite(rmsAll) || rmsAll < CONFIG.MOVING_RMS) return out; // NaN-permeable gate would fabricate metrics
  out.moving = true;

  const { v, up } = verticalSeries(samples);
  const t = samples.map((s) => s.t);
  // undersampled windows alias into wrong cadences — discard the tick entirely
  const spanS = (t[n - 1] - t[0]) / 1000;
  if (!(spanS > 0) || (n - 1) / spanS < 15) { out.moving = false; return out; }

  const DT = 20; // ms — resample to 50 Hz
  const u = resample(t, v, DT);
  const un = u.length;
  let mu = 0;
  for (const x of u) mu += x;
  mu /= un;
  for (let i = 0; i < un; i++) u[i] -= mu;

  // bounce = RMS of vertical series; impact = max |v| in g
  let s2 = 0, peak = 0;
  for (const x of u) { s2 += x * x; if (Math.abs(x) > peak) peak = Math.abs(x); }
  const rms = Math.sqrt(s2 / un);
  out.bounce = rms;
  out.impact = peak / 9.81;

  // cadence: autocorrelation over the 130–210 spm lag band + parabolic interpolation
  const dtS = DT / 1000;
  const minLag = Math.max(1, Math.ceil(60 / CONFIG.CADENCE_MAX / dtS));   // ceil/floor: round INTO the
  const maxLag = Math.min(un - 2, Math.floor(60 / CONFIG.CADENCE_MIN / dtS)); // 130–210 band, not past it
  let r0 = 0;
  for (const x of u) r0 += x * x;
  if (r0 < 1e-9 || maxLag <= minLag) { out.moving = false; return out; } // degenerate window: discard, don't score 0
  const r = new Array(maxLag + 2).fill(0);
  for (let L = minLag - 1; L <= maxLag + 1 && L < un - 1; L++) {
    let s = 0;
    for (let i = 0; i + L < un; i++) s += u[i] * u[i + L];
    r[L] = s / (un - L);
  }
  let best = minLag;
  for (let L = minLag; L <= maxLag; L++) if (r[L] > r[best]) best = L;
  // parabolic interpolation around the peak → ~1 spm resolution at 25 Hz input
  let delta = 0;
  const ym = r[best - 1], y0 = r[best], yp = r[best + 1];
  const den = ym - 2 * y0 + yp;
  if (best < maxLag && Math.abs(den) > 1e-12) delta = 0.5 * (ym - yp) / den; // r[best+1] may be unwritten at the edge
  if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
  const period = (best + delta) * dtS;
  out.cadence = 60 / period;

  // vertical oscillation (meters, peak-to-peak): treat the vertical series as a
  // sinusoid at step frequency; displacement = accel_amplitude / ω². Feeds the
  // accel-only speed estimate.
  const omega = 2 * Math.PI / period;
  out.vo = (2 * Math.SQRT2 * rms) / (omega * omega);

  // footfalls: local maxima of v above 0.8×RMS, min gap 0.6× step period
  const thr = 0.8 * rms;
  const gap = Math.max(1, Math.floor(0.6 * period / dtS));
  const peaks = []; // uniform-grid indices
  let lastPk = -gap - 1;
  for (let i = 1; i < un - 1; i++) {
    if (u[i] > thr && u[i] >= u[i - 1] && u[i] >= u[i + 1]) {
      if (i - lastPk <= gap) {
        if (u[i] > u[peaks[peaks.length - 1]]) { peaks[peaks.length - 1] = i; lastPk = i; }
        continue;
      }
      peaks.push(i);
      lastPk = i;
    }
  }

  // Sub-sample footfall timing: parabolic fit through each peak's 3 samples.
  // At 25 Hz one sample is 40 ms, so a raw peak index is only ±20 ms — which
  // alone manufactures a ~5–6% stride-time CV before any biology. The vertex of
  // the parabola through (i-1, i, i+1) recovers the peak to a fraction of a
  // sample and drops that floor to ~1.5–2%.
  // FREE BONUS — the same fit yields the interpolated peak HEIGHT, and the
  // asymmetry index below now uses it: discrete sampling used to clip alternate
  // peaks by different amounts and inflate the Robinson index for free.
  const peakT = [], peakH = [];
  for (const i of peaks) {
    const ym = u[i - 1], y0 = u[i], yp = u[i + 1]; // loop bounds guarantee both neighbours exist
    const den2 = ym - 2 * y0 + yp;
    let d = 0;
    if (Math.abs(den2) > 1e-12) d = 0.5 * (ym - yp) / den2;
    if (d > 0.5) d = 0.5; else if (d < -0.5) d = -0.5;
    peakT.push(t[0] + (i + d) * DT);
    peakH.push(y0 - 0.25 * (ym - yp) * d);
  }

  // stride-time variability — see strideStats(): the ABSOLUTE CV is inflated by
  // 25 Hz quantization; only the within-run trend is interpretable.
  out.strideCv = strideStats(peakT).cvPct;

  // asymmetry: alternating odd/even footfall groups, Robinson index of mean peak heights
  if (peaks.length >= 6) {
    let a = 0, ca = 0, b = 0, cb = 0;
    for (let i = 0; i < peaks.length; i++) {
      if (i % 2 === 0) { a += peakH[i]; ca++; } else { b += peakH[i]; cb++; }
    }
    a /= ca; b /= cb;
    const denom = (a + b) / 2;
    if (denom > 1e-9) out.asym = Math.abs(a - b) / denom;
    // Which group is "left" — decided by the sign of lateral acceleration at
    // footstrike. UNCALIBRATED heuristic: needs a deliberate-limp recording to
    // settle which sign is which side. Until then the L/R labels may be swapped.
    const lat = lateralAxis(up);
    let latA = 0;
    for (let i = 0; i < peaks.length; i++) {
      const si = Math.min(n - 1, Math.round((peaks[i] * DT) / ((t[n - 1] - t[0]) / (n - 1))));
      const s = samples[si];
      const l = s.ax * lat[0] + s.ay * lat[1] + s.az * lat[2];
      latA += (i % 2 === 0 ? l : -l);
    }
    const strongIsLeft = latA >= 0; // uncalibrated
    const strong = Math.max(a, b), weak = Math.min(a, b);
    const leftShare = ((a >= b) === strongIsLeft) ? strong / (strong + weak) : weak / (strong + weak);
    out.balance = leftShare;
  }

  // sway (ears mode ONLY — from a hand, arm swing IS the lateral motion)
  if (mode === 'ears') out.sway = swayOf(samples, up);

  // harmonic ratio of the vertical series (null above Nyquist / short windows).
  // Self-baseline only — no published running norms exist. Never cued.
  out.hr = harmonicRatio(samples, out.cadence, 'vertical');

  // head orientation stability — ears mode ONLY. From a hand the "head" angles
  // are the hand's, which says nothing about the neck.
  // The AirPods stream carries an attitude quaternion, so `wobbleSource` should
  // read 'quaternion' in the field. If it reads 'gravity' the number is a
  // degraded-mode readout that over-reads (see headStability) — don't quote it.
  if (mode === 'ears') {
    const hs = headStability(samples);
    if (hs) {
      out.wobble = hs.wobbleDeg;
      out.pitch = hs.pitchDeg;
      out.roll = hs.rollDeg;
      out.wobbleSource = hs.source;
    }
  }

  out.score = formScore(out, mode);
  return out;
}

// Sway = sqrt(λ2/λ1) of the 2×2 horizontal-accel covariance: the cross-track
// fraction of horizontal motion. Frame from the data itself (up = gravity,
// fore = principal axis) — no compass. Exported UNGATED so the calibration
// screen keeps measuring under motion the run-shaped gates would discard.
export function swayOf(samples, up = null) {
  const n = samples.length;
  if (n < 16) return 0;
  if (!up) up = verticalSeries(samples).up;
  const { l1, l2 } = horizontalAxes(horizontalPair(samples, up));
  return l1 > 1e-9 ? Math.sqrt(Math.max(0, l2) / l1) : 0;
}

// Mean-removed horizontal accelerations in a deterministic frame ⊥ up.
// Shared by swayOf and harmonicRatio so both see the same horizontal plane.
function horizontalPair(samples, up) {
  const n = samples.length;
  const e1 = lateralAxis(up), e2 = cross(up, e1);
  const hx = new Array(n), hy = new Array(n);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const du = s.ax * up[0] + s.ay * up[1] + s.az * up[2];
    const rx = s.ax - du * up[0], ry = s.ay - du * up[1], rz = s.az - du * up[2];
    hx[i] = rx * e1[0] + ry * e1[1] + rz * e1[2];
    hy[i] = rx * e2[0] + ry * e2[1] + rz * e2[2];
    mx += hx[i]; my += hy[i];
  }
  mx /= n; my /= n;
  for (let i = 0; i < n; i++) { hx[i] -= mx; hy[i] -= my; }
  return { hx, hy };
}

// Eigendecomposition of the 2×2 horizontal covariance: the principal axis IS
// the direction of travel when running, so `fore` is the anteroposterior series
// and `lat` the mediolateral one — no compass needed. Also returns λ1/λ2 so
// swayOf keeps its exact previous definition.
function horizontalAxes({ hx, hy }) {
  const n = hx.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += hx[i] * hx[i]; sxy += hx[i] * hy[i]; syy += hy[i] * hy[i]; }
  sxx /= n; sxy /= n; syy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr - 4 * det));
  const l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
  let vx, vy;
  if (Math.abs(sxy) > 1e-12) { vx = l1 - syy; vy = sxy; }
  else if (sxx >= syy) { vx = 1; vy = 0; }
  else { vx = 0; vy = 1; }
  const vn = Math.hypot(vx, vy) || 1;
  vx /= vn; vy /= vn;
  const fore = new Array(n), lat = new Array(n);
  for (let i = 0; i < n; i++) {
    fore[i] = hx[i] * vx + hy[i] * vy;
    lat[i] = -hx[i] * vy + hy[i] * vx;
  }
  return { fore, lat, l1, l2 };
}

// --- Harmonic ratio ---------------------------------------------------------
// Bellanca, Lowry, VanSwearingen, Brach & Redfern 2013, "Harmonic ratios: a
// quantification of step to step symmetry" (J Biomech 46:828–831), building on
// Menz, Lord & Fitzpatrick 2003, "Acceleration patterns of the head and pelvis
// when walking on level and irregular surfaces" (Gait & Posture 18:35–46).
//
// One stride = two steps, so the STRIDE frequency f = (spm/60)/2 Hz is the
// fundamental. If the two steps are identical the signal repeats every half
// stride and ALL its energy sits in the EVEN harmonics of f; step-to-step
// asymmetry leaks energy into the ODD harmonics. Hence
//     HR(vertical, anteroposterior) = Σ A_even / Σ A_odd    (higher = smoother)
//     HR(mediolateral)              = Σ A_odd  / Σ A_even
// The mediolateral convention INVERTS because the body sways side to side once
// per stride: there, odd IS the symmetric pattern.
//
// Amplitudes come from a Goertzel bank — one resonator per k·f, no FFT library,
// no power-of-two padding, and exact non-bin frequencies. A Hann window keeps
// the strong even harmonics from leaking into the odd bins we are measuring
// against (it scales every amplitude equally, so the ratio is untouched).
//
// HONESTY: published harmonic-ratio norms are for WALKING, measured at the
// pelvis or trunk. There are NO published running norms, and none at all for a
// single in-ear IMU. The absolute number here means nothing against the
// literature — it is a SELF-BASELINE metric (higher than your own usual =
// smoother, more symmetric than your own usual). It is reported, never cued.
export function harmonicRatio(samples, cadenceSpm, axis = 'vertical') {
  if (!samples || samples.length < 32) return null;
  if (typeof cadenceSpm !== 'number' || !isFinite(cadenceSpm) || cadenceSpm <= 0) return null;
  const f = cadenceSpm / 60 / 2; // stride frequency (Hz)
  if (!(f > 0)) return null;
  const K = CONFIG.HR_HARMONICS;
  if (K * f > CONFIG.HR_NYQUIST_HZ) return null;   // top harmonic is above Nyquist: unmeasurable
  const n = samples.length;
  const t = samples.map((s) => s.t);
  const spanS = (t[n - 1] - t[0]) / 1000;
  if (!Number.isFinite(spanS) || spanS < CONFIG.HR_MIN_WINDOW_S) return null; // too few strides to resolve k·f

  const { v, up } = verticalSeries(samples);
  let raw;
  if (axis === 'vertical') raw = v;
  else {
    const { fore, lat } = horizontalAxes(horizontalPair(samples, up));
    raw = (axis === 'fore' || axis === 'foreaft' || axis === 'anteroposterior') ? fore : lat;
  }
  for (const x of raw) if (!Number.isFinite(x)) return null;

  // uniform grid — Goertzel assumes even spacing
  const DT = 20, fs = 1000 / DT;
  const u = resample(t, raw, DT);
  const N = u.length;
  if (N < 32) return null;
  let mu = 0;
  for (const x of u) mu += x;
  mu /= N;
  const w = new Array(N);
  for (let i = 0; i < N; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    w[i] = (u[i] - mu) * hann;   // mean-removed, per the method
  }

  let even = 0, odd = 0;
  for (let k = 1; k <= K; k++) {
    const a = goertzelAmp(w, k * f, fs);
    if (!Number.isFinite(a)) return null;
    if (k % 2 === 0) even += a; else odd += a;
  }
  const ml = axis === 'lateral' || axis === 'mediolateral';
  const num = ml ? odd : even, den = ml ? even : odd;
  if (!(den > 1e-12)) return null;
  const hr = num / den;
  return Number.isFinite(hr) ? hr : null;
}

// Single-frequency Goertzel resonator → amplitude at fHz. O(N) per frequency,
// which is why a bank of 8 beats an FFT here (and needs no library).
function goertzelAmp(x, fHz, fs) {
  const N = x.length;
  const coeff = 2 * Math.cos((2 * Math.PI * fHz) / fs);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) { s0 = x[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 / N) * Math.sqrt(Math.max(0, power));
}

// --- Stride-time variability ------------------------------------------------
// Meardon, Hamill & Derrick 2011, "Running injury and stride time variability
// over a prolonged run" (Gait & Posture 33:36–40): stride-time CV rises over a
// prolonged run and is higher in runners with an injury history; healthy
// running sits at roughly 1–3%.
//
// A stride is TWO steps — the same foot twice — so stride time is the interval
// between ALTERNATE footfalls, not consecutive ones. CV% = SD/mean × 100.
//
// CRITICAL HONESTY — do not quote the absolute number: at 25 Hz one sample is
// 40 ms. On a ~700 ms stride, timing a peak by its raw sample index quantizes
// to ±20 ms and MANUFACTURES a CV floor of roughly 5–6% out of pure sampling,
// before any biology. The parabolic interpolation in analyze() recovers
// sub-sample peak timing and cuts that floor to about 1.5–2% — still the same
// order as the 1–3% biological signal we are trying to see. So: the ABSOLUTE
// CV this returns is inflated and must never be compared against Meardon's
// numbers. Only the WITHIN-RUN TREND is valid (first quarter vs last quarter —
// see analyzeFatigue in session.js), because the quantization floor is constant
// across a run and cancels out of a comparison.
export function strideStats(peakTimesMs) {
  const p = (peakTimesMs || []).filter((x) => typeof x === 'number' && isFinite(x));
  if (p.length < 4) return { strideMs: null, cvPct: null, n: 0 };
  const iv = [];
  for (let i = 0; i + 2 < p.length; i++) {
    const d = p[i + 2] - p[i];   // alternate footfalls = one stride
    if (d > 0) iv.push(d);
  }
  if (iv.length < 2) return { strideMs: null, cvPct: null, n: iv.length };
  let sum = 0;
  for (const x of iv) sum += x;
  const mean = sum / iv.length;
  if (!(mean > 0)) return { strideMs: null, cvPct: null, n: iv.length };
  let s2 = 0;
  for (const x of iv) s2 += (x - mean) * (x - mean);
  const sd = Math.sqrt(s2 / iv.length);
  return { strideMs: mean, cvPct: (sd / mean) * 100, n: iv.length };
}

// --- Head orientation stability ---------------------------------------------
// Pozzo, Berthoz & Lefort 1990, "Head stabilization during various locomotor
// tasks in humans" (Exp Brain Res 82:97–106): during walking and running the
// head is actively stabilized in space by the vestibulocollic reflex, holding
// pitch and roll within roughly 7° peak-to-peak. Sustained excursions past
// ~10° are a defensible fault (CONFIG.HEAD_WOBBLE_MAX — a calibration knob:
// our measure is an RMS, theirs a peak-to-peak).
//
// Primary path: the AirPods attitude quaternion (samples carrying qw/qx/qy/qz).
// This is the path the real sensor takes — CMDeviceMotion always carries an
// attitude — and the only one whose number means what it says.
// Fallback: the gravity vector alone, which fixes pitch and roll (yaw is
// unobservable from gravity — we do not need it).
// HONESTY ABOUT THE FALLBACK: a raw g* vector is gravity PLUS linear
// acceleration, and during running the stride-band acceleration is the same
// order as g. So the fallback conflates "the head tilted" with "the body
// accelerated" and OVER-READS badly — on synthetic 8 m/s² running it returns
// ~19° where the true tilt is 0°. Low-passing it away would also remove the
// stride-band head motion we are trying to measure, so there is no fix: the
// fallback is a degraded-mode readout, not a measurement. The returned `source`
// field says which path produced the number; trust 'quaternion' only.
// Angles are averaged circularly so a roll near ±180° cannot wrap and fabricate
// a huge RMS. wobbleDeg = sqrt(RMS_pitch² + RMS_roll²) about the window means:
// the combined angular deviation, orientation of the bud in the ear cancelling
// out because it is the MEAN we deviate from, not an absolute zero.
export function headStability(samples) {
  if (!samples || samples.length < 16) return null;
  const pitch = [], roll = [];
  const R = 180 / Math.PI;
  let nQuat = 0;
  for (const s of samples) {
    if (!s) continue;
    let p, r;
    if (typeof s.qw === 'number' && isFinite(s.qw) && typeof s.qx === 'number' &&
        typeof s.qy === 'number' && typeof s.qz === 'number') {
      const nq = Math.hypot(s.qw, s.qx, s.qy, s.qz);
      if (!(nq > 1e-9)) continue;
      const qw = s.qw / nq, qx = s.qx / nq, qy = s.qy / nq, qz = s.qz / nq;
      let sp = 2 * (qw * qy - qz * qx);
      sp = sp > 1 ? 1 : sp < -1 ? -1 : sp;
      p = Math.asin(sp);
      r = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy));
      nQuat++;
    } else if (typeof s.gx === 'number' && typeof s.gy === 'number' && typeof s.gz === 'number' &&
               isFinite(s.gx) && isFinite(s.gy) && isFinite(s.gz)) {
      if (Math.hypot(s.gx, s.gy, s.gz) < 1e-6) continue;
      r = Math.atan2(s.gy, s.gz);
      p = Math.atan2(-s.gx, Math.hypot(s.gy, s.gz));
    } else continue;
    if (!isFinite(p) || !isFinite(r)) continue;
    pitch.push(p * R);
    roll.push(r * R);
  }
  if (pitch.length < 16) return null;
  const ps = angleStats(pitch), rs = angleStats(roll);
  const wobbleDeg = Math.sqrt(ps.rms * ps.rms + rs.rms * rs.rms);
  if (!Number.isFinite(wobbleDeg)) return null;
  return {
    wobbleDeg, pitchDeg: ps.mean, rollDeg: rs.mean,
    source: nQuat >= pitch.length / 2 ? 'quaternion' : 'gravity', // 'gravity' = degraded, over-reads
  };
}

// Circular mean + RMS of wrapped deviations (degrees) — a ±180° wrap must not
// read as a 360° swing.
function angleStats(deg) {
  let sx = 0, sy = 0;
  for (const a of deg) { const r = (a * Math.PI) / 180; sx += Math.cos(r); sy += Math.sin(r); }
  const mean = (Math.atan2(sy, sx) * 180) / Math.PI;
  let s2 = 0;
  for (const a of deg) {
    let d = a - mean;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    s2 += d * d;
  }
  return { mean, rms: Math.sqrt(s2 / deg.length) };
}

// Explainable form score: weighted clamped deductions past each threshold.
// A judge can ask why any score is what it is.
function formScore(m, mode = 'hand') {
  const W = CONFIG.WEIGHTS;
  const dCad = clamp01((CONFIG.CADENCE_FLOOR - m.cadence) / CONFIG.CADENCE_SPREAD);
  const dBounce = clamp01((m.bounce - CONFIG.BOUNCE_MAX) / CONFIG.BOUNCE_SPREAD);
  const dAsym = clamp01((m.asym - CONFIG.ASYM_MAX) / CONFIG.ASYM_SPREAD);
  const dSway = mode === 'ears' ? clamp01((m.sway - CONFIG.SWAY_FALLBACK) / CONFIG.SWAY_SPREAD) : 0;
  return Math.round(100 - W.cadence * dCad - W.bounce * dBounce - W.asym * dAsym - W.sway * dSway);
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Any horizontal unit vector ⊥ up (deterministic).
function lateralAxis(up) {
  const ref = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c = cross(up, ref);
  const n = Math.hypot(c[0], c[1], c[2]) || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

// Cue policy — evidence-based etiquette. Decisions on a ~20-tick trimmed mean,
// not one 6 s window. Silence = good form.
export class Coach {
  constructor(mode = 'hand') {
    this.mode = mode;
    this.t0 = null;                    // first tick — start-of-run mute anchor
    this.hist = { cadence: [], bounce: [], asym: [], sway: [] };
    this.sessionCadence = [];          // per-runner session baseline source
    this.swayHist = [];                // per-runner sway calibration
    this.movingS = 0;
    this.faultSince = {};
    this.lastCueT = -Infinity;
    this.lastFaultT = {};
  }

  smoothed() {
    return {
      cadence: trimmedMean(this.hist.cadence),
      bounce: trimmedMean(this.hist.bounce),
      asym: trimmedMean(this.hist.asym),
      sway: trimmedMean(this.hist.sway),
    };
  }

  update(m, tMs) {
    if (this.t0 === null) this.t0 = tMs;
    if (!m || !m.moving) {
      this.faultSince = {}; // standing still is not a fault building
      return null;
    }
    this.movingS++;
    for (const k of ['cadence', 'bounce', 'asym', 'sway']) {
      const h = this.hist[k];
      h.push(m[k]);
      if (h.length > CONFIG.TRIM_TICKS) h.shift();
    }
    // posture guard: tiltDev (deg off the calibrated neutral) is supplied by
    // the app only when the mode is on AND a Set-level calibration exists
    if (typeof m.tiltDev === 'number' && isFinite(m.tiltDev)) {
      this.hist.tiltDev = this.hist.tiltDev || [];
      this.hist.tiltDev.push(m.tiltDev);
      if (this.hist.tiltDev.length > CONFIG.TRIM_TICKS) this.hist.tiltDev.shift();
    }
    // rolling 5-minute window (300 ticks at 1 Hz): warm-up strides must not
    // push the baseline up and nag a healthy runner for the rest of the run
    this.sessionCadence.push(m.cadence);
    if (this.sessionCadence.length > 300) this.sessionCadence.shift();
    if (this.mode === 'ears') this.swayHist.push(m.sway);

    const sm = this.smoothed();

    // cadence threshold: 95% of own session baseline, floored at 153 (never an
    // absolute 180 target — evidence says relative to your own cadence).
    // MEDIAN of the window: robust to warm-up spikes and cadence outliers.
    // Capped at CADENCE_HEALTHY: fast warm-up strides can hold the window
    // median high for minutes after the runner settles — a runner cruising
    // inside the healthy 170–180 zone must never be nagged to go quicker.
    const base = median(this.sessionCadence);
    const cadThr = Math.max(CONFIG.CADENCE_FLOOR,
      Math.min(CONFIG.CADENCE_BASELINE_FRAC * base, CONFIG.CADENCE_HEALTHY));

    // sway threshold: per-runner mean + 2 SD after 60 moving seconds, capped at
    // the 0.62 fallback; before that, the fallback
    let swayThr = CONFIG.SWAY_FALLBACK;
    if (this.movingS >= CONFIG.SWAY_CALIB_S) {
      const mu = this.swayHist.reduce((s, x) => s + x, 0) / this.swayHist.length;
      const sd = Math.sqrt(this.swayHist.reduce((s, x) => s + (x - mu) * (x - mu), 0) / this.swayHist.length);
      swayThr = Math.min(CONFIG.SWAY_FALLBACK, mu + 2 * sd);
    }

    const active = {
      cadence: sm.cadence < cadThr,
      bounce: sm.bounce > CONFIG.BOUNCE_MAX,
      sway: this.mode === 'ears' && sm.sway > swayThr,
      posture: this.mode === 'ears' && this.hist.tiltDev?.length >= 5 &&
        trimmedMean(this.hist.tiltDev) > CONFIG.TILT_DEV_DEG,
      asymmetry: sm.asym > CONFIG.ASYM_MAX,
    };

    for (const f of PRIORITY) {
      if (!active[f]) delete this.faultSince[f];
      else if (this.faultSince[f] === undefined) this.faultSince[f] = tMs;
    }

    if (tMs - this.t0 < CONFIG.MUTE_MS) return null;          // start-of-run mute
    if (tMs - this.lastCueT < CONFIG.GAP_MS) return null;     // min gap between cues

    for (const f of PRIORITY) {
      if (!active[f]) continue;
      if (tMs - this.faultSince[f] < CONFIG.PERSIST_MS) continue;      // 12 s persistence
      if (tMs - (this.lastFaultT[f] ?? -Infinity) < CONFIG.REPEAT_MS) continue; // 90 s same-fault
      this.lastCueT = tMs;
      this.lastFaultT[f] = tMs;
      return { fault: f, text: CUES[f] };
    }
    return null;
  }
}

// Goal run tracker: a distance goal with a target time, armed for one run.
// Primary signal is GPS distance (kmNow) when fixes are fresh; the fallback is
// a cadence proxy against the runner's own locked baseline. HONESTY: cadence is
// a rhythm/effort proxy, NOT speed — a shorter stride at the same cadence is
// slower and the proxy cannot see it. And GPS accuracy is ±10–30 m with fixes
// arriving at ~1 Hz from watchPosition, so 100 m goals are coarse — treat
// sub-400 m goals as demo-grade; timing precision is bounded by fix cadence.
export class GoalTracker {
  constructor(goalKm, goalS) {
    this.goalKm = goalKm;
    this.goalS = goalS;
    this.actualS = null;         // elapsed seconds when goalKm was reached (null if never)
    this._onPace = true;         // before any evidence, assume on pace
    this._cadSeed = [];          // first GOAL_BASELINE_S moving-tick cadences
    this._baseCad = null;        // locked baseline (median of the seed)
    this._recent = [];           // rolling GOAL_SMOOTH_TICKS cadences
    this._behindClock = 0;       // continuous behind-seconds (paused while not moving)
    this._lastBehindS = null;    // elapsedS of the last behind nudge
    this._fired = { half: false, ninety: false, complete: false };
    this._silenced = false;      // overrun: past goalS*1.10, silent forever
    this._prevKm = null;
    this._lastKmChangeS = null;  // GPS freshness: elapsedS of the last km change
  }

  get onPace() { return this._onPace; }

  // m: analyze() metrics (1 Hz); elapsedS: seconds since run start; kmNow: live
  // GPS distance (the v2 hook is now the primary branch). Returns at most one
  // event per tick: complete > ninety > half > behind.
  tick(m, elapsedS, kmNow = null) {
    if (this._silenced) return null;

    // GPS freshness: the branch is chosen per tick by whether distance moved
    // within the last 10 s
    if (typeof kmNow === 'number' && isFinite(kmNow) && kmNow !== this._prevKm) {
      this._lastKmChangeS = elapsedS;
      this._prevKm = kmNow;
    }
    const gpsLive = typeof kmNow === 'number' && isFinite(kmNow) &&
      this._lastKmChangeS != null && elapsedS - this._lastKmChangeS <= 10;

    // the moment the distance is covered, stamp the actual time (any freshness)
    if (this.actualS == null && typeof kmNow === 'number' && kmNow >= this.goalKm) {
      this.actualS = elapsedS;
    }

    // cadence fallback machinery (kept warm on every moving tick)
    const moving = !!(m && m.moving);
    if (moving && typeof m.cadence === 'number' && isFinite(m.cadence) && m.cadence > 0) {
      if (this._baseCad == null) {
        this._cadSeed.push(m.cadence);
        if (this._cadSeed.length >= CONFIG.GOAL_BASELINE_S) this._baseCad = median(this._cadSeed);
      } else {
        this._recent.push(m.cadence);
        if (this._recent.length > CONFIG.GOAL_SMOOTH_TICKS) this._recent.shift();
      }
    }

    // on-pace + behind clock for the active branch
    let behindWindowS;
    if (gpsLive) {
      const required = this.goalKm / this.goalS; // km/s
      const behindKm = elapsedS * required - kmNow;
      const thr = Math.max(CONFIG.GOAL_BEHIND_KM_MIN, CONFIG.GOAL_BEHIND_FRAC * this.goalKm);
      this._onPace = behindKm <= thr;
      behindWindowS = CONFIG.GOAL_BEHIND_S;
    } else {
      // cadence proxy: on pace until the baseline locks; after, rolling
      // trimmed mean vs 97% of own baseline
      this._onPace = this._baseCad == null || this._recent.length === 0 ||
        trimmedMean(this._recent) >= CONFIG.GOAL_ONPACE_FRAC * this._baseCad;
      behindWindowS = CONFIG.GOAL_CADENCE_BEHIND_S;
    }
    if (moving) this._behindClock = this._onPace ? 0 : this._behindClock + 1;
    // not moving: the clock PAUSES (neither grows nor resets)

    // no live GPS this tick: fall back to time-based completion against the
    // target (the cadence proxy cannot measure distance)
    if (!gpsLive && this.actualS == null && elapsedS >= this.goalS) this.actualS = elapsedS;

    // ---- events, highest priority first ----
    // complete: distance covered inside the overrun allowance
    if (!this._fired.complete && this.actualS != null &&
        this.actualS <= this.goalS * (1 + CONFIG.GOAL_OVERRUN_FRAC)) {
      this._fired.complete = this._fired.ninety = this._fired.half = true;
      return { event: 'complete', actualS: this.actualS };
    }

    // milestones: by DISTANCE when GPS is live, by time in the cadence fallback
    const frac = gpsLive ? kmNow / this.goalKm : elapsedS / this.goalS;
    if (!this._fired.ninety && frac >= CONFIG.GOAL_MILESTONES[1]) {
      this._fired.ninety = this._fired.half = true;
      return { event: 'ninety' };
    }
    if (!this._fired.half && frac >= CONFIG.GOAL_MILESTONES[0]) {
      this._fired.half = true;
      return { event: 'half' };
    }

    // overrun: past goalS*1.10 with the goal not completed — silent forever
    if (elapsedS > this.goalS * (1 + CONFIG.GOAL_OVERRUN_FRAC)) {
      this._silenced = true;
      return null;
    }

    // behind nudge: continuous behind-seconds + minimum gap between nudges
    if (this._behindClock >= behindWindowS &&
        (this._lastBehindS == null || (elapsedS - this._lastBehindS) * 1000 >= CONFIG.GOAL_NUDGE_GAP_MS)) {
      this._lastBehindS = elapsedS;
      this._behindClock = 0;
      return { event: 'behind' };
    }
    return null;
  }
}
