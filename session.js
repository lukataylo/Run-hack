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
          } catch { /* a bad fix must never touch the run */ }
        },
        () => { /* GPS denied/unavailable: distance stays 0, run continues */ },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
    } catch { /* no geolocation at all */ }
  }

  // Called at 1 Hz with {cadence, bounce, impact, asym, sway, score, moving}
  tick(metrics) {
    if (this.stopped) return;
    const m = metrics || {};
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const asym = num(m.asym);
    const balance = num(m.balance);
    this.timeline.push({
      t: Math.round((Date.now() - this.startedAt) / 1000),
      cadence: num(m.cadence),
      bounce: num(m.bounce),
      impact: num(m.impact),
      asym,
      sway: num(m.sway),
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
    const run = {
      id: `run-${this.startedAt}-${Math.random().toString(36).slice(2, 7)}`,
      user: this.user,
      mode: this.mode,
      startedAt: this.startedAt,
      duration: Math.round((Date.now() - this.startedAt) / 1000),
      km: Math.round(this.km * 1000) / 1000,
      timeline: tl,
      cues: this.cues,
      avg: {
        cadence: avgOf(tl, 'cadence'),
        bounce: avgOf(tl, 'bounce'),
        impact: avgOf(tl, 'impact'),
        asym: avgOf(tl, 'asym'),
        sway: avgOf(tl, 'sway'),
      },
      score: avgOf(tl, 'score') == null ? null : Math.round(avgOf(tl, 'score')),
    };
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

    <div class="si-card si-summary">
      <div><div class="si-big">${typeof run.km === 'number' ? run.km.toFixed(2) : '–'}</div><div class="si-sub">km</div></div>
      <div><div class="si-big">${fmtDuration(dur)}</div><div class="si-sub">duration</div></div>
      <div><div class="si-big">${(run.cues || []).length}</div><div class="si-sub">cues</div></div>
      <div><div class="si-big" style="font-size:16px;padding-top:5px">${run.mode === 'ears' ? 'AirPods' : 'Phone'}</div><div class="si-sub">sensor</div></div>
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
