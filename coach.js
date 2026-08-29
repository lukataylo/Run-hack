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
  BOUNCE_MAX: 10.5,            // m/s² RMS ≈ Garmin orange vertical oscillation
  ASYM_MAX: 0.10,              // Robinson index
  SWAY_FALLBACK: 0.62,         // eigenratio fallback until per-runner calibration
  SWAY_CALIB_S: 60,            // moving seconds before per-runner sway threshold
  MOVING_RMS: 3,               // m/s² — below this: not running, no metrics, no cues
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
};

export const CUES = {
  cadence: 'Quicker feet. Shorten your stride.',
  bounce: 'Too much bounce. Run softer, drive forward.',
  asymmetry: "You're favouring one side. Even it out.",
  sway: 'Your head is rocking. Eyes forward, run tall.',
};

// priority order for cue selection (asymmetry ALWAYS lowest — RCT: doesn't predict injury)
const PRIORITY = ['cadence', 'bounce', 'sway', 'asymmetry'];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function trimmedMean(arr, frac = 0.1) {
  const n = arr.length;
  if (n === 0) return 0;
  if (n < 4) return arr.reduce((s, x) => s + x, 0) / n;
  const a = arr.slice().sort((x, y) => x - y);
  const k = Math.floor(n * frac);
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
  const n = Math.max(2, Math.floor(dur / dtMs) + 1);
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
  const out = { cadence: 0, bounce: 0, impact: 0, asym: 0, sway: 0, score: 0, moving: false, balance: 0.5 };
  if (!samples || samples.length < 32) return out;
  const n = samples.length;

  // moving gate: overall gravity-removed accel RMS
  let acc2 = 0;
  for (const s of samples) acc2 += s.ax * s.ax + s.ay * s.ay + s.az * s.az;
  if (Math.sqrt(acc2 / n) < CONFIG.MOVING_RMS) return out;
  out.moving = true;

  const { v, up } = verticalSeries(samples);
  const t = samples.map((s) => s.t);

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
  const minLag = Math.max(1, Math.floor(60 / CONFIG.CADENCE_MAX / dtS));
  const maxLag = Math.min(un - 2, Math.ceil(60 / CONFIG.CADENCE_MIN / dtS));
  let r0 = 0;
  for (const x of u) r0 += x * x;
  if (r0 < 1e-9 || maxLag <= minLag) return out;
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
  if (Math.abs(den) > 1e-12) delta = 0.5 * (ym - yp) / den;
  if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
  const period = (best + delta) * dtS;
  out.cadence = 60 / period;

  // footfalls: local maxima of v above 0.8×RMS, min gap 0.6× step period
  const thr = 0.8 * rms;
  const gap = Math.max(1, Math.floor(0.6 * period / dtS));
  const peaks = []; // uniform-grid indices
  let lastPk = -gap - 1;
  for (let i = 1; i < un - 1; i++) {
    if (u[i] > thr && u[i] >= u[i - 1] && u[i] >= u[i + 1]) {
      if (i - lastPk <= gap) {
        if (peaks.length && u[i] > u[peaks[peaks.length - 1]]) { peaks[peaks.length - 1] = i; lastPk = i; }
        continue;
      }
      peaks.push(i);
      lastPk = i;
    }
  }

  // asymmetry: alternating odd/even footfall groups, Robinson index of mean peak heights
  if (peaks.length >= 6) {
    let a = 0, ca = 0, b = 0, cb = 0;
    for (let i = 0; i < peaks.length; i++) {
      if (i % 2 === 0) { a += u[peaks[i]]; ca++; } else { b += u[peaks[i]]; cb++; }
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

  // sway (ears mode ONLY — from a hand, arm swing IS the lateral motion):
  // frame from the data itself: up = gravity; fore = principal axis of the 2×2
  // horizontal covariance; sway = sqrt(λ2/λ1) = cross-track fraction. No compass.
  if (mode === 'ears') {
    const e1 = lateralAxis(up);
    const e2 = cross(up, e1);
    let sxx = 0, sxy = 0, syy = 0, mx = 0, my = 0;
    const hx = new Array(n), hy = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const du = s.ax * up[0] + s.ay * up[1] + s.az * up[2];
      const rx = s.ax - du * up[0], ry = s.ay - du * up[1], rz = s.az - du * up[2];
      hx[i] = rx * e1[0] + ry * e1[1] + rz * e1[2];
      hy[i] = rx * e2[0] + ry * e2[1] + rz * e2[2];
      mx += hx[i]; my += hy[i];
    }
    mx /= n; my /= n;
    for (let i = 0; i < n; i++) {
      const x = hx[i] - mx, y = hy[i] - my;
      sxx += x * x; sxy += x * y; syy += y * y;
    }
    sxx /= n; sxy /= n; syy /= n;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, tr * tr - 4 * det));
    const l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
    if (l1 > 1e-9) out.sway = Math.sqrt(Math.max(0, l2) / l1);
  }

  out.score = formScore(out, mode);
  return out;
}

// Explainable form score: weighted clamped deductions past each threshold.
// A judge can ask why any score is what it is.
export function formScore(m, mode = 'hand') {
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
    this.sessionCadence.push(m.cadence);
    if (this.mode === 'ears') this.swayHist.push(m.sway);

    const sm = this.smoothed();

    // cadence threshold: 95% of own session baseline, floored at 153 (never an
    // absolute 180 target — evidence says relative to your own cadence)
    const base = trimmedMean(this.sessionCadence);
    const cadThr = Math.max(CONFIG.CADENCE_FLOOR, CONFIG.CADENCE_BASELINE_FRAC * base);

    // sway threshold: per-runner mean + 2 SD after 60 moving seconds, capped at
    // the 0.62 fallback; before that, the fallback
    let swayThr = CONFIG.SWAY_FALLBACK;
    if (this.movingS >= CONFIG.SWAY_CALIB_S && this.swayHist.length >= CONFIG.SWAY_CALIB_S) {
      const mu = this.swayHist.reduce((s, x) => s + x, 0) / this.swayHist.length;
      const sd = Math.sqrt(this.swayHist.reduce((s, x) => s + (x - mu) * (x - mu), 0) / this.swayHist.length);
      swayThr = Math.min(CONFIG.SWAY_FALLBACK, mu + 2 * sd);
    }

    const active = {
      cadence: sm.cadence < cadThr,
      bounce: sm.bounce > CONFIG.BOUNCE_MAX,
      sway: this.mode === 'ears' && sm.sway > swayThr,
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
