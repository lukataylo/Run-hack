// replay.js — the entire test suite. `npm run check`, plain node, <1s, exit 1 on failure.
import { analyze, Coach, CONFIG, CUES } from './coach.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

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

// --- fixture replay (fixtures/ owned by Track C — skip gracefully) -----------
if (existsSync('fixtures')) {
  const files = readdirSync('fixtures').filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    try {
      const lines = readFileSync(`fixtures/${f}`, 'utf8').split('\n').filter(Boolean);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
