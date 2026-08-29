// head.js — AirPods sample buffer. The native shell calls window.__head(sample)
// per CMHeadphoneMotionManager update (~25 Hz), sample = {t, ax..gz} in ms / m/s².
const CAP = 4096; // ring capacity ≈ 160 s at 25 Hz
const buf = new Array(CAP);
let head = 0, count = 0, lastWall = 0;

if (typeof window !== 'undefined') {
  window.__head = (s) => {
    buf[head] = s;
    head = (head + 1) % CAP;
    if (count < CAP) count++;
    lastWall = Date.now();
  };
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
