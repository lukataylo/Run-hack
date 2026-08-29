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

    try {
      if (handleTelemetry && await handleTelemetry(req, res)) return;
    } catch (e) {
      if (!res.writableEnded) { res.writeHead(500); res.end('telemetry error'); }
      return;
    }

    // static serving is GET/HEAD only
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }

    const url = new URL(req.url, 'http://x');
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
