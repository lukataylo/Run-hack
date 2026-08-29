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

const server = createServer(async (req, res) => {
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

  // static files with path-traversal protection: resolve, then require under ROOT
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
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
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`form-coach on :${PORT}`));
