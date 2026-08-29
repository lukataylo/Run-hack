// Mascot: SVG robot face, two orange eyes spring-morphing between expressions.
// Driven by setInterval (~30 fps) on purpose - rAF freezes in occluded windows
// and throttled webviews.

import { EXPRESSIONS } from './bot-data.js';

const FPS = 30;
const ACCENT = '#ff5b14';

// per-state blink cadence [min,max] seconds between blinks (0 = never)
const BLINK = {
  idle: [2.5, 6], listening: [2, 5], working: [1.5, 4], happy: [2.5, 6],
  suspicious: [1, 2.5], alerting: [0.8, 2], sleeping: [0, 0],
  celebrate: [1.5, 3.5], proud: [3, 7],
};

const rand = (a, b) => a + Math.random() * (b - a);

export function mountBot(el) {
  el.innerHTML = `
    <svg viewBox="0 0 240 240" style="display:block;width:100%;height:100%">
      <rect x="22" y="34" width="196" height="172" rx="62"
        fill="#17171a" stroke="rgba(244,244,245,0.08)" stroke-width="1.5"/>
      <path fill="${ACCENT}"/>
      <path fill="${ACCENT}"/>
    </svg>`;
  const paths = el.querySelectorAll('path');

  let state = 'idle';
  let from = clone(EXPRESSIONS.idle);
  let to = clone(EXPRESSIONS.idle);
  let morph = 1, vel = 0;

  // blink: 0 = open; rises to 1 mid-blink (eye squashed vertically)
  let blinkAt = rand(...BLINK.idle);
  let blinkT = -1; // seconds into the current blink, -1 = not blinking
  const BLINK_DUR = 0.16;

  // gaze wander: small offset applied to both eyes
  let gx = 0, gy = 0, gtx = 0, gty = 0, gazeAt = 0;

  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - last) / 1000, 0.1); // clamp: a throttled tab must not explode the spring
    last = now;

    // spring toward morph=1 (from spec; overshoot is the charm)
    vel += (-14 * vel - 49 * (morph - 1)) * dt;
    morph += vel * dt;

    // blink clock
    if (blinkT >= 0) {
      blinkT += dt;
      if (blinkT > BLINK_DUR) { blinkT = -1; blinkAt = rand(...BLINK[state]); }
    } else if (BLINK[state][1] > 0) {
      blinkAt -= dt;
      if (blinkAt <= 0) blinkT = 0;
    }
    const squash = blinkT >= 0 ? 1 - 0.92 * Math.sin((blinkT / BLINK_DUR) * Math.PI) : 1;

    // gaze wander
    gazeAt -= dt;
    if (gazeAt <= 0) {
      const r = state === 'sleeping' ? 0 : 7;
      gtx = rand(-r, r); gty = rand(-r, r) * 0.6;
      gazeAt = rand(1.2, 3.5);
    }
    const k = Math.min(dt * 3, 1);
    gx += (gtx - gx) * k;
    gy += (gty - gy) * k;

    for (let e = 0; e < 2; e++) {
      const a = from[e], b = to[e];
      // eye centroid y of the interpolated shape, for blink squash
      let cy = 0;
      const pts = new Array(a.length);
      for (let i = 0; i < a.length; i++) {
        const x = a[i][0] + (b[i][0] - a[i][0]) * morph + gx;
        const y = a[i][1] + (b[i][1] - a[i][1]) * morph + gy;
        pts[i] = [x, y];
        cy += y;
      }
      cy /= pts.length;
      let d = '';
      for (let i = 0; i < pts.length; i++) {
        const y = cy + (pts[i][1] - cy) * squash;
        d += (i ? 'L' : 'M') + pts[i][0].toFixed(1) + ' ' + y.toFixed(1);
      }
      paths[e].setAttribute('d', d + 'Z');
    }
  }, 1000 / FPS);

  function setState(name) {
    if (!EXPRESSIONS[name] || name === state) return;
    // capture the currently displayed geometry so a mid-morph switch is seamless
    const cur = from.map((eye, e) =>
      eye.map((p, i) => [
        p[0] + (to[e][i][0] - p[0]) * morph,
        p[1] + (to[e][i][1] - p[1]) * morph,
      ]));
    from = cur;
    to = clone(EXPRESSIONS[name]);
    morph = 0; vel = 0;
    state = name;
    blinkAt = rand(...BLINK[name]);
  }

  return { setState, get state() { return state; }, destroy() { clearInterval(timer); } };
}

function clone(expr) { return expr.map(eye => eye.map(p => [p[0], p[1]])); }
