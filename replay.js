// replay.js — the entire test suite. `npm run check`, plain node, <1s, exit 1 on failure.
import { analyze, Coach, CONFIG, CUES, GoalTracker } from './coach.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// fixtures/ lives beside this script — resolve from the script, not cwd
const FIXTURES = join(import.meta.dirname, 'fixtures');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- synthetic run generator -------------------------------------------------
// Footfall = narrow Gaussian spike per step + flight-arc cosine (NOT a sine —
// the harmonic structure matters to autocorrelation). ~0.6× peak→RMS.
function genRun({
  durS = 30, hz = 50, cadence = 172, bounce = 8, asym = 0, sway = 0.35,
  standing = false, seed = 1,
} = {}) {
  // deterministic noise
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  // orientation: arbitrary tilted gravity so nothing is axis-aligned
  const up = norm3([0.25, 0.93, 0.27]);
  const fore = norm3(cross3(up, [1, 0, 0]));
  const lat = norm3(cross3(up, fore));
  const stepHz = cadence / 60;
  const stepP = 1 / stepHz;
  const sigma = 0.05 * stepP; // narrow Gaussian spike
  const N = durS * hz;
  const vr = new Array(N), fr = new Array(N), lr = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / hz;
    let v = 0, f = 0, l = 0;
    if (!standing) {
      // flight-arc cosine at step frequency
      v += -0.45 * Math.cos(2 * Math.PI * stepHz * t);
      // Gaussian impact spike at each footfall, alternating amplitude for asymmetry
      const k = Math.round(t * stepHz);
      for (let kk = k - 1; kk <= k + 1; kk++) {
        const ts = kk / stepHz;
        const amp = 1 + (kk % 2 === 0 ? asym / 2 : -asym / 2);
        v += 2.2 * amp * Math.exp(-((t - ts) ** 2) / (2 * sigma * sigma));
      }
      // horizontal: fore-aft dominates at step freq; lateral rocks at stride freq
      f = 1.6 * Math.cos(2 * Math.PI * stepHz * t + 0.7);
      l = 1.6 * sway * Math.cos(Math.PI * stepHz * t);
    }
    vr[i] = v + 0.05 * rnd(); fr[i] = f + 0.05 * rnd(); lr[i] = l + 0.05 * rnd();
  }
  // scale vertical to exactly the requested bounce RMS (mean-removed)
  const vm = vr.reduce((a, b) => a + b, 0) / N;
  const vrms = Math.sqrt(vr.reduce((a, b) => a + (b - vm) * (b - vm), 0) / N) || 1;
  const scale = standing ? 1 : bounce / vrms;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const vs = standing ? 0.1 * rnd() : (vr[i] - vm) * scale;
    const ax = vs * up[0] + fr[i] * fore[0] + lr[i] * lat[0];
    const ay = vs * up[1] + fr[i] * fore[1] + lr[i] * lat[1];
    const az = vs * up[2] + fr[i] * fore[2] + lr[i] * lat[2];
    samples.push({
      t: (i / hz) * 1000,
      ax, ay, az,
      gx: ax + 9.81 * up[0], gy: ay + 9.81 * up[1], gz: az + 9.81 * up[2],
    });
  }
  return samples;
}
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(v) { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }

const win = (samples, endS, lenS = 6) =>
  samples.filter((x) => x.t >= (endS - lenS) * 1000 && x.t <= endS * 1000);

// --- cadence recovery ±4 spm -------------------------------------------------
for (const spm of [150, 165, 172, 188, 200]) {
  const run = genRun({ cadence: spm, durS: 10 });
  const m = analyze(win(run, 10), 'hand');
  check(`cadence ${spm} recovered (got ${m.cadence.toFixed(1)})`, Math.abs(m.cadence - spm) <= 4);
}

// --- bounce ------------------------------------------------------------------
{
  const soft = analyze(win(genRun({ bounce: 7, durS: 10 }), 10), 'hand');
  const hard = analyze(win(genRun({ bounce: 13, durS: 10 }), 10), 'hand');
  check(`bounce ranks (soft ${soft.bounce.toFixed(1)} < hard ${hard.bounce.toFixed(1)})`, soft.bounce < CONFIG.BOUNCE_MAX && hard.bounce > CONFIG.BOUNCE_MAX);
}

// --- asymmetry ---------------------------------------------------------------
{
  const even = analyze(win(genRun({ asym: 0.02, durS: 10 }), 10), 'hand');
  const limp = analyze(win(genRun({ asym: 0.30, durS: 10 }), 10), 'hand');
  check(`asymmetry flagged when planted (even ${even.asym.toFixed(3)}, limp ${limp.asym.toFixed(3)})`,
    even.asym < CONFIG.ASYM_MAX && limp.asym > CONFIG.ASYM_MAX);
}

// --- sway separates steady from wobble (ears), meaningless from hand ---------
{
  const steady = analyze(win(genRun({ sway: 0.3, durS: 10 }), 10), 'ears');
  const wobble = analyze(win(genRun({ sway: 1.0, durS: 10 }), 10), 'ears');
  check(`sway separation (steady ${steady.sway.toFixed(2)} < wobble ${wobble.sway.toFixed(2)})`,
    steady.sway < CONFIG.SWAY_FALLBACK && wobble.sway > CONFIG.SWAY_FALLBACK);
  const hand = analyze(win(genRun({ sway: 1.0, durS: 10 }), 10), 'hand');
  check('sway gated to ears mode (hand reports 0)', hand.sway === 0);
}

// --- standing still ----------------------------------------------------------
{
  const m = analyze(win(genRun({ standing: true, durS: 10 }), 10), 'hand');
  check('standing still gated (moving=false, score not computed)', m.moving === false && m.cadence === 0);
}

// --- score ranking -----------------------------------------------------------
{
  const good = analyze(win(genRun({ cadence: 175, bounce: 7, asym: 0.02, durS: 10 }), 10), 'hand');
  const mid = analyze(win(genRun({ cadence: 158, bounce: 11.5, asym: 0.05, durS: 10 }), 10), 'hand');
  const bad = analyze(win(genRun({ cadence: 140, bounce: 14, asym: 0.30, durS: 10 }), 10), 'hand');
  check(`score good ≥ 85 (got ${good.score})`, good.score >= 85);
  check(`score bad ≤ 50 (got ${bad.score})`, bad.score <= 50);
  check(`score ranks good ${good.score} > mid ${mid.score} > bad ${bad.score}`,
    good.score > mid.score && mid.score > bad.score);
}

// --- cue policy etiquette ----------------------------------------------------
// Feed the Coach at 1 Hz with synthetic metric ticks (the policy layer's contract).
const tick = (over = {}) => ({ cadence: 172, bounce: 8, impact: 1.5, asym: 0.03, sway: 0.3, score: 95, moving: true, ...over });

{
  // slow-cadence run gets the cadence cue; nothing before mute+persistence
  const c = new Coach('hand');
  const cues = [];
  for (let s = 0; s < 120; s++) {
    const cue = c.update(tick({ cadence: 142 }), s * 1000);
    if (cue) cues.push({ s, ...cue });
  }
  check('slow cadence run gets cadence cue', cues.length > 0 && cues[0].fault === 'cadence' && cues[0].text === CUES.cadence);
  check(`no cue inside the ${CONFIG.MUTE_MS / 1000}s grace period (first at ${cues[0]?.s}s)`,
    cues.length > 0 && cues[0].s * 1000 >= CONFIG.MUTE_MS);
  const sameGaps = cues.slice(1).map((q, i) => q.s - cues[i].s);
  check('same fault never repeats inside 90 s', sameGaps.every((g) => g * 1000 >= CONFIG.REPEAT_MS));
}

{
  // ≥30 s between any two cues + priority order (cadence beats asymmetry)
  const c = new Coach('hand');
  const cues = [];
  for (let s = 0; s < 240; s++) {
    const cue = c.update(tick({ cadence: 142, bounce: 13, asym: 0.25 }), s * 1000);
    if (cue) cues.push({ s, ...cue });
  }
  const gaps = cues.slice(1).map((q, i) => q.s - cues[i].s);
  check(`≥30 s between any two cues (gaps ${gaps.join(',')})`, gaps.every((g) => g * 1000 >= CONFIG.GAP_MS));
  check('priority: cadence first, then bounce', cues[0]?.fault === 'cadence' && cues[1]?.fault === 'bounce');
  check('asymmetry is always the lowest priority', cues.findIndex((q) => q.fault === 'asymmetry') > cues.findIndex((q) => q.fault === 'bounce'));
}

{
  // clean run: zero cues
  const c = new Coach('ears');
  let cued = 0;
  for (let s = 0; s < 300; s++) if (c.update(tick(), s * 1000)) cued++;
  check('clean run gets zero cues', cued === 0);
}

{
  // 12 s persistence: a brief blip never cues
  const c = new Coach('hand');
  let cued = 0;
  for (let s = 0; s < 120; s++) {
    // 4-second slow patch well past the mute — a pothole the trimmed mean rejects
    const slow = s >= 40 && s < 44;
    if (c.update(tick({ cadence: slow ? 130 : 172 }), s * 1000)) cued++;
  }
  check('brief fault (<12 s) never cues', cued === 0);
}

{
  // sway cued in ears mode, never from hand
  const mkTicks = (mode) => {
    const c = new Coach(mode);
    const cues = [];
    for (let s = 0; s < 120; s++) {
      const cue = c.update(tick({ sway: 0.8 }), s * 1000);
      if (cue) cues.push(cue);
    }
    return cues;
  };
  const ears = mkTicks('ears');
  const hand = mkTicks('hand');
  check('sway cued in ears mode', ears.some((q) => q.fault === 'sway'));
  check('sway never cued from hand', !hand.some((q) => q.fault === 'sway'));
}

{
  // standing still: no metrics ticks accumulate, no cues
  const c = new Coach('hand');
  let cued = 0;
  for (let s = 0; s < 120; s++) if (c.update(tick({ moving: false, cadence: 0 }), s * 1000)) cued++;
  check('standing still never coached', cued === 0);
}

// --- full pipeline: synth samples → analyze → Coach --------------------------
{
  const run = genRun({ cadence: 142, bounce: 8, durS: 90 });
  const c = new Coach('hand');
  const cues = [];
  for (let s = 6; s < 90; s++) {
    const m = analyze(win(run, s), 'hand');
    const cue = c.update(m, s * 1000);
    if (cue) cues.push({ s, ...cue });
  }
  check('pipeline: slow run cues cadence end-to-end', cues.length >= 1 && cues[0].fault === 'cadence');
}

// --- garbage input never throws, never fabricates metrics --------------------
{
  const good = win(genRun({ durS: 10 }), 10);

  // NaN fields
  const nan = good.map((s, i) => (i % 7 === 0 ? { ...s, ax: NaN, gy: NaN } : s));
  let m = null, threw = false;
  try { m = analyze(nan, 'hand'); } catch { threw = true; }
  check('NaN samples: no throw, moving=false, finite score',
    !threw && m.moving === false && Number.isFinite(m.score));

  // identical timestamps
  const flat = good.map((s) => ({ ...s, t: 5000 }));
  threw = false;
  try { m = analyze(flat, 'hand'); } catch { threw = true; }
  check('identical timestamps: no throw, moving=false, finite score',
    !threw && m.moving === false && Number.isFinite(m.score));

  // a stray wall-clock epoch timestamp in a performance.now() stream
  const stray = good.map((s, i) => (i === good.length - 1 ? { ...s, t: 1.7e12 } : s));
  threw = false;
  try { m = analyze(stray, 'hand'); } catch { threw = true; }
  check('stray epoch timestamp: no throw, moving=false, finite score',
    !threw && m.moving === false && Number.isFinite(m.score));
}

// --- trimmed mean rejects a wild outlier (via Coach.smoothed) ----------------
{
  const c = new Coach('hand');
  c.hist.cadence = [172, 1e9, 170, 171, 173, 172];
  const sm = c.smoothed().cadence;
  check(`trimmed mean rejects 1e9 outlier (got ${sm.toFixed(1)})`, sm > 160 && sm < 185);
}

// --- baseline poisoning: fast warm-up then healthy cruise never nags ---------
{
  const c = new Coach('hand');
  let cadCues = 0;
  // 5 min of 200 spm warm-up strides fills the whole baseline window…
  for (let s = 0; s < 300; s++) c.update(tick({ cadence: 200 }), s * 1000);
  // …then a healthy 180 spm cruise: the poisoned baseline must NOT cue
  for (let s = 300; s < 900; s++) {
    const cue = c.update(tick({ cadence: 180 }), s * 1000);
    if (cue && cue.fault === 'cadence') cadCues++;
  }
  check('warm-up strides never poison the cadence baseline (0 cues at 180 spm)', cadCues === 0);
}

// --- GoalTracker: distance + target-time goal runs ---------------------------
{
  // GPS branch, exactly on pace: 1 km in 300 s
  const g = new GoalTracker(1, 300);
  const events = [];
  for (let s = 1; s <= 340; s++) {
    const e = g.tick(tick(), s, s / 300);
    if (e) events.push({ s, ...e });
  }
  const half = events.filter((e) => e.event === 'half');
  const ninety = events.filter((e) => e.event === 'ninety');
  const complete = events.filter((e) => e.event === 'complete');
  check('goal GPS: on-pace ramp never behind', !events.some((e) => e.event === 'behind'));
  check(`goal GPS: half fires once at 0.5×distance (${half.map((e) => e.s)})`, half.length === 1 && half[0].s === 150);
  check(`goal GPS: ninety fires once at 0.9×distance (${ninety.map((e) => e.s)})`, ninety.length === 1 && ninety[0].s === 270);
  check(`goal GPS: complete fires once and reports actualS (${JSON.stringify(complete)})`,
    complete.length === 1 && complete[0].s === 300 && complete[0].actualS === 300);
  check('goal GPS: onPace true while on the ramp', g.onPace === true);
}

{
  // GPS branch, 20% slow: behind respects the 10 s clock and 45 s gap; the
  // overrun boundary (goalS×1.10) silences everything after 330 s
  const g = new GoalTracker(1, 300);
  const events = [];
  for (let s = 1; s <= 450; s++) {
    const e = g.tick(tick(), s, (s / 300) * 0.8);
    if (e) events.push({ s, ...e });
  }
  const behinds = events.filter((e) => e.event === 'behind').map((e) => e.s);
  // behindKm > max(0.005, 0.05×1) from s=76; +10 continuous s → first at 85
  check(`goal GPS: behind after 10 continuous behind-seconds (first at ${behinds[0]}s)`,
    behinds.length >= 2 && behinds[0] === 85);
  const gaps = behinds.slice(1).map((b, i) => b - behinds[i]);
  check(`goal GPS: ≥45 s between behind nudges (gaps ${gaps})`, gaps.every((x) => x >= 45));
  check('goal GPS: slow run never completes, ninety never reached', !events.some((e) => e.event === 'complete' || e.event === 'ninety'));
  check('goal GPS: silent after goalS×1.10', !events.some((e) => e.s > 330));
  check('goal GPS: onPace false while behind', g.onPace === false);
}

{
  // cadence-proxy fallback (no GPS): onPace true before the baseline locks;
  // behind needs 20 continuous below-seconds and PAUSES while not moving
  const g = new GoalTracker(1, 600);
  let s = 0;
  for (let i = 0; i < CONFIG.GOAL_BASELINE_S; i++) g.tick(tick(), ++s, null); // 172 spm seeds
  check('goal fallback: onPace true through baseline lock', g.onPace === true);
  let early = null;
  for (let i = 0; i < 10; i++) { const e = g.tick(tick({ cadence: 150 }), ++s, null); if (e?.event === 'behind') early = e; }
  for (let i = 0; i < 30; i++) { const e = g.tick(tick({ moving: false, cadence: 0 }), ++s, null); if (e?.event === 'behind') early = e; }
  check('goal fallback: no behind at 10 below-s, clock pauses while not moving', early === null && g.onPace === false);
  let behind = null;
  for (let i = 0; i < 12 && !behind; i++) { const e = g.tick(tick({ cadence: 150 }), ++s, null); if (e?.event === 'behind') behind = e; }
  check('goal fallback: behind lands once 20 continuous below-seconds accrue', !!behind);
}

{
  // cadence-fallback milestones are time-based (no GPS at all)
  const g = new GoalTracker(1, 100);
  const events = [];
  for (let s = 1; s <= 130; s++) { const e = g.tick(tick(), s, null); if (e) events.push({ s, ...e }); }
  check('goal fallback: time-based half/ninety/complete once each',
    events.filter((e) => e.event === 'half').length === 1 &&
    events.filter((e) => e.event === 'ninety').length === 1 &&
    events.filter((e) => e.event === 'complete').length === 1);
}

// --- fixture replay (fixtures/ owned by Track C — skip gracefully) -----------
if (existsSync(FIXTURES)) {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    try {
      const lines = readFileSync(join(FIXTURES, f), 'utf8').split('\n').filter(Boolean);
      const samples = lines.map((l) => JSON.parse(l)).filter((x) => typeof x.t === 'number');
      if (samples.length < 64) { console.log(`SKIP  fixture ${f} (too short)`); continue; }
      const mode = f.includes('ears') ? 'ears' : 'hand';
      const c = new Coach(mode);
      const cueLog = [];
      const endT = samples[samples.length - 1].t;
      for (let tt = samples[0].t + 6000; tt <= endT; tt += 1000) {
        const w = samples.filter((x) => x.t >= tt - 6000 && x.t <= tt);
        const m = analyze(w, mode);
        const cue = c.update(m, tt);
        if (cue) cueLog.push(`${Math.round((tt - samples[0].t) / 1000)}s:${cue.fault}`);
      }
      const last = analyze(samples.slice(-300), mode);
      console.log(`INFO  fixture ${f}: cadence ${last.cadence.toFixed(0)} bounce ${last.bounce.toFixed(1)} ` +
        `asym ${last.asym.toFixed(2)} sway ${last.sway.toFixed(2)} score ${last.score} cues [${cueLog.join(' ')}]`);
      check(`fixture ${f} replays without error`, true);
    } catch (e) {
      check(`fixture ${f} replays without error`, false, e.message);
    }
  }
} else {
  console.log('SKIP  fixtures/ not present yet (Track C)');
}

// ---- posture guard + vertical oscillation ----
{
  const run170 = genRun({ cadence: 170, seconds: 20 });
  const m = analyze(win(run170, 18), 'ears');
  check('analyze reports vertical oscillation (vo) in a plausible band',
    m.vo > 0.01 && m.vo < 0.25);

  const c = new Coach('ears');
  let cue = null;
  for (let t = 0; t <= 60; t++) {
    const got = c.update({ ...m, moving: true, tiltDev: 25 }, t * 1000);
    if (got) { cue = got; break; }
  }
  check('posture guard cues on sustained tilt deviation', cue?.fault === 'posture');

  const c2 = new Coach('ears');
  let cue2 = null;
  for (let t = 0; t <= 60; t++) {
    const got = c2.update({ ...m, moving: true, tiltDev: 3 }, t * 1000);
    if (got) { cue2 = got; break; }
  }
  check('small tilt deviation never cues posture', cue2?.fault !== 'posture');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
