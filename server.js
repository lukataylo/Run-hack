// server.js — static files + telemetry router. node:http only, no deps.
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
  '.jsonl': 'application/x-ndjson',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// Track C's telemetry handlers (session-server.js) — optional until it lands.
const { handleTelemetry } = await import('./session-server.js').catch(() => ({ handleTelemetry: null }));

// ---- /bodyimage: AI-generated futuristic 3D body heat-map renders ----------
// GET /bodyimage?sig=h2-t1-l0-r1-f2  (severity 0-2 per region). Key stays
// server-side; results cached on disk per signature; the client keeps its SVG
// fallback, so any failure here is invisible. 202 = generating, poll again.
import { mkdir, writeFile } from 'node:fs/promises';
const IMG_DIR = '/tmp/bodyimg';
const SIG_RE = /^h[0-2]-t[0-2]-l[0-2]-r[0-2]-f[0-2]$/;
const inflight = new Set();
const GLOW = ['cool dark grey, no glow', 'a moderate amber glow', 'an intense orange-red glow'];

async function generateBodyImage(sig) {
  const [h, t, l, r, f] = sig.match(/\d/g).map(Number);
  const prompt = `Futuristic 3D medical-grade render of a human runner in full sprint, side profile, on a pure dark charcoal background (#0a0a0c). Semi-translucent dark carbon-fiber anatomical figure with faint holographic wireframe mesh. Thermal heat-map overlays glowing through the body: the head shows ${GLOW[h]}; the mid torso shows ${GLOW[t]}; the front leading leg shows ${GLOW[l]}; the rear trailing leg shows ${GLOW[r]}; the feet show ${GLOW[f]}. Studio rim lighting, ultra high detail, sports-science visualization aesthetic, no text, no labels, no UI.`;
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', size: '1024x1024', quality: 'medium', n: 1, prompt }),
  });
  if (!resp.ok) throw new Error(`openai ${resp.status}`);
  const d = await resp.json();
  await mkdir(IMG_DIR, { recursive: true });
  await writeFile(join(IMG_DIR, `${sig}.png`), Buffer.from(d.data[0].b64_json, 'base64'));
}

// Pre-warm common signatures at boot — /tmp resets every deploy, and Home asks
// for these immediately (the seeded demo run is all-cool). Sequential, lazy.
if (process.env.OPENAI_API_KEY) {
  setTimeout(async () => {
    for (const sig of ['h0-t0-l0-r0-f0', 'h0-t1-l0-r0-f1', 'h1-t1-l1-r1-f1', 'h2-t1-l0-r1-f2']) {
      try { await stat(join(IMG_DIR, `${sig}.png`)); } catch {
        await generateBodyImage(sig).catch(() => {});
      }
    }
  }, 3000);
}

// ---- /sync/<code>: bridge the native app's storage to the web app ---------
// A WKWebView's localStorage is a different silo from Safari's, so runs
// recorded in the installed app cannot be seen on the website without this.
// One JSON blob per pairing code. Ephemeral by design, like telemetry.
const SYNC_DIR = () => join(TELEMETRY_DIR_LOCAL, 'sync');
const CODE_RE = /^[A-Z0-9]{4,8}$/;
async function handleSync(req, res, url) {
  const code = decodeURIComponent(url.pathname.slice('/sync/'.length)).toUpperCase();
  if (!CODE_RE.test(code)) { res.writeHead(400); res.end('{"error":"bad code"}'); return; }
  const file = join(SYNC_DIR(), `${code}.json`);
  if (req.method === 'GET') {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"runs":[]}');
    }
    return;
  }
  if (req.method === 'POST') {
    const chunks = [];
    let bytes = 0;
    for await (const c of req) {
      bytes += c.length;
      if (bytes > 4 * 1024 * 1024) { res.writeHead(413); res.end('{"error":"too big"}'); return; }
      chunks.push(c);
    }
    let incoming = [];
    try { incoming = JSON.parse(Buffer.concat(chunks).toString('utf8')).runs || []; }
    catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
    if (!Array.isArray(incoming)) { res.writeHead(400); res.end('{"error":"bad shape"}'); return; }
    // merge server-side too, so two phones pushing in any order converge
    let existing = [];
    try { existing = JSON.parse(await readFile(file, 'utf8')).runs || []; } catch { /* first push */ }
    const byId = new Map();
    for (const r of [...existing, ...incoming]) {
      if (!r || typeof r !== 'object' || !r.id || r.id === 'demo') continue;
      const prev = byId.get(r.id);
      if (!prev || (r.timeline?.length || 0) > (prev.timeline?.length || 0)) byId.set(r.id, r);
    }
    const runs = [...byId.values()]
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, 20);
    try {
      await mkdir(SYNC_DIR(), { recursive: true });
      await writeFile(file, JSON.stringify({ runs, at: Date.now() }));
    } catch { res.writeHead(500); res.end('{"error":"write failed"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: runs.length }));
    return;
  }
  res.writeHead(405);
  res.end();
}

// ---- /live/<key>: mirror a run in progress onto any other device ----------
// The phone already streams a snapshot every few seconds. Keyed by the pairing
// key (not a device slot) it becomes a live mirror: open the site anywhere
// else with the same key and watch the run happen. In memory only — a live run
// is worthless a minute later, and this must never touch the disk on the hot
// path of somebody actually running.
const live = new Map(); // key -> {snap, at}
const LIVE_TTL_MS = 120000;
async function handleLive(req, res, url) {
  const key = decodeURIComponent(url.pathname.slice('/live/'.length)).toUpperCase();
  if (!CODE_RE.test(key)) { res.writeHead(400); res.end('{"error":"bad key"}'); return; }
  if (req.method === 'POST') {
    const chunks = [];
    let bytes = 0;
    for await (const c of req) {
      bytes += c.length;
      if (bytes > 256 * 1024) { res.writeHead(413); res.end('{}'); return; }
      chunks.push(c);
    }
    let snap;
    try { snap = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
    live.set(key, { snap, at: Date.now() });
    // opportunistic sweep so a long-lived process can't accumulate keys
    if (live.size > 200) {
      for (const [k, v] of live) if (Date.now() - v.at > LIVE_TTL_MS) live.delete(k);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  const entry = live.get(key);
  const ageMs = entry ? Date.now() - entry.at : null;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  // stale = the runner stopped or lost signal; say so rather than showing a
  // frozen dial as if it were live
  res.end(JSON.stringify({
    live: !!entry && ageMs < 20000,
    ageMs,
    snap: entry && ageMs < LIVE_TTL_MS ? entry.snap : null,
  }));
}

// ---- /live-any: freshest run on ANY device, no pairing needed --------------
// The paired /live/<key> mirror needs both devices to share a key first — one
// more step that can silently not have happened. Telemetry already streams
// every 5 s keyed only by slot, so the freshest telemetry line IS a live view
// of whatever run is happening. Zero setup; the mirror falls back to this.
async function handleLiveAny(res) {
  let best = null;
  for (const n of [1, 2, 3]) {
    try {
      const file = join(TELEMETRY_DIR_LOCAL, `runner-${n}.jsonl`);
      const st = await stat(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { n, mtimeMs: st.mtimeMs, file };
    } catch { /* no stream for this slot */ }
  }
  const ageMs = best ? Date.now() - best.mtimeMs : null;
  let snap = null;
  if (best && ageMs < 120000) {
    try {
      // last line of the freshest stream = the current state of that run
      const buf = await readFile(best.file, 'utf8');
      const lines = buf.trimEnd().split('\n');
      snap = JSON.parse(lines[lines.length - 1]);
    } catch { snap = null; }
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ live: !!snap && ageMs < 20000, ageMs, slot: best?.n ?? null, snap }));
}

// ---- device registry: which phone is on which build -----------------------
// The Runner 1/2/3 UI is gone, so phones would otherwise all post to one
// telemetry stream. Each device self-registers on app load and is handed a
// stable slot (1-3) to keep its stream separate. Also records the build it
// loaded, so `curl /devices` answers "is every phone on the latest?".
const DEV_FILE = () => join(TELEMETRY_DIR_LOCAL, 'devices.json');
const TELEMETRY_DIR_LOCAL = process.env.TELEMETRY_DIR || '/tmp/telemetry';
const SERVER_STARTED = new Date().toISOString();
let buildStamp = 'unknown';
try { buildStamp = String((await stat(join(ROOT, 'index.html'))).mtimeMs | 0); } catch { /* fine */ }

async function readDevices() {
  try { return JSON.parse(await readFile(DEV_FILE(), 'utf8')); } catch { return {}; }
}
async function handleHello(req, res) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 4096) break; }
  let j = {};
  try { j = JSON.parse(body); } catch { /* tolerate junk */ }
  const id = String(j.device || '').slice(0, 40).replace(/[^\w-]/g, '');
  if (!id) { res.writeHead(400); res.end('{}'); return; }
  const devices = await readDevices();
  const known = devices[id];
  // "latest" = this device loaded the page AFTER the running server started.
  // The client's own build marker is a static placeholder and can never match
  // the deploy stamp, so comparing it was decorative; check-in time is the
  // honest signal and needs nothing from the client.
  // stable slot per device, 1-3, first come first served (4th+ shares slot 3)
  const used = new Set(Object.values(devices).map((d) => d.slot));
  const slot = known?.slot || [1, 2, 3].find((n) => !used.has(n)) || 3;
  devices[id] = {
    slot,
    build: String(j.build || '').slice(0, 40),
    served: buildStamp,
    latest: true, // it is checking in against THIS server process, right now
    startedAt: SERVER_STARTED,
    ua: String(j.ua || '').slice(0, 120),
    at: new Date().toISOString(),
  };
  try {
    await mkdir(TELEMETRY_DIR_LOCAL, { recursive: true });
    await writeFile(DEV_FILE(), JSON.stringify(devices));
  } catch { /* ephemeral by design */ }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ slot, build: buildStamp }));
}
async function handleDevices(res) {
  const devices = await readDevices();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ build: buildStamp, devices }, null, 2));
}

// ---- /tts: ElevenLabs render for DYNAMIC persona lines --------------------
// Static lines ship as committed mp3s; dynamic ones (km counts, goal
// summaries) hit this, cached by text hash. Key stays server-side. The client
// treats any failure as "use the device voice" — a dead spot never blocks.
import { createHash } from 'node:crypto';
const TTS_DIR = '/tmp/tts';
const ttsInflight = new Map();
async function handleTTS(req, res, url) {
  const text = (url.searchParams.get('text') || '').slice(0, 200).trim();
  if (!text || !process.env.ELEVENLABS_API_KEY) { res.writeHead(404); res.end(); return; }
  const file = join(TTS_DIR, createHash('sha1').update(text).digest('hex') + '.mp3');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    res.end(body);
    return;
  } catch { /* not cached */ }
  try {
    if (!ttsInflight.has(file)) {
      ttsInflight.set(file, (async () => {
        const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB?output_format=mp3_44100_64', {
          method: 'POST',
          headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`tts ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        await mkdir(TTS_DIR, { recursive: true });
        await writeFile(file, buf);
        return buf;
      })().finally(() => ttsInflight.delete(file)));
    }
    const buf = await ttsInflight.get(file);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  } catch {
    res.writeHead(503);
    res.end();
  }
}

async function handleBodyImage(req, res, url) {
  const sig = url.searchParams.get('sig') || '';
  if (!SIG_RE.test(sig) || !process.env.OPENAI_API_KEY) { res.writeHead(404); res.end(); return; }
  const file = join(IMG_DIR, `${sig}.png`);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(body);
    return;
  } catch { /* not cached yet */ }
  if (!inflight.has(sig)) {
    inflight.add(sig);
    generateBodyImage(sig).catch(() => {}).finally(() => inflight.delete(sig));
  }
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end('{"generating":true}');
}

const server = createServer(async (req, res) => {
  // one try/catch around the whole handler: a malformed URL (e.g. /%ZZ making
  // decodeURIComponent throw) must 400, never kill the process
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // POST routes must run before the GET/HEAD gate below
    const p0 = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && p0 === '/hello') { await handleHello(req, res); return; }
    if (p0.startsWith('/sync/')) { await handleSync(req, res, new URL(req.url, 'http://x')); return; }
    if (p0 === '/live-any') { await handleLiveAny(res); return; }
    if (p0.startsWith('/live/')) { await handleLive(req, res, new URL(req.url, 'http://x')); return; }

    try {
      if (handleTelemetry && await handleTelemetry(req, res)) return;
    } catch (e) {
      if (!res.writableEnded) { res.writeHead(500); res.end('telemetry error'); }
      return;
    }

    // static serving is GET/HEAD only
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }

    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/devices') { await handleDevices(res); return; }
    if (url.pathname === '/bodyimage') { await handleBodyImage(req, res, url); return; }
    if (url.pathname === '/tts') { await handleTTS(req, res, url); return; }

    // static files with path-traversal protection: resolve, then require under ROOT
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    // dotfiles (.git, .env, …) are never served
    if (path.split('/').some((seg) => seg.startsWith('.'))) { res.writeHead(403); res.end('forbidden'); return; }
    const file = resolve(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + '/')) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const st = await stat(file); // stat first — bare createReadStream error crashes
      if (!st.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  } catch {
    if (!res.writableEnded) {
      try { res.writeHead(400); } catch { /* headers may already be sent */ }
      res.end('bad request');
    }
  }
});

server.listen(PORT, () => console.log(`form-coach on :${PORT}`));
