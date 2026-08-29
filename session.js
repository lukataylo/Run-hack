// session.js — GPS distance, per-second timeline, telemetry beacon, per-runner
// run history, Insights rendering (Track C). Browser ES module, zero deps.

const TELEMETRY_INTERVAL_MS = 10000;
const MAX_RUNS_KEPT = 20;
const GPS_MAX_ACCURACY_M = 30; // ignore fixes worse than this
const GPS_MAX_JUMP_M = 50;     // ignore teleports
const GPS_MIN_STEP_M = 2;      // ignore sub-2 m per-fix movements (standstill drift)

// ---------- helpers ----------

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function runnerNum(user) {
  // user may be 1|2|3 or "Runner 2" — telemetry endpoint wants 1..3
  const m = String(user == null ? 1 : user).match(/[123]/);
  return m ? Number(m[0]) : 1;
}

function storageKey(user) { return `runs:${user}`; }

function avgOf(timeline, key) {
  let sum = 0, n = 0;
  for (const e of timeline) {
    const v = e && e[key];
    if (typeof v === 'number' && isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : null;
}

// ---------- run-level fatigue analysis ----------

// Computed once at stop() from the 1 Hz timeline and stored as run.fatigue.
// Every field is null when the run cannot support it — a 6-minute run has no
// fatigue story and this must say so rather than invent one.
//
//   cadenceSlopePer10Min — Hunter & Smith 2007, "Preferred and optimal stride
//     frequency, stiffness and economy: changes with fatigue during a 1-h
//     high-intensity run" (Eur J Appl Physiol 100:653–661): stride frequency
//     drifts DOWN as a runner fatigues. The red flag is a falling cadence AT
//     CONSTANT PACE — this number cannot see pace, so read it beside km/estKmh.
//   onsetS — first second at which a trailing 3-minute mean of cadence departs
//     by more than 2 SD from the first-10-minute baseline.
//   cvTrendPct — last-quarter vs first-quarter stride-time CV. Meardon 2011:
//     stride-time variability rises over a prolonged run. TREND ONLY: the
//     absolute CV is inflated by 25 Hz quantization (see coach.strideStats).
//   impactDriftPct — last-quarter vs first-quarter HEAD IMPACT. Derrick 2002
//     ("Energy absorption of impacts during running at various stride lengths")
//     and the shock-attenuation literature: the head's impact acceleration is
//     REGULATED to stay roughly constant while tibial impact varies, so an
//     upward drift at the head is a real signal that the regulation is failing.
//     Call this "head impact drift". It is NOT shock attenuation — shock
//     attenuation is a tibia-to-head TRANSFER RATIO and needs a second sensor
//     on the shank, which we do not have. Never label it that.
//   pitchDropDeg — last-quarter minus first-quarter mean head pitch (degrees):
//     the head dropping as the run wears on. Null unless the app fed pitch into
//     tick() (coach.analyze supplies it in ears mode with a real quaternion).
export function analyzeFatigue(timeline) {
  const out = {
    cadenceSlopePer10Min: null,
    onsetS: null,
    cvTrendPct: null,
    impactDriftPct: null,
    pitchDropDeg: null,
  };
  const tl = Array.isArray(timeline) ? timeline : [];
  if (!tl.length) return out;

  // cadence points, sorted, positive-only (a 0 means "not measured", not "slow")
  const pts = [];
  for (const e of tl) {
    if (!e) continue;
    if (typeof e.t !== 'number' || !isFinite(e.t)) continue;
    if (typeof e.cadence !== 'number' || !isFinite(e.cadence) || e.cadence <= 0) continue;
    pts.push([e.t, e.cadence]);
  }
  pts.sort((a, b) => a[0] - b[0]);

  // least-squares slope, scaled to spm per 10 minutes
  if (pts.length >= 30) {
    let st = 0, sv = 0;
    for (const [t, v] of pts) { st += t; sv += v; }
    const mt = st / pts.length, mv = sv / pts.length;
    let sn = 0, sd = 0;
    for (const [t, v] of pts) { sn += (t - mt) * (v - mv); sd += (t - mt) * (t - mt); }
    if (sd > 1e-9) {
      const per10 = (sn / sd) * 600;
      if (Number.isFinite(per10)) out.cadenceSlopePer10Min = per10;
    }
  }

  // fatigue onset: 10-minute baseline, then a trailing 3-minute mean crossing 2 SD
  const BASE_S = 600, WIN_S = 180, MIN_RUN_S = 720;
  const lastT = pts.length ? pts[pts.length - 1][0] : 0;
  if (pts.length && lastT >= MIN_RUN_S) {
    const base = [];
    for (const [t, v] of pts) { if (t <= BASE_S) base.push(v); }
    if (base.length >= 60) {
      const bm = base.reduce((s, x) => s + x, 0) / base.length;
      let b2 = 0;
      for (const x of base) b2 += (x - bm) * (x - bm);
      const bsd = Math.sqrt(b2 / base.length);
      // a perfectly flat baseline has no scale to test against — say null, not "onset at second one"
      if (bsd > 1e-6) {
        let lo = 0, hi = 0, sum = 0, cnt = 0;
        for (let t = BASE_S + WIN_S; t <= lastT; t++) {
          while (hi < pts.length && pts[hi][0] <= t) { sum += pts[hi][1]; cnt++; hi++; }
          while (lo < hi && pts[lo][0] < t - WIN_S) { sum -= pts[lo][1]; cnt--; lo++; }
          if (cnt < WIN_S * 0.5) continue;          // a sparse window is not evidence
          if (Math.abs(sum / cnt - bm) > 2 * bsd) { out.onsetS = t; break; }
        }
      }
    }
  }

  out.cvTrendPct = quarterDriftPct(tl, 'strideCv');
  out.impactDriftPct = quarterDriftPct(tl, 'impact');
  out.pitchDropDeg = quarterDelta(tl, 'pitch');
  return out;
}

// Last-quarter mean minus first-quarter mean, as a % of the first-quarter mean.
function quarterDriftPct(timeline, key) {
  const q = quarters(timeline, key);
  if (!q) return null;
  if (!(Math.abs(q.first) > 1e-9)) return null;
  const pct = ((q.last - q.first) / Math.abs(q.first)) * 100;
  return Number.isFinite(pct) ? pct : null;
}

// Same split, absolute units (degrees) — a % of an angle whose zero is arbitrary
// would be meaningless.
function quarterDelta(timeline, key) {
  const q = quarters(timeline, key);
  if (!q) return null;
  const d = q.last - q.first;
  return Number.isFinite(d) ? d : null;
}

function quarters(timeline, key) {
  const vals = [];
  for (const e of timeline || []) {
    const v = e && e[key];
    if (typeof v === 'number' && isFinite(v)) vals.push(v);
  }
  if (vals.length < 8) return null;   // fewer than 2 per quarter is noise, not a trend
  const q = Math.max(1, Math.floor(vals.length / 4));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  return { first: mean(vals.slice(0, q)), last: mean(vals.slice(-q)) };
}

// ---------- Session ----------

export class Session {
  constructor(mode, user) {
    this.mode = mode || 'hand';
    this.user = user == null ? 1 : user;
    this.startedAt = Date.now();
    this.timeline = [];
    this.cues = [];
    this.km = 0;
    this.stopped = false;
    // route trace: accepted fixes kept as [tSec, lat, lon, altOrNull] so a run
    // can be drawn afterwards. Without this the geometry is gone forever — the
    // fixes were previously consumed for distance and discarded.
    this.track = [];
    this._lastFix = null;
    this._watchId = null;
    this._startGPS();
    this._beaconTimer = setInterval(() => this._beacon(), TELEMETRY_INTERVAL_MS);
  }

  _startGPS() {
    try {
      if (!navigator.geolocation) return;
      this._watchId = navigator.geolocation.watchPosition(
        (pos) => {
          try {
            const c = pos.coords;
            // accuracy must be a finite number <= threshold — NaN/undefined
            // fails this comparison and the fix is rejected
            if (!(c.accuracy <= GPS_MAX_ACCURACY_M)) return;
            if (this._lastFix) {
              const d = haversineM(this._lastFix.latitude, this._lastFix.longitude,
                c.latitude, c.longitude);
              if (d > GPS_MAX_JUMP_M) { this._lastFix = c; return; }
              // GPS_MIN_STEP_M: drift at a standstill must not accrue distance
              // (calibration knob — raise if standing drift still creeps in)
              if (d < GPS_MIN_STEP_M) return;
              this.km += d / 1000;
            }
            this._lastFix = c;
            // ~4 dp ≈ 11 m of precision is plenty for a drawn route and keeps
            // an hour-long run's trace well under the localStorage budget
            this.track.push([
              Math.round((Date.now() - this.startedAt) / 1000),
              Math.round(c.latitude * 1e5) / 1e5,
              Math.round(c.longitude * 1e5) / 1e5,
              typeof c.altitude === 'number' && isFinite(c.altitude) ? Math.round(c.altitude) : null,
            ]);
          } catch { /* a bad fix must never touch the run */ }
        },
        () => { /* GPS denied/unavailable: distance stays 0, run continues */ },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
    } catch { /* no geolocation at all */ }
  }

  // Arm a distance+time goal for this run. Counters feed the saved run's
  // onPacePct; actual completion time is stamped in tick() when km crosses.
  setGoal(goalKm, goalS) {
    this._goalKm = goalKm;
    this._goalS = goalS;
    this._goalTicks = 0;
    this._goalOn = 0;
    this._goalActualS = null; // elapsed s when goalKm was covered (null if never)
  }

  // Called at 1 Hz with {cadence, bounce, impact, asym, sway, score, moving[, goalOnPace]}
  tick(metrics) {
    if (this.stopped) return;
    const m = metrics || {};
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const asym = num(m.asym);
    const balance = num(m.balance);
    let onPace = null;
    if (this._goalS && m.moving) {
      this._goalTicks++;
      onPace = m.goalOnPace ? 1 : 0;
      if (m.goalOnPace) this._goalOn++;
    }
    if (this._goalKm && this._goalActualS == null && this.km >= this._goalKm) {
      // HONESTY: GPS accuracy is ±10–30 m and watchPosition fixes arrive at
      // ~1 Hz, so this stamp is coarse — sub-400 m goals are demo-grade.
      this._goalActualS = Math.round((Date.now() - this.startedAt) / 1000);
    }
    this.timeline.push({
      onPace,
      t: Math.round((Date.now() - this.startedAt) / 1000),
      cadence: num(m.cadence),
      bounce: num(m.bounce),
      impact: num(m.impact),
      asym,
      sway: num(m.sway),
      estKmh: num(m.estKmh), // accel-only speed estimate (GPS-independent)
      // literature-backed additions (all num()-guarded — null = not measurable
      // this second, which is normal: hr is null above Nyquist, wobble is null
      // outside ears mode, strideCv is null when too few footfalls landed).
      hr: num(m.hr),            // harmonic ratio, vertical — SELF-BASELINE only
      strideCv: num(m.strideCv), // stride-time CV% — TREND only, absolute inflated at 25 Hz
      wobble: num(m.wobble),    // head pitch/roll RMS (deg), ears mode
      pitch: num(m.pitch),      // mean head pitch (deg) — feeds fatigue pitchDropDeg
      score: num(m.score),
      // prefer the analyzer's real balance (left share 0..1) when present;
      // fall back to the asymmetry-split heuristic (uncalibrated L/R labels).
      balL: balance != null ? Math.round(balance * 100)
        : asym == null ? null : Math.round(50 - asym * 50),
    });
  }

  logCue(cue) {
    if (!cue) return;
    this.cues.push({
      fault: cue.fault || 'unknown',
      text: cue.text || '',
      t: typeof cue.t === 'number' ? cue.t
        : Math.round((Date.now() - this.startedAt) / 1000),
    });
  }

  _beacon() {
    // Fire and forget: never throw, never block, a dead spot never touches the run.
    try {
      const snap = JSON.stringify({
        user: this.user,
        mode: this.mode,
        km: Math.round(this.km * 1000) / 1000,
        cues: this.cues.slice(-5),
        timeline: this.timeline.slice(-12),
        t: Date.now(),
      });
      const url = `/telemetry/${runnerNum(this.user)}`;
      let sent = false;
      if (navigator.sendBeacon) {
        try { sent = navigator.sendBeacon(url, new Blob([snap], { type: 'application/json' })); }
        catch { sent = false; }
      }
      if (!sent) {
        fetch(url, { method: 'POST', body: snap, keepalive: true }).catch(() => {});
      }
    } catch { /* never */ }
  }

  stop() {
    if (this.stopped) return this._run;
    this.stopped = true;
    clearInterval(this._beaconTimer);
    try {
      if (this._watchId != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(this._watchId);
      }
    } catch { /* fine */ }
    this._beacon(); // final snapshot

    const tl = this.timeline;
    // fatigue analysis must never be the reason a run fails to save
    let fatigue = null;
    try { fatigue = analyzeFatigue(tl); } catch { fatigue = null; }
    const run = {
      id: `run-${this.startedAt}-${Math.random().toString(36).slice(2, 7)}`,
      user: this.user,
      mode: this.mode,
      startedAt: this.startedAt,
      duration: Math.round((Date.now() - this.startedAt) / 1000),
      km: Math.round(this.km * 1000) / 1000,
      timeline: tl,
      track: this.track,
      cues: this.cues,
      avg: {
        cadence: avgOf(tl, 'cadence'),
        bounce: avgOf(tl, 'bounce'),
        impact: avgOf(tl, 'impact'),
        asym: avgOf(tl, 'asym'),
        sway: avgOf(tl, 'sway'),
        hr: avgOf(tl, 'hr'),
        strideCv: avgOf(tl, 'strideCv'),
        wobble: avgOf(tl, 'wobble'),
      },
      // run-level fatigue story — computed once, here, from the whole timeline
      fatigue,
      score: avgOf(tl, 'score') == null ? null : Math.round(avgOf(tl, 'score')),
    };
    if (this._goalS != null) {
      run.goalKm = this._goalKm;
      run.goalS = this._goalS;
      run.actualS = this._goalActualS; // when the distance was covered; null if never
      // met = covered the goal distance within the 10% overrun allowance;
      // ending the run before reaching the distance is a miss
      run.metGoal = this._goalActualS != null && this._goalActualS <= this._goalS * 1.10;
      run.onPacePct = this._goalTicks ? Math.round((this._goalOn / this._goalTicks) * 100) : null;
    }
    this._run = run;
    try {
      const key = storageKey(this.user);
      // the seeded demo run is never persisted and never counts against the cap
      const runs = loadRuns(this.user).filter((r) => r.id !== 'demo');
      runs.unshift(run);
      const keep = runs.slice(0, MAX_RUNS_KEPT);
      try {
        localStorage.setItem(key, JSON.stringify(keep));
      } catch (e) {
        // quota: strip heavy timelines from all but the 2 newest runs and retry
        // once (avg/score/cues/km/duration survive, so history stays useful)
        if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
          const slim = keep.map((r, i) => {
            if (i < 2) return r;
            const { timeline, ...rest } = r;
            return rest;
          });
          localStorage.setItem(key, JSON.stringify(slim));
        } else {
          throw e;
        }
      }
    } catch { /* quota/private mode: the run object is still returned */ }
    return run;
  }
}

// ---------- history ----------

// Generic demo run so Insights/history never open empty for a fresh profile.
// Synthesized on the fly (never persisted, never counts against the run cap)
// and dropped from the list once the runner has 3+ real runs.
function demoRun(user) {
  const durS = 1500; // ~25 min
  const timeline = [];
  for (let t = 0; t <= durS; t += 5) {
    const w = t / durS;
    timeline.push({
      t,
      cadence: Math.round(168 + 4 * Math.sin(t / 47) + 2 * Math.sin(t / 13)),
      bounce: Math.round((7 + 0.6 * Math.sin(t / 31)) * 10) / 10,
      impact: Math.round((1.6 + 0.25 * Math.sin(t / 23)) * 100) / 100,
      asym: Math.round((0.05 + 0.02 * Math.sin(t / 61)) * 1000) / 1000,
      sway: null,
      score: Math.round(84 + 4 * Math.sin(t / 53) - 3 * w * Math.sin(t / 17)),
      balL: 51,
    });
  }
  return {
    id: 'demo',
    user,
    mode: 'hand',
    startedAt: Date.now() - 24 * 3600 * 1000, // yesterday
    duration: durS,
    km: 3.8,
    timeline,
    cues: [
      { fault: 'cadence', text: 'Quicker feet. Shorten your stride.', t: 430 },
      { fault: 'bounce', text: 'Too much bounce. Run softer, drive forward.', t: 1040 },
    ],
    avg: { cadence: 168, bounce: 7.0, impact: 1.6, asym: 0.05, sway: null },
    score: 84,
  };
}

export function loadRuns(user) {
  const u = user == null ? 1 : user;
  let runs = [];
  try {
    const raw = localStorage.getItem(storageKey(u));
    const arr = JSON.parse(raw || '[]');
    runs = Array.isArray(arr) ? arr.filter((r) => r && r.id) : [];
  } catch {
    runs = [];
  }
  // seed the sample run (oldest position) until the runner has 3+ real runs
  try {
    if (runs.filter((r) => r.id !== 'demo').length < 3) runs = [...runs, demoRun(u)];
  } catch { /* the demo must never break real history */ }
  return runs;
}

// ---------- Insights rendering ----------

const FAULT_META = {
  cadence: { eyebrow: 'OVERSTRIDE', headline: 'Fixing overstride is your fastest win.', focus: 'Quicker feet, shorter stride' },
  bounce: { eyebrow: 'BOUNCE', headline: 'Softer landings will save your legs.', focus: 'Run softer, drive forward' },
  asymmetry: { eyebrow: 'BALANCE', headline: 'Evening out your stride is your fastest win.', focus: 'Even out left and right' },
  sway: { eyebrow: 'HEAD SWAY', headline: 'A steadier head will sharpen your form.', focus: 'Eyes forward, run tall' },
};

function dominantFault(run) {
  const counts = {};
  for (const c of (run.cues || [])) counts[c.fault] = (counts[c.fault] || 0) + 1;
  let best = null, bestN = 0;
  for (const [f, n] of Object.entries(counts)) if (n > bestN) { best = f; bestN = n; }
  return best;
}

function fmtDuration(s) {
  if (typeof s !== 'number' || !isFinite(s)) return '–';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(s) {
  const m = Math.floor((s || 0) / 60), sec = Math.floor((s || 0) % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// "400 m" below 1 km, "5 km" at/above — for the goal summary cell
function fmtDist(km) {
  if (typeof km !== 'number' || !isFinite(km)) return '–';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  const v = Math.round(km * 100) / 100;
  return `${v} km`;
}

// Sub-line of the goal summary cell. Old runs may lack goalKm/actualS — render
// what exists rather than blanking the cell.
function goalCellSub(run) {
  const target = fmtClock(run.goalS);
  if (run.goalKm == null) return `${target} target`;
  if (run.actualS != null) return `${fmtDist(run.goalKm)} in ${fmtClock(run.actualS)} vs ${target} target`;
  return `${fmtDist(run.goalKm)} · ${target} target · not reached`;
}

function series(run, key) {
  return (run.timeline || [])
    .filter((e) => e && typeof e[key] === 'number' && isFinite(e[key]))
    .map((e) => ({ t: e.t || 0, v: e[key] }));
}

// % delta chip vs previous run; goodWhenLower flips the color logic.
function deltaChip(cur, prev, goodWhenLower) {
  if (cur == null || prev == null || !isFinite(prev) || prev === 0) return '';
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return '';
  const good = goodWhenLower ? pct < 0 : pct > 0;
  const sign = pct > 0 ? '+' : '−';
  return `<span class="si-chip ${good ? 'si-chip-good' : 'si-chip-warn'}">${sign}${Math.abs(pct)}% <small>vs last run</small></span>`;
}

// Prepare a canvas at its CSS-laid-out size (caller guarantees visibility).
function prepCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(50, rect.width), h = Math.max(40, rect.height);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawAreaChart(canvas, pts, color) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!pts.length) return drawEmpty(ctx, w, h);
  const pad = 4;
  const tMax = Math.max(pts[pts.length - 1].t, 1);
  const vMax = Math.max(...pts.map((p) => p.v), 0.001) * 1.15;
  const x = (t) => pad + (t / tMax) * (w - pad * 2);
  const y = (v) => h - pad - (v / vMax) * (h - pad * 2);

  // subtle horizontal gridlines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const gy = pad + ((h - pad * 2) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(w - pad, gy); ctx.stroke();
  }

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '66');
  grad.addColorStop(1, color + '05');
  ctx.beginPath();
  ctx.moveTo(x(pts[0].t), y(pts[0].v));
  for (const p of pts) ctx.lineTo(x(p.t), y(p.v));
  ctx.lineTo(x(pts[pts.length - 1].t), h - pad);
  ctx.lineTo(x(pts[0].t), h - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(pts[0].t), y(pts[0].v));
  for (const p of pts) ctx.lineTo(x(p.t), y(p.v));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawBarChart(canvas, pts, color) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!pts.length) return drawEmpty(ctx, w, h);
  // bucket the timeline into ~24 bars
  const nBars = Math.min(24, Math.max(6, pts.length));
  const per = pts.length / nBars;
  const bars = [];
  for (let i = 0; i < nBars; i++) {
    const slice = pts.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1));
    bars.push(slice.reduce((s, p) => s + p.v, 0) / slice.length);
  }
  const pad = 4;
  const vMax = Math.max(...bars) * 1.1 || 1;
  const vMin = Math.min(...bars) * 0.85;
  const bw = (w - pad * 2) / nBars;
  for (let i = 0; i < nBars; i++) {
    const bh = Math.max(3, ((bars[i] - vMin) / (vMax - vMin || 1)) * (h - pad * 2));
    ctx.fillStyle = i % 3 === 1 ? color : color + '55'; // reference: mixed strong/dim bars
    const bx = pad + i * bw + bw * 0.18;
    const by = h - pad - bh;
    const bwidth = bw * 0.64;
    const r = Math.min(3, bwidth / 2);
    ctx.beginPath();
    ctx.moveTo(bx, by + r);
    ctx.arcTo(bx, by, bx + bwidth, by, r);
    ctx.arcTo(bx + bwidth, by, bx + bwidth, h - pad, r);
    ctx.lineTo(bx + bwidth, h - pad);
    ctx.lineTo(bx, h - pad);
    ctx.closePath();
    ctx.fill();
  }
}

function drawLineChart(canvas, rawPts, color) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!rawPts.length) return drawEmpty(ctx, w, h);
  // light EMA so 1 Hz noise reads as a trend line
  let ema = rawPts[0].v;
  const pts = rawPts.map((p) => ({ t: p.t, v: (ema = ema * 0.8 + p.v * 0.2) }));
  const pad = 4;
  const tMax = Math.max(pts[pts.length - 1].t, 1);
  // min-max scaling: sway values live in a narrow band, zero-based looks flat
  const vs = pts.map((p) => p.v);
  const vMin = Math.min(...vs), vMax = Math.max(...vs);
  const span = (vMax - vMin) || 1;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const px = pad + (p.t / tMax) * (w - pad * 2);
    const py = h - pad - ((p.v - vMin) / span) * (h - pad * 2) * 0.8 - (h - pad * 2) * 0.1;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// ---------- "Did the coaching work?" (response-to-cue) ----------

// Which timeline series each fault is about, and which direction is BETTER.
// posture has two possible sources: the head-orientation metric (wobble) or the
// app's calibrated tilt deviation (tiltDev) — take whichever the run recorded.
const CUE_METRIC = {
  cadence:   { keys: ['cadence'], goodWhenLower: false, label: 'cadence',   unit: 'spm' },
  bounce:    { keys: ['bounce'],  goodWhenLower: true,  label: 'bounce',    unit: 'm/s²' },
  asymmetry: { keys: ['asym'],    goodWhenLower: true,  label: 'asymmetry', unit: '' },
  sway:      { keys: ['sway'],    goodWhenLower: true,  label: 'head sway', unit: '' },
  posture:   { keys: ['wobble', 'tiltDev'], goodWhenLower: true, label: 'posture', unit: '°' },
};

// Windows, in seconds around the cue. The 30–90 s response window is the
// motor-learning consolidation window already cited in COACHING.md: a gait
// correction takes ~300 strides (~90 s at 170–200 spm) to land, so measuring
// the first 30 s would measure the runner reacting, not the correction holding.
export const COACHABILITY = {
  BASELINE_S: 60,    // window before the cue: what the runner was doing
  AFTER_S: 120,      // window drawn after the cue
  RESP_FROM_S: 30,   // consolidation window opens
  RESP_TO_S: 90,     // consolidation window closes (~300 strides)
  MIN_PTS: 5,        // fewer samples than this either side is not evidence
  MIN_PCT: 1.5,      // below this the response reads as "no change", not a win
};

const meanV = (a) => a.reduce((s, p) => s + p.v, 0) / a.length;

// PURE — no DOM, no globals. Score one cue's aftermath against its own
// baseline. Returns null when this run cannot answer the question at all
// (unknown fault, no timestamp, the cued metric was never recorded).
// deltaPct is signed in the IMPROVING direction for that fault, so positive
// always means "better" regardless of which way the raw metric moved.
export function scoreCueResponse(timeline, cue) {
  const meta = cue && CUE_METRIC[cue.fault];
  if (!meta) return null;                                    // unknown fault: skip this cue
  const cueT = cue && typeof cue.t === 'number' && isFinite(cue.t) ? cue.t : null;
  if (cueT == null) return null;
  const tl = Array.isArray(timeline) ? timeline : [];

  // pick the first candidate key this run actually recorded
  let key = null;
  for (const k of meta.keys) {
    if (tl.some((e) => e && typeof e[k] === 'number' && isFinite(e[k]))) { key = k; break; }
  }
  if (!key) return null;                                     // metric missing: skip this cue

  const pts = [];
  for (const e of tl) {
    if (!e || typeof e.t !== 'number' || !isFinite(e.t)) continue;
    const v = e[key];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    pts.push({ t: e.t, v });
  }
  pts.sort((a, b) => a.t - b.t);

  const C = COACHABILITY;
  const before = pts.filter((p) => p.t >= cueT - C.BASELINE_S && p.t < cueT);
  const after = pts.filter((p) => p.t >= cueT && p.t <= cueT + C.AFTER_S);
  const resp = pts.filter((p) => p.t >= cueT + C.RESP_FROM_S && p.t <= cueT + C.RESP_TO_S);
  const lastT = pts.length ? pts[pts.length - 1].t : cueT;
  // "run ended": the consolidation window runs past the end of the timeline, so
  // there is nothing to score even though there may be a trace to draw.
  const runEnded = lastT < cueT + C.RESP_TO_S;

  const base = {
    fault: cue.fault, key, label: meta.label, unit: meta.unit,
    goodWhenLower: meta.goodWhenLower, cueT,
    before, after, samplesAfter: resp.length, runEnded,
    baseMean: before.length ? meanV(before) : null,
    baseSd: null, respMean: null, deltaPct: null, improved: false, latencyS: null,
    scored: false,
  };
  // the band is drawn even when the response cannot be SCORED — an unscored
  // chart still reads better with the runner's own baseline behind it
  let baseSd = null;
  if (before.length >= 2) {
    const bm = meanV(before);
    let b2 = 0;
    for (const p of before) b2 += (p.v - bm) * (p.v - bm);
    baseSd = Math.sqrt(b2 / before.length);
  }
  if (before.length < C.MIN_PTS || resp.length < C.MIN_PTS) return { ...base, baseSd };

  const baseMean = meanV(before);
  const respMean = meanV(resp);
  const dir = meta.goodWhenLower ? -1 : 1;
  if (!(Math.abs(baseMean) > 1e-9)) return { ...base, baseSd, respMean };
  const deltaPct = ((respMean - baseMean) / Math.abs(baseMean)) * 100 * dir;
  if (!Number.isFinite(deltaPct)) return { ...base, baseSd, respMean };
  const improved = deltaPct >= C.MIN_PCT;

  // Response latency: the first second after the cue at which a 15 s trailing
  // mean has moved at least HALFWAY toward where the metric eventually settled.
  // Only meaningful when the response actually happened.
  let latencyS = null;
  if (improved) {
    const target = baseMean + 0.5 * (respMean - baseMean);
    for (let t = cueT + 5; t <= cueT + C.AFTER_S; t++) {
      const w = after.filter((p) => p.t > t - 15 && p.t <= t);
      if (w.length < 4) continue;
      if (dir * (meanV(w) - target) >= 0) { latencyS = t - cueT; break; }
    }
  }

  return { ...base, baseSd, respMean, deltaPct, improved, latencyS, scored: true };
}

// One sentence over the card. Groups the scored cues by fault so it can say
// which coaching is landing and which is not.
function coachabilityLede(results) {
  const byFault = new Map();
  for (const r of results) {
    if (!r || !r.scored) continue;
    const g = byFault.get(r.fault) || { label: r.label, pct: [], lat: [] };
    g.pct.push(r.deltaPct);
    if (r.latencyS != null) g.lat.push(r.latencyS);
    byFault.set(r.fault, g);
  }
  if (!byFault.size) {
    return results.some((r) => r.runEnded)
      ? 'The run ended before these cues had time to land — nothing to score yet.'
      : 'Not enough data around these cues to score a response.';
  }
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const good = [], bad = [];
  for (const g of byFault.values()) {
    if (avg(g.pct) >= COACHABILITY.MIN_PCT) {
      const secs = g.lat.length ? Math.max(5, Math.round(avg(g.lat) / 5) * 5) : null;
      good.push(secs == null ? `You respond to ${g.label} cues.`
        : `You respond to ${g.label} cues in about ${secs} seconds.`);
    } else {
      bad.push(`${g.label.charAt(0).toUpperCase() + g.label.slice(1)} cues aren't landing yet.`);
    }
  }
  return [...good, ...bad].join(' ');
}

// One cue's response chart: 60 s of baseline (dim, with a mean±SD band), an
// accent line at the cue, then 120 s of aftermath with the 30–90 s
// consolidation window shaded. dpr-aware, sized at call time.
function drawCueResponse(canvas, r) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const C = COACHABILITY;
  const pts = [...r.before, ...r.after];
  if (!pts.length) return drawEmpty(ctx, w, h);

  const t0 = r.cueT - C.BASELINE_S, t1 = r.cueT + C.AFTER_S;
  const pad = 4;
  const x = (t) => pad + ((t - t0) / (t1 - t0)) * (w - pad * 2);
  let vMin = Infinity, vMax = -Infinity;
  for (const p of pts) { if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v; }
  if (r.baseMean != null && r.baseSd != null) {
    vMin = Math.min(vMin, r.baseMean - r.baseSd);
    vMax = Math.max(vMax, r.baseMean + r.baseSd);
  }
  // a metric that never moved must not be pinned to the floor of the chart —
  // give a degenerate range a symmetric window around its own value
  if (!(vMax - vMin > 1e-9)) {
    const c0 = vMax, padV = Math.max(Math.abs(c0) * 0.05, 1e-3);
    vMin = c0 - padV; vMax = c0 + padV;
  }
  const span = vMax - vMin;
  const y = (v) => h - pad - ((v - vMin) / span) * (h - pad * 2);

  // baseline band (mean ± SD) drawn across the FULL width, not just the
  // baseline window: the point of the card is seeing whether the trace leaves
  // the band after the cue, which a band that stops at the cue cannot show.
  if (r.baseMean != null && r.baseSd != null) {
    const yTop = y(r.baseMean + r.baseSd), yBot = y(r.baseMean - r.baseSd);
    ctx.fillStyle = 'rgba(142,142,150,0.14)';
    ctx.fillRect(pad, Math.min(yTop, yBot), w - pad * 2, Math.abs(yBot - yTop) || 1);
    ctx.strokeStyle = 'rgba(142,142,150,0.45)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, y(r.baseMean));
    ctx.lineTo(w - pad, y(r.baseMean));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 30–90 s consolidation window
  const cx0 = x(r.cueT + C.RESP_FROM_S), cx1 = x(r.cueT + C.RESP_TO_S);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(cx0, pad, Math.max(1, cx1 - cx0), h - pad * 2);

  // the trace: dim before the cue, coloured by the verdict after it
  const line = (arr, color) => {
    if (arr.length < 2) return;
    ctx.beginPath();
    arr.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  line(r.before, '#8e8e96');
  // bridge the gap so the line does not break at the cue
  const bridge = r.before.length && r.after.length ? [r.before[r.before.length - 1], r.after[0]] : [];
  const afterColor = r.improved ? '#3ddc84' : '#ff8a3d';
  line(bridge, afterColor);
  line(r.after, afterColor);

  // the cue itself
  ctx.strokeStyle = '#ff5b14';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(r.cueT), pad);
  ctx.lineTo(x(r.cueT), h - pad);
  ctx.stroke();

  if (r.runEnded) {
    const endX = r.after.length ? x(r.after[r.after.length - 1].t) : x(r.cueT);
    ctx.fillStyle = '#8e8e96';
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('run ended', Math.min(endX + 4, w - 60), pad + 11);
  }
}

// Renders the "Did the coaching work?" card into containerEl. Standalone: safe
// to call from a bare test page. Returns the scored results (or null when there
// is nothing to show — zero cues means NO CARD, not an empty one).
export function coachabilityView(containerEl, run) {
  if (!containerEl) return null;
  try { injectStyles(); } catch { /* no document: nothing to style */ }
  run = run || {};
  const cues = Array.isArray(run.cues) ? run.cues : [];
  if (!cues.length) { containerEl.innerHTML = ''; return null; }

  const tl = run.timeline || [];
  const results = [];
  for (const c of cues) {
    let r = null;
    try { r = scoreCueResponse(tl, c); } catch { r = null; }
    if (r) results.push(r);                 // null = missing metric → cue skipped
  }
  if (!results.length) { containerEl.innerHTML = ''; return null; }

  const chip = (r) => {
    if (!r.scored) {
      return `<span class="si-chip si-chip-dim">${r.runEnded ? 'run ended' : 'not enough data'}</span>`;
    }
    return r.improved
      ? `<span class="si-chip si-chip-good">+${Math.round(r.deltaPct)}% better</span>`
      : `<span class="si-chip si-chip-warn">no change</span>`;
  };

  const rows = results.map((r, i) => `
    <div class="si-cue-row">
      <div class="si-chart-head">
        <div>
          <div class="si-eyebrow">${r.label} cue · ${fmtClock(r.cueT)}</div>
          <div class="si-cue-sub">${r.scored
            ? `${r.baseMean.toFixed(r.key === 'cadence' ? 0 : 2)} → ${r.respMean.toFixed(r.key === 'cadence' ? 0 : 2)}${r.unit ? ' ' + r.unit : ''} over the next 30–90 s`
            : 'Too little of the run left after this cue to score it'}</div>
        </div>
        ${chip(r)}
      </div>
      <canvas class="si-canvas si-cue-canvas" data-cue="${i}"></canvas>
    </div>`).join('');

  containerEl.innerHTML = `
    <div class="si-card">
      <div class="si-eyebrow">Did the coaching work?</div>
      <div class="si-focus-text si-cue-lede">${coachabilityLede(results)}</div>
      ${rows}
      <div class="si-cue-note">Baseline band is the 60 s before each cue (mean ± SD).
        Response is measured 30–90 s after — the ~300 strides a gait correction
        needs to consolidate.</div>
    </div>`;

  results.forEach((r, i) => {
    const c = containerEl.querySelector(`canvas[data-cue="${i}"]`);
    if (c) { try { drawCueResponse(c, r); } catch { /* a chart must never throw */ } }
  });
  return results;
}

function drawEmpty(ctx, w, h) {
  ctx.fillStyle = '#8e8e96';
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No data', w / 2, h / 2);
}

const STYLE_ID = 'si-styles';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
  .si-root{font-family:-apple-system,'SF Pro Display',system-ui,sans-serif;color:#f4f4f5;
    display:flex;flex-direction:column;gap:12px;font-variant-numeric:tabular-nums;}
  .si-card{background:#17171a;border-radius:18px;padding:16px;}
  .si-eyebrow{font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:#8e8e96;
    font-weight:600;margin-bottom:6px;}
  .si-hero{position:relative;overflow:hidden;border-radius:18px;padding:22px 18px;
    background:linear-gradient(135deg,#ff5b14 0%,#ff8a3d 100%);}
  .si-hero.si-hero-clean{background:linear-gradient(135deg,#159b52 0%,#3ddc84 100%);}
  .si-hero .si-eyebrow{color:rgba(255,255,255,.85);}
  .si-hero-headline{font-size:24px;font-weight:700;letter-spacing:-.5px;line-height:1.2;
    max-width:75%;margin:0;}
  .si-hero-rings{position:absolute;right:-40px;top:50%;transform:translateY(-50%);
    pointer-events:none;}
  .si-hero-pod{position:absolute;right:14px;top:50%;transform:translateY(-50%);opacity:.95;}
  .si-pod3d{width:104px;height:104px;display:flex;align-items:center;justify-content:center;}
  .si-pod3d canvas{width:100%;height:100%;}
  .si-row{display:flex;gap:12px;}
  .si-row>.si-card{flex:1;min-width:0;}
  .si-big{font-size:30px;font-weight:700;letter-spacing:-1px;line-height:1.05;}
  .si-big small{font-size:13px;font-weight:600;color:#8e8e96;letter-spacing:0;}
  .si-sub{font-size:12px;color:#8e8e96;margin-top:2px;}
  .si-focus-text{font-size:15px;font-weight:600;line-height:1.3;}
  .si-chart-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}
  .si-chip{font-size:12px;font-weight:700;padding:3px 8px;border-radius:99px;white-space:nowrap;}
  .si-chip small{font-weight:500;opacity:.8;font-size:10px;}
  .si-chip-good{color:#3ddc84;background:rgba(61,220,132,.12);}
  .si-chip-warn{color:#ff8a3d;background:rgba(255,138,61,.12);}
  .si-chip-dim{color:#8e8e96;background:rgba(142,142,150,.12);}
  .si-cue-lede{margin-bottom:4px;}
  .si-cue-row{padding-top:14px;margin-top:14px;border-top:1px solid rgba(255,255,255,.06);}
  .si-cue-sub{font-size:11px;color:#8e8e96;margin-top:2px;}
  .si-cue-canvas{height:84px;margin-top:8px;}
  .si-cue-note{font-size:10px;line-height:1.45;color:#8e8e96;margin-top:12px;}
  .si-canvas{width:100%;height:110px;display:block;margin-top:10px;}
  .si-axis{display:flex;justify-content:space-between;font-size:10px;color:#8e8e96;margin-top:6px;}
  .si-summary{display:flex;}
  .si-summary>div{flex:1;text-align:center;}
  .si-summary>div+div{border-left:1px solid rgba(255,255,255,.07);}
  .si-summary .si-big{font-size:20px;}
  .si-hist-row{display:flex;align-items:center;gap:12px;padding:12px 4px;cursor:pointer;
    border-top:1px solid rgba(255,255,255,.06);}
  .si-hist-row:first-of-type{border-top:none;}
  .si-hist-row:active{opacity:.7;}
  .si-hist-main{flex:1;min-width:0;}
  .si-hist-title{font-size:14px;font-weight:600;}
  .si-hist-sub{font-size:11px;color:#8e8e96;margin-top:1px;}
  .si-score-chip{min-width:38px;text-align:center;font-size:13px;font-weight:700;
    padding:5px 0;border-radius:10px;}
  .si-score-good{color:#3ddc84;background:rgba(61,220,132,.12);}
  .si-score-mid{color:#ff8a3d;background:rgba(255,138,61,.12);}
  .si-score-bad{color:#ff5b14;background:rgba(255,91,20,.14);}
  .si-none{color:#8e8e96;font-size:13px;padding:8px 0;}
  `;
  document.head.appendChild(s);
}

function scoreChip(score) {
  const cls = score == null ? 'si-score-mid' : score >= 85 ? 'si-score-good'
    : score >= 60 ? 'si-score-mid' : 'si-score-bad';
  return `<span class="si-score-chip ${cls}">${score == null ? '–' : score}</span>`;
}

// Radiating rings behind the hero pod (inline SVG, no assets).
function ringsSVG() {
  let c = '';
  for (let r = 24; r <= 104; r += 20) {
    c += `<circle cx="110" cy="110" r="${r}" fill="none" stroke="rgba(255,255,255,${(0.34 - r * 0.002).toFixed(3)})" stroke-width="1"/>`;
  }
  return `<svg class="si-hero-rings" width="220" height="220" viewBox="0 0 220 220">${c}</svg>`;
}

// Small AirPod silhouette — placeholder/fallback while (or if) the 3D model
// doesn't mount; pods3d.mount hides anything marked data-pods-ph.
function podSVG() {
  return `<svg data-pods-ph width="54" height="72" viewBox="0 0 54 72" fill="none">
    <path d="M14 6 C14 -1 40 -1 40 10 L40 26 C40 34 33 37 28 36 L28 60 C28 68 16 68 16 60 L16 34 C15 30 14 22 14 6 Z"
      fill="#fff" opacity="0.95"/>
    <ellipse cx="36" cy="14" rx="5" ry="7" fill="rgba(0,0,0,0.12)"/>
  </svg>`;
}

export function renderInsights(containerEl, run, prevRun) {
  injectStyles();
  if (!containerEl) return;
  run = run || {};
  const tl = run.timeline || [];
  const avg = run.avg || {};
  const fault = dominantFault(run);
  // an unknown fault name (old stored run, foreign telemetry) must render the
  // clean layout, never blank the screen on meta.* access
  const meta = (fault && FAULT_META[fault]) || null;
  const clean = !meta;

  const impactPts = series(run, 'impact');
  const cadencePts = series(run, 'cadence');
  const swayPts = series(run, 'sway');
  const dur = run.duration != null ? run.duration
    : (tl.length ? tl[tl.length - 1].t : 0);

  const avgImpact = avg.impact != null ? avg.impact
    : (impactPts.length ? impactPts.reduce((s, p) => s + p.v, 0) / impactPts.length : null);
  const avgCadence = avg.cadence != null ? avg.cadence
    : (cadencePts.length ? cadencePts.reduce((s, p) => s + p.v, 0) / cadencePts.length : null);
  const avgSway = avg.sway != null ? avg.sway
    : (swayPts.length ? swayPts.reduce((s, p) => s + p.v, 0) / swayPts.length : null);
  const pAvg = (prevRun && prevRun.avg) || {};

  const axis = `<div class="si-axis"><span>0:00</span><span>${fmtClock(dur / 2)}</span><span>${fmtClock(dur)}</span></div>`;

  const focusText = clean ? 'Keep doing exactly this' : meta.focus;
  const scoreVal = run.score != null ? run.score : null;

  const showSway = run.mode === 'ears';

  containerEl.innerHTML = `
  <div class="si-root">
    <div class="si-hero ${clean ? 'si-hero-clean' : ''}">
      ${ringsSVG()}<div class="si-hero-pod si-pod3d">${podSVG()}</div>
      <div class="si-eyebrow">${clean ? 'CLEAN RUN' : meta.eyebrow}</div>
      <h2 class="si-hero-headline">${clean ? 'Clean run. Keep doing exactly this.' : meta.headline}</h2>
    </div>

    <div class="si-row">
      <div class="si-card">
        <div class="si-eyebrow">Suggested focus</div>
        <div class="si-focus-text">${focusText}</div>
      </div>
      <div class="si-card">
        <div class="si-eyebrow">Form score</div>
        <div class="si-big">${scoreVal == null ? '–' : scoreVal}<small>/100</small></div>
        <div class="si-sub" style="color:${scoreVal != null && scoreVal >= 85 ? '#3ddc84' : '#8e8e96'}">${scoreVal == null ? 'No data' : scoreVal >= 85 ? 'Great form' : scoreVal >= 60 ? 'Good form' : 'Needs work'}</div>
      </div>
    </div>

    <div class="si-card">
      <div class="si-chart-head">
        <div>
          <div class="si-eyebrow">Impact load over time</div>
          <div class="si-big">${avgImpact == null ? '–' : avgImpact.toFixed(1)}<small> G avg</small></div>
        </div>
        ${deltaChip(avgImpact, pAvg.impact, true)}
      </div>
      <canvas class="si-canvas" data-chart="impact"></canvas>
      ${axis}
    </div>

    <div class="si-card">
      <div class="si-chart-head">
        <div>
          <div class="si-eyebrow">Cadence</div>
          <div class="si-big">${avgCadence == null ? '–' : Math.round(avgCadence)}<small> SPM avg</small></div>
        </div>
        ${deltaChip(avgCadence, pAvg.cadence, false)}
      </div>
      <canvas class="si-canvas" data-chart="cadence"></canvas>
      ${axis}
    </div>

    ${showSway ? `
    <div class="si-card">
      <div class="si-chart-head">
        <div>
          <div class="si-eyebrow">Head stability</div>
          <div class="si-big">${avgSway == null ? '–' : avgSway.toFixed(2)}<small> sway</small></div>
        </div>
        ${deltaChip(avgSway, pAvg.sway, true)}
      </div>
      <canvas class="si-canvas" data-chart="sway" style="height:90px"></canvas>
      ${axis}
    </div>` : ''}

    <div data-coachability></div>

    <div class="si-card si-summary">
      <div><div class="si-big">${typeof run.km === 'number' ? run.km.toFixed(2) : '–'}</div><div class="si-sub">km</div></div>
      <div><div class="si-big">${fmtDuration(dur)}</div><div class="si-sub">duration</div></div>
      <div><div class="si-big">${(run.cues || []).length}</div><div class="si-sub">cues</div></div>
      <div><div class="si-big" style="font-size:16px;padding-top:5px">${run.mode === 'ears' ? 'AirPods' : 'Phone'}</div><div class="si-sub">sensor</div></div>
      ${run.goalS != null ? `
      <div><div class="si-big" style="font-size:16px;padding-top:5px;color:${run.metGoal ? '#3ddc84' : '#ff8a3d'}">${run.metGoal ? 'Met' : 'Short'}</div><div class="si-sub">${goalCellSub(run)}</div></div>` : ''}
    </div>

    <div class="si-card">
      <div class="si-eyebrow">Activity history</div>
      <div data-history></div>
    </div>
  </div>`;

  // charts — canvases are laid out now (caller guarantees the screen is visible)
  const chart = (name, fn, pts, color) => {
    const c = containerEl.querySelector(`canvas[data-chart="${name}"]`);
    if (c) { try { fn(c, pts, color); } catch { /* a chart must never throw */ } }
  };
  chart('impact', drawAreaChart, impactPts, '#ff5b14');
  chart('cadence', drawBarChart, cadencePts, '#ff5b14');
  if (showSway) chart('sway', drawLineChart, swayPts, '#3ddc84');

  // "Did the coaching work?" — only when this run actually got cues; the view
  // leaves the slot empty (no card) when there is nothing to answer with.
  if (run.cues?.length) {
    const cEl = containerEl.querySelector('[data-coachability]');
    if (cEl) { try { coachabilityView(cEl, run); } catch { /* never blank the screen */ } }
  }

  // history list
  const histEl = containerEl.querySelector('[data-history]');
  if (!histEl) return;
  let runs = [];
  try { runs = loadRuns(run.user); } catch { /* storage unavailable */ }
  if (!runs.length && run.id) runs = [run];
  if (!runs.length) {
    histEl.innerHTML = '<div class="si-none">No runs yet</div>';
    return;
  }
  runs.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'si-hist-row';
    const d = new Date(r.startedAt ?? r.t0 ?? NaN);
    const when = r.id === 'demo' ? 'Sample run'
      : Number.isFinite(d.getTime())
        ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
          d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : 'Earlier run';
    row.innerHTML = `
      <div class="si-hist-main">
        <div class="si-hist-title">${when}${r.id === run.id ? ' · this run' : ''}</div>
        <div class="si-hist-sub">${r.km != null ? r.km.toFixed(2) : '–'} km · ${fmtDuration(r.duration)} · ${(r.cues || []).length} cues · ${r.mode === 'ears' ? 'AirPods' : 'Phone'}</div>
      </div>
      ${scoreChip(r.score)}`;
    row.addEventListener('click', () => {
      // opening a past run: the run after it in the list is its "previous"
      renderInsights(containerEl, r, runs[i + 1] || null);
      try { containerEl.scrollIntoView({ block: 'start' }); } catch { /* fine */ }
    });
    histEl.appendChild(row);
  });

  // 3D pods in the hero — decorative; SVG placeholder stays if this fails
  const podEl = containerEl.querySelector('.si-pod3d');
  if (podEl) import('./pods3d.js').then((m) => m.mount?.(podEl)).catch(() => {});
}
