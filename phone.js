// phone.js — the phone's motion buffer. Deliberately mirrors head.js's shape
// (start/getWindow/isStreaming/reset) so calibration and the 1 Hz run loop read
// from ONE source instead of each growing their own devicemotion handler.
//
// Sample shape is the app-wide contract: {t, ax, ay, az, gx, gy, gz} — t in ms
// relative to the FIRST sample, a* gravity-removed m/s², g* including gravity.
//
// CAP 1024 ≈ 17 s at 60 Hz. The analysis windows asked for are ≤6 s, so a
// bigger ring only wastes memory and lengthens getWindow scans.
const CAP = 1024;
const buf = new Array(CAP);
let head = 0, count = 0, lastWall = 0, t0 = 0;

let listening = false;
let starting = null; // in-flight/settled start() promise (idempotence)

// FALLBACK ONLY: some Androids (and a few desktop emulators) report
// e.acceleration as null. Gravity is then estimated as a slow low-pass of
// accelerationIncludingGravity and subtracted — an EMA with alpha 0.9 tracks
// re-orientation within ~a second while leaving stride-rate motion in the
// residual. Never used when the platform gives us a real gravity-removed vector.
const G_ALPHA = 0.9;
let gEma = null;

function onMotion(e) {
  try {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    const gx = g.x || 0, gy = g.y || 0, gz = g.z || 0;
    let ax, ay, az;
    const a = e.acceleration;
    if (a && a.x != null) {
      ax = a.x || 0; ay = a.y || 0; az = a.z || 0;
    } else {
      // fallback (see G_ALPHA above)
      if (!gEma) gEma = { x: gx, y: gy, z: gz };
      gEma.x = G_ALPHA * gEma.x + (1 - G_ALPHA) * gx;
      gEma.y = G_ALPHA * gEma.y + (1 - G_ALPHA) * gy;
      gEma.z = G_ALPHA * gEma.z + (1 - G_ALPHA) * gz;
      ax = gx - gEma.x; ay = gy - gEma.y; az = gz - gEma.z;
    }
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (count === 0) t0 = now;
    buf[head] = { t: now - t0, ax, ay, az, gx, gy, gz };
    head = (head + 1) % CAP;
    if (count < CAP) count++;
    lastWall = Date.now();
  } catch { /* one malformed event must never break the stream */ }
}

// Idempotent. On iOS the DeviceMotionEvent.requestPermission() call below MUST
// happen inside a user gesture — callers own that. The listener is attached
// either way: in our WKWebView shell the permission call can fail while events
// still flow, and an attached listener costs nothing when they do not.
// Resolves true when motion is permitted, false when it was refused.
export function start() {
  if (starting) return starting;
  starting = (async () => {
    let ok = true;
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        ok = (await DeviceMotionEvent.requestPermission()) === 'granted';
      }
    } catch { ok = false; }
    try {
      if (!listening && typeof addEventListener === 'function') {
        addEventListener('devicemotion', onMotion);
        listening = true;
      }
    } catch { /* no window: buffer stays empty, callers see isStreaming() false */ }
    // a refusal must not be cached — the next in-gesture tap should re-ask
    if (!ok) starting = null;
    return ok;
  })();
  return starting;
}

export function reset() {
  head = 0;
  count = 0;
  gEma = null;
}

// newest-last, t in ms relative to the first sample ever buffered
export function getWindow(ms) {
  if (count === 0) return [];
  const newest = buf[(head - 1 + CAP) % CAP];
  const cutoff = newest.t - ms;
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = buf[(head - count + i + CAP) % CAP];
    if (s.t >= cutoff) out.push(s);
  }
  return out;
}

export function isStreaming() {
  return lastWall > 0 && Date.now() - lastWall < 2000;
}

// samples/second measured over the last 2 s of buffer (0 when too little data)
export function rate() {
  const w = getWindow(2000);
  if (w.length < 2) return 0;
  const span = (w[w.length - 1].t - w[0].t) / 1000;
  return span > 0.2 ? Math.round((w.length - 1) / span) : 0;
}
