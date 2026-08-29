// head.js — AirPods sample buffer. The native shell calls window.__head(sample)
// per CMHeadphoneMotionManager update (~25 Hz), sample = {t, ax..gz} in ms / m/s².
// CAP 512 ≈ 20 s at 25 Hz — the analysis windows requested are ≤6 s, so a
// bigger ring only wastes memory and lengthens getWindow scans.
const CAP = 512;
const buf = new Array(CAP);
let head = 0, count = 0, lastWall = 0, lastT = -Infinity;

if (typeof window !== 'undefined') {
  window.__head = (s) => {
    // a timestamp lower than the previous sample means the native clock reset
    // (motion restart): mixing old and new epochs makes stale-window garbage —
    // drop the buffer and start clean from this sample's epoch
    if (s.t < lastT) { head = 0; count = 0; }
    lastT = s.t;
    buf[head] = s;
    head = (head + 1) % CAP;
    if (count < CAP) count++;
    lastWall = Date.now();
  };
}

export function reset() {
  head = 0;
  count = 0;
  lastT = -Infinity;
}

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
