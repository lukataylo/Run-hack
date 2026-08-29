// sync.js — keeps every device showing the same runs, with no ceremony.
//
// The old design made you type a 6-character code on both devices and press a
// button; if you forgot the button, nothing synced, which is exactly what went
// wrong. This version:
//   * mints a key automatically on first launch — nothing to set up,
//   * pairs by opening a link (#pair=KEY) so the second device types nothing,
//   * syncs by itself on launch, on focus, and after every run,
//   * mirrors a run in progress to any paired device (see live()).
//
// The installed app and the website are separate storage silos, so this is the
// only thing that makes them one account. Zero deps.

const KEY = 'syncKey';
const RUNS_KEY = (user) => `runs:${user}`;
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — this gets read aloud

// The native shell can fall back to its bundled copy (formcoach://), where a
// relative URL would resolve into the bundle and vanish. Anything that must
// reach the server goes through here.
export const apiBase = () =>
  /^https?:$/.test(location.protocol) ? '' : 'https://form-coach-production-76e3.up.railway.app';

function mint() {
  let k = '';
  for (let i = 0; i < 6; i++) k += ABC[Math.floor(Math.random() * ABC.length)];
  return k;
}

// Auto-created on first call: an account nobody had to sign up for.
export function getKey() {
  try {
    let k = localStorage.getItem(KEY);
    if (!k) { k = mint(); localStorage.setItem(KEY, k); }
    return k;
  } catch { return mint(); } // private mode: ephemeral but functional
}

export function setKey(k) {
  const clean = String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (clean.length !== 6) return '';
  try { localStorage.setItem(KEY, clean); } catch {}
  return clean;
}

export function newKey() { const k = mint(); try { localStorage.setItem(KEY, k); } catch {} return k; }

// A link that pairs the device that opens it — the whole handshake is one tap.
export function pairLink() {
  const origin = apiBase() || location.origin;
  return `${origin}/#pair=${getKey()}`;
}

// Call once at boot: if we arrived via a pair link, adopt that key.
export function adoptFromUrl() {
  try {
    const m = /[#&]pair=([A-Z0-9]{6})/i.exec(location.hash || '');
    if (!m) return null;
    const k = setKey(m[1]);
    history.replaceState(null, '', location.pathname + location.search); // don't re-pair on reload
    return k || null;
  } catch { return null; }
}

function localRuns(user) {
  try { return JSON.parse(localStorage.getItem(RUNS_KEY(user)) || '[]'); } catch { return []; }
}

// Merge by id. When both sides have a run, keep the richer copy: a run that was
// uploaded mid-session has a shorter timeline than the finished one.
export function mergeRuns(a, b) {
  const byId = new Map();
  for (const r of [...(a || []), ...(b || [])]) {
    if (!r || !r.id || r.id === 'demo') continue; // the seeded sample never syncs
    const prev = byId.get(r.id);
    if (!prev || (r.timeline?.length || 0) > (prev.timeline?.length || 0)) byId.set(r.id, r);
  }
  return [...byId.values()]
    .sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))
    .slice(0, 20);
}

let lastResult = { at: 0, ok: false, count: 0 };
export const status = () => lastResult;

// Push ours, pull theirs, merge, push the union so both sides end up identical.
// Never throws — a dead spot must not be able to break the app.
export async function sync(user = '1') {
  const key = getKey();
  const base = apiBase();
  try {
    const mine = localRuns(user);
    if (mine.length) {
      await fetch(`${base}/sync/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runs: mine }),
      });
    }
    const r = await fetch(`${base}/sync/${key}`);
    if (!r.ok) throw new Error(String(r.status));
    const { runs = [] } = await r.json();
    const merged = mergeRuns(mine, runs);
    try { localStorage.setItem(RUNS_KEY(user), JSON.stringify(merged)); } catch {}
    lastResult = { at: Date.now(), ok: true, count: merged.length };
    return merged.length;
  } catch {
    lastResult = { at: Date.now(), ok: false, count: 0 };
    return -1;
  }
}

// Sync on launch, whenever the app comes back to the foreground, and after a
// run — the three moments where data actually changes. Returns a stop().
export function autoSync(user = '1', onDone = () => {}) {
  const go = async () => { const n = await sync(user); if (n >= 0) onDone(n); };
  go();
  const onVis = () => { if (document.visibilityState === 'visible') go(); };
  document.addEventListener('visibilitychange', onVis);
  addEventListener('focus', go);
  const iv = setInterval(go, 120000); // slow safety net; the events do the work
  return {
    now: go,
    stop() { document.removeEventListener('visibilitychange', onVis); removeEventListener('focus', go); clearInterval(iv); },
  };
}

// ---- live mirroring -------------------------------------------------------
// While a run is happening the phone posts snapshots here; any paired device
// polls and renders them. This is what makes the website feel connected to the
// run rather than a place you read about it afterwards.
export async function pushLive(snap) {
  try {
    await fetch(`${apiBase()}/live/${getKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snap),
      keepalive: true,
    });
  } catch { /* fire and forget */ }
}

export async function fetchLive() {
  try {
    const r = await fetch(`${apiBase()}/live/${getKey()}`, { cache: 'no-store' });
    if (!r.ok) return { live: false, snap: null };
    return await r.json();
  } catch { return { live: false, snap: null }; }
}

// Poll for a run in progress. onUpdate({live, snap, ageMs}) every 2 s.
export function watchLive(onUpdate) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const s = await fetchLive();
    if (!stopped) onUpdate(s);
  };
  tick();
  const iv = setInterval(tick, 2000); // setInterval, never rAF (house rule)
  return () => { stopped = true; clearInterval(iv); };
}
