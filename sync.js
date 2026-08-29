// sync.js — moves runs between the installed native app and the web app.
// They load the same page but NOT the same storage: a WKWebView has its own
// localStorage, separate from Safari's, so a run recorded in the native app is
// invisible on the website without this.
//
// Model: one short pairing code per runner. Push uploads this device's runs;
// pull merges the server's runs into local storage. Merge is by run id, newest
// first, so pushing and pulling in any order converges. Zero deps.

const KEY_CODE = 'syncCode';
const RUNS_KEY = (user) => `runs:${user}`;

export function getCode() {
  try { return localStorage.getItem(KEY_CODE) || ''; } catch { return ''; }
}
export function setCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  try { localStorage.setItem(KEY_CODE, c); } catch {}
  return c;
}
// Ambiguous characters (0/O, 1/I) left out — this gets read off a screen and
// typed on a phone keyboard.
export function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += abc[Math.floor(Math.random() * abc.length)];
  return setCode(c);
}

function localRuns(user) {
  try { return JSON.parse(localStorage.getItem(RUNS_KEY(user)) || '[]'); } catch { return []; }
}

// Merge by id; a run present in both keeps whichever has the longer timeline
// (a partially-synced run can lose detail otherwise). Newest first, cap 20.
export function mergeRuns(a, b) {
  const byId = new Map();
  for (const r of [...(a || []), ...(b || [])]) {
    if (!r || r.id === 'demo') continue; // the seeded sample never syncs
    const prev = byId.get(r.id);
    if (!prev || (r.timeline?.length || 0) > (prev.timeline?.length || 0)) byId.set(r.id, r);
  }
  return [...byId.values()]
    .sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))
    .slice(0, 20);
}

export async function push(user = '1') {
  const code = getCode();
  if (!code) throw new Error('no code');
  const runs = localRuns(user);
  const r = await fetch(`/sync/${code}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runs }),
  });
  if (!r.ok) throw new Error(`push ${r.status}`);
  return (await r.json()).count ?? runs.length;
}

export async function pull(user = '1') {
  const code = getCode();
  if (!code) throw new Error('no code');
  const r = await fetch(`/sync/${code}`);
  if (!r.ok) throw new Error(`pull ${r.status}`);
  const { runs = [] } = await r.json();
  const merged = mergeRuns(localRuns(user), runs);
  try { localStorage.setItem(RUNS_KEY(user), JSON.stringify(merged)); } catch {}
  return merged.length;
}

// One button: upload ours, merge theirs, upload the union so both sides match.
export async function sync(user = '1') {
  await push(user).catch(() => {});
  const n = await pull(user);
  await push(user).catch(() => {});
  return n;
}
