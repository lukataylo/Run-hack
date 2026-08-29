// Adaptive lo-fi trap engine on vendored Tone.js (vendor/tone.js, MIT - see
// vendor/tone.js.LICENSE.txt). The run generates its soundtrack: cadence sets
// the tempo (half-time), form quality opens the mix, sustained good form
// unlocks a reward arp. Everything is C minor pentatonic melodically; the pad
// progression Cm7-Abmaj7-Eb-Bb is fixed by spec.
//
// Contract (frozen): create(opts) -> { start, stop, update, onCue, duck,
// running } plus module-level singleton proxies. update() is called at ~1 Hz
// and must tolerate partial or missing metrics.

let Tone = null; // set on first start() via dynamic import of the UMD vendor build

const EMA_TAU = 4;                       // seconds (spec: ~4 s smoothing)
const ALPHA = 1 - Math.exp(-1 / EMA_TAU); // per-1 Hz-tick coefficient

// C minor pentatonic: C Eb F G Bb
const BASS_RIFFS = [ // 2 bars = 32 sixteenth steps; rotated every 16 bars
  { 0: 'C2', 6: 'C2', 8: 'Eb2', 14: 'C2', 16: 'G1', 22: 'G1', 24: 'Bb1', 30: 'Eb2' },
  { 0: 'C2', 4: 'Eb2', 8: 'C2', 14: 'Bb1', 16: 'C2', 20: 'G1', 24: 'Eb2', 28: 'Bb1' },
];
const KICKS = [ [0, 7, 10], [0, 6, 10, 13] ];   // boom-bap variants, 16ths in a bar
const SNARES = [ [4, 12], [4, 12] ];            // backbeat stays put
const CHORDS = [ // one per bar, 4-bar cycle; .add9 used above score 75
  { n: ['C3', 'Eb3', 'G3', 'Bb3'], add9: 'D4' },   // Cm7
  { n: ['Ab2', 'C3', 'Eb3', 'G3'], add9: 'Bb3' },  // Abmaj7
  { n: ['Eb3', 'G3', 'Bb3'],       add9: 'F4' },   // Eb
  { n: ['Bb2', 'D3', 'F3'],        add9: 'C4' },   // Bb
];
const ARPS = [ // reward layer, 16th steps (null = rest); rotated every 16 bars
  ['C5', null, 'Eb5', 'G5', null, 'Bb5', 'G5', null, 'C6', null, 'Bb5', 'G5', null, 'Eb5', 'G5', null],
  ['G5', 'Bb5', null, 'C6', null, 'G5', 'Eb5', null, 'F5', null, 'G5', 'Bb5', null, 'C6', null, 'G5'],
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dbGain = db => Math.pow(10, db / 20);

export function create(opts = {}) {
  let running = false, built = false;

  // smoothed metrics (EMA); sensible mid-run defaults until real data arrives
  const m = { cadence: 165, score: 70, bounce: 8, asym: 0, sway: 0.3 };

  let nodes = null;      // all Tone objects, built once
  let bar = -1;
  let patIdx = 0;        // pattern rotation index (bass/arp/kick)
  let add9 = false;      // 9th voicing hysteresis (on >75, off <70)
  let arpOn = false;
  let barsAbove80 = 0, barsBelow70 = 0;
  let lastLayerChangeBar = -8; // max one layer change per 4 bars
  let cuePending = false;

  function build() {
    const master = new Tone.Gain(0.8).toDestination();

    // percussion bus: pan drifts with asymmetry
    const percPan = new Tone.Panner(0).connect(master);
    const kick = new Tone.MembraneSynth({
      octaves: 6, pitchDecay: 0.045, volume: -4,
      envelope: { attack: 0.001, decay: 0.35, sustain: 0 },
    }).connect(percPan);
    const snareFilt = new Tone.Filter(1800, 'bandpass').connect(percPan);
    const snare = new Tone.NoiseSynth({
      volume: -10, envelope: { attack: 0.001, decay: 0.13, sustain: 0 },
    }).connect(snareFilt);
    const hatFilt = new Tone.Filter(8000, 'highpass').connect(percPan);
    const hat = new Tone.NoiseSynth({
      volume: -16, envelope: { attack: 0.001, decay: 0.035, sustain: 0 },
    }).connect(hatFilt);

    const bass = new Tone.MonoSynth({
      volume: -7, oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.25, sustain: 0.4, release: 0.15 },
      filterEnvelope: { attack: 0.002, decay: 0.12, sustain: 0.4, baseFrequency: 90, octaves: 2.5 },
    }).connect(master);

    // pad: lowpass (cutoff <- form score) -> reverb (wet <- sway)
    const padFilter = new Tone.Filter(1200, 'lowpass', -12);
    const reverb = new Tone.Reverb({ decay: 4, wet: 0.15 });
    const pad = new Tone.PolySynth(Tone.Synth, {
      volume: -14, oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.4, decay: 0.3, sustain: 0.6, release: 1.2 },
    });
    pad.chain(padFilter, reverb, master);

    // reward arp behind its own gain (the "layer in/out" switch)
    const arpGain = new Tone.Gain(0).connect(master);
    const arpDelay = new Tone.PingPongDelay('8n', 0.35);
    arpDelay.wet.value = 0.3;
    const arp = new Tone.Synth({
      volume: -12, oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.12, sustain: 0.1, release: 0.2 },
    });
    arp.chain(arpDelay, arpGain);

    const sting = new Tone.Synth({
      volume: -8, oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.4 },
    }).connect(master);

    // hat dynamics, retuned only at bar boundaries
    const hatCtl = { vel: 0.7, p16: 0.2 };

    let step = 0; // global 16th counter; all bar logic hangs off it
    const drumLoop = new Tone.Loop(time => {
      const s = step % 16;
      if (s === 0) onBar(time);
      if (KICKS[patIdx].includes(s)) kick.triggerAttackRelease('C1', '8n', time);
      if (SNARES[patIdx].includes(s)) snare.triggerAttackRelease('16n', time);
      step++;
    }, '16n');

    let hatStep = 0;
    const hatLoop = new Tone.Loop(time => {
      const s = hatStep % 16;
      if (s % 2 === 0) hat.triggerAttackRelease('16n', time, hatCtl.vel);            // straight 8ths
      else if (Math.random() < hatCtl.p16) hat.triggerAttackRelease('16n', time, hatCtl.vel * 0.6); // ghost 16ths
      hatStep++;
    }, '16n');

    let bassStep = 0;
    const bassLoop = new Tone.Loop(time => {
      const note = BASS_RIFFS[patIdx][bassStep % 32];
      if (note) bass.triggerAttackRelease(note, '8n', time);
      bassStep++;
    }, '16n');

    let padBar = 0;
    const padLoop = new Tone.Loop(time => {
      const c = CHORDS[padBar % 4];
      const notes = add9 ? [...c.n, c.add9] : c.n;
      pad.triggerAttackRelease(notes, '1m', time, 0.6);
      padBar++;
    }, '1m');

    let arpStep = 0;
    const arpLoop = new Tone.Loop(time => {
      const note = ARPS[patIdx][arpStep % 16];
      if (note && arpOn) arp.triggerAttackRelease(note, '16n', time, 0.5);
      arpStep++;
    }, '16n');

    nodes = { master, percPan, padFilter, reverb, arpGain, sting, hatCtl,
              loops: [drumLoop, hatLoop, bassLoop, padLoop, arpLoop],
              resetSteps() { step = hatStep = bassStep = arpStep = padBar = 0; } };
    built = true;
  }

  // Bar boundary: the only place non-BPM musical parameters change (spec).
  function onBar(time) {
    bar++;

    // pattern rotation every 16 bars regardless of metrics
    patIdx = Math.floor(bar / 16) % BASS_RIFFS.length;

    // score -> pad filter cutoff 400 Hz - 8 kHz (exponential feel)
    const t = clamp(m.score / 100, 0, 1);
    nodes.padFilter.frequency.rampTo(400 * Math.pow(8000 / 400, t), 0.5, time);

    // score -> 9th voicing, with hysteresis
    if (!add9 && m.score > 75) add9 = true;
    else if (add9 && m.score < 70) add9 = false;

    // bounce -> hat velocity + 16th probability: soft feet = busier, crisper
    const soft = clamp((12 - m.bounce) / 8, 0, 1); // bounce 4 m/s2 -> 1, 12+ -> 0
    nodes.hatCtl.vel = 0.4 + 0.5 * soft;
    nodes.hatCtl.p16 = 0.05 + 0.45 * soft;

    // asymmetry -> percussion pan drift, capped at 0.3.
    // asym is unsigned (|a-b| index); drift direction toward the weak side
    // needs the signed balance - calibration knob, wire metrics.balance when
    // Track C exposes it. Until then drift left.
    const side = -1;
    nodes.percPan.pan.rampTo(side * clamp(m.asym * 3, 0, 0.3), 1, time);

    // sway -> reverb wet 0.1 - 0.4 (steady head = tight mix); 0.62 = sway cue threshold
    nodes.reverb.wet.rampTo(0.1 + 0.3 * clamp(m.sway / 0.62, 0, 1), 1, time);

    // reward arp: in after 8 bars above 80, out after 4 bars below 70,
    // and never more than one layer change per 4 bars
    barsAbove80 = m.score > 80 ? barsAbove80 + 1 : 0;
    barsBelow70 = m.score < 70 ? barsBelow70 + 1 : 0;
    if (bar - lastLayerChangeBar >= 4) {
      if (!arpOn && barsAbove80 >= 8) {
        arpOn = true; lastLayerChangeBar = bar;
        nodes.arpGain.gain.rampTo(1, 2, time);
      } else if (arpOn && barsBelow70 >= 4) {
        arpOn = false; lastLayerChangeBar = bar;
        nodes.arpGain.gain.rampTo(0, 2, time);
      }
    }

    // cue: duck -8 dB, two-note sting, hold 1.5 s for the voice, ramp back
    if (cuePending) {
      cuePending = false;
      const g = nodes.master.gain;
      g.cancelScheduledValues(time);
      g.rampTo(0.8 * dbGain(-8), 0.15, time);
      nodes.sting.triggerAttackRelease('G5', '8n', time + 0.05);
      nodes.sting.triggerAttackRelease('C6', '8n', time + 0.25);
      g.rampTo(0.8, 0.8, time + 1.5);
    }
  }

  return {
    async start() {
      if (running) return;
      if (!Tone) {
        await import('./vendor/tone.js'); // UMD build -> window.Tone
        Tone = window.Tone;
      }
      await Tone.start(); // must be inside the user gesture (iOS)
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
      if (!built) build();
      if (nodes.reverb.ready) await nodes.reverb.ready;
      bar = -1;
      nodes.resetSteps();
      Tone.Transport.bpm.value = clamp(m.cadence / 2, 70, 100);
      nodes.loops.forEach(l => l.start(0));
      Tone.Transport.start('+0.05');
      running = true;
    },

    stop() {
      if (!running) return;
      running = false;
      Tone.Transport.stop();
      Tone.Transport.cancel();
      nodes.loops.forEach(l => l.stop());
    },

    // ~1 Hz from the app loop; metrics may be partial/absent - EMA only what arrived
    update(metrics) {
      if (metrics && typeof metrics === 'object') {
        for (const k of Object.keys(m)) {
          const v = metrics[k];
          if (typeof v === 'number' && isFinite(v)) m[k] += ALPHA * (v - m[k]);
        }
      }
      if (running) {
        // BPM is the one mapping applied immediately (2 s glide, never a jump)
        Tone.Transport.bpm.rampTo(clamp(m.cadence / 2, 70, 100), 2);
      }
    },

    // a cue was spoken: duck + sting at the next bar boundary
    onCue() { if (running) cuePending = true; },

    // shared master duck for the voice path (usable while music plays)
    duck(db = -8, holdS = 1.5) {
      if (!running) return;
      const g = nodes.master.gain;
      g.cancelScheduledValues(Tone.now());
      g.rampTo(0.8 * dbGain(db), 0.15);
      setTimeout(() => { if (running) g.rampTo(0.8, 0.8); }, holdS * 1000);
    },

    get running() { return running; },
  };
}

// Convenience singleton so `if (window.music) music.start()` style guards work.
let inst = null;
function ensure() { return (inst ??= create()); }
export const start = () => ensure().start();
export const stop = () => ensure().stop();
export const update = m => ensure().update(m);
export const onCue = () => ensure().onCue();
export const duck = (db, holdS) => ensure().duck(db, holdS);
