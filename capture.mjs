// capture.mjs — pull live telemetry off the server and keep it HERE.
// Railway's /tmp is wiped on every deploy, so anything a runner streams is
// lost the next time we ship. This polls the streams and appends new lines to
// data/, which is the only durable copy for analysis.
//
//   node capture.mjs            poll production forever
//   node capture.mjs --once     one pass and exit
//   BASE=http://localhost:3000 node capture.mjs
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.BASE || 'https://form-coach-production-76e3.up.railway.app';
const DIR = join(import.meta.dirname, 'data');
const EVERY_MS = 15000;
const once = process.argv.includes('--once');

// Remember how many lines of each stream we've already stored so a wipe on the
// server (redeploy) doesn't make us re-append everything, and a restart of the
// capture doesn't duplicate.
const stateFile = join(DIR, '.state.json');
async function loadState() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch { return {}; }
}
async function saveState(s) { await writeFile(stateFile, JSON.stringify(s)); }

async function pass(state) {
  let list;
  try {
    list = await (await fetch(`${BASE}/telemetry`)).json();
  } catch (e) {
    console.log(`${new Date().toISOString()}  server unreachable`);
    return 0;
  }
  let added = 0;
  for (const r of list.runners || []) {
    const stream = await (await fetch(`${BASE}/telemetry/${r.runner}`)).text();
    const lines = stream.split('\n').filter(Boolean);
    const key = `runner-${r.runner}`;
    // a shrinking stream means the server was wiped — start counting again
    const seen = (state[key] || 0) > lines.length ? 0 : (state[key] || 0);
    const fresh = lines.slice(seen);
    if (fresh.length) {
      await appendFile(join(DIR, `${key}.jsonl`), fresh.join('\n') + '\n');
      added += fresh.length;
    }
    state[key] = lines.length;
  }
  try {
    const devices = await (await fetch(`${BASE}/devices`)).text();
    await writeFile(join(DIR, 'devices.json'), devices);
  } catch { /* optional */ }
  if (added) console.log(`${new Date().toISOString()}  +${added} snapshots`);
  return added;
}

await mkdir(DIR, { recursive: true });
const state = await loadState();
let total = await pass(state);
await saveState(state);
if (once) {
  console.log(`captured ${total} new snapshot(s) into data/`);
} else {
  console.log(`capturing from ${BASE} every ${EVERY_MS / 1000}s — data/ is the durable copy`);
  setInterval(async () => {
    total += await pass(state);
    await saveState(state);
  }, EVERY_MS);
}
