// session-server.js — telemetry endpoints (Track C). node:http handlers, zero deps.
// Track A's server.js imports { handleTelemetry } and calls it before static files.
// Storage: /tmp/telemetry/runner-N.jsonl — ephemeral by design (race telemetry,
// not a system of record).

import fs from 'node:fs';
import path from 'node:path';

// overridable so the self-test (and tests generally) never pollute live race telemetry
let DIR = process.env.TELEMETRY_DIR || '/tmp/telemetry';
const MAX_BODY = 512 * 1024;       // 512 KB per POST (bytes)
const MAX_FILE = 20 * 1024 * 1024; // stop appending past 20 MB
let dirMade = false;

function ensureDir() {
  if (!dirMade) { fs.mkdirSync(DIR, { recursive: true }); dirMade = true; }
}

function filePath(n) { return path.join(DIR, `runner-${n}.jsonl`); }

// CORS + OPTIONS live in server.js, which decorates every response before
// handleTelemetry is called — no duplicate headers here.
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Count newline bytes streaming in 64 KB chunks (files can reach 20 MB).
function countLines(fp) {
  return new Promise((resolve) => {
    let n = 0, lastByte = 0;
    const s = fs.createReadStream(fp, { highWaterMark: 65536 });
    s.on('data', (buf) => {
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
      lastByte = buf[buf.length - 1];
    });
    s.on('end', () => resolve(lastByte !== 0 && lastByte !== 10 ? n + 1 : n));
    s.on('error', () => resolve(n));
  });
}

// Last line without reading the whole file: tail-read up to 64 KB.
// Buffers are concatenated as bytes and decoded once — per-chunk string concat
// corrupts multi-byte UTF-8 split across chunk boundaries.
// Returns null when the tail window holds no complete line (a >64 KB line
// would otherwise be served as a mid-line fragment).
function lastLine(fp, size) {
  return new Promise((resolve, reject) => {
    const start = Math.max(0, size - 65536);
    const chunks = [];
    const s = fs.createReadStream(fp, { start });
    s.on('data', (b) => { chunks.push(b); });
    s.on('error', reject);
    s.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
      // tail window larger than the window start with no newline: we cannot
      // know where the line begins — refuse rather than return a fragment
      if (start > 0 && !data.includes('\n')) return resolve(null);
      const lines = data.split('\n').filter((l) => l.trim().length > 0);
      resolve(lines.length ? lines[lines.length - 1] : null);
    });
  });
}

// Returns true if the request was handled (any /telemetry* path), false otherwise.
export async function handleTelemetry(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return false; }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'telemetry') return false;

  // GET /telemetry — list runners that have data, with line counts
  if (parts.length === 1 && req.method === 'GET') {
    const out = [];
    for (const n of [1, 2, 3]) {
      const fp = filePath(n);
      try {
        const st = fs.statSync(fp);
        out.push({ runner: n, lines: await countLines(fp), bytes: st.size });
      } catch { /* no data for this runner */ }
    }
    json(res, 200, { runners: out });
    return true;
  }

  const n = parts[1];
  if (parts.length !== 2 || !/^[123]$/.test(n)) {
    json(res, 404, { error: 'unknown telemetry path (runners 1-3 only)' });
    return true;
  }
  const fp = filePath(n);

  if (req.method === 'POST') {
    // collect Buffers and decode once at parse time — `body += chunk` string
    // concat corrupts multi-byte UTF-8 split across chunk boundaries, and the
    // cap must count BYTES, not JS string length
    const chunks = [];
    let bytes = 0;
    let dead = false;
    req.on('data', (chunk) => {
      if (dead) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        dead = true;
        json(res, 413, { error: 'body too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (dead) return;
      let obj;
      try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      try {
        ensureDir();
        let size = 0;
        try { size = fs.statSync(fp).size; } catch { /* new file */ }
        const line = JSON.stringify(obj) + '\n';
        // check BEFORE appending so the file can never blow past the cap
        if (size + Buffer.byteLength(line) > MAX_FILE) {
          return json(res, 507, { ok: false, capped: true, error: 'telemetry file full' });
        }
        fs.appendFileSync(fp, line);
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 500, { error: String(e && e.message) });
      }
    });
    req.on('error', () => { /* client vanished mid-POST; nothing to do */ });
    return true;
  }

  if (req.method === 'GET') {
    let st;
    try { st = fs.statSync(fp); } catch {
      json(res, 404, { error: `no data for runner ${n}` });
      return true;
    }
    if (url.searchParams.get('latest') === '1') {
      try {
        const line = await lastLine(fp, st.size);
        // empty file, or no complete line in the tail window: a JSON error,
        // never a bare "\n" or a mid-line fragment with a 200
        if (line == null) {
          json(res, 500, { error: 'no complete line available' });
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(line + '\n');
      } catch (e) {
        json(res, 500, { error: String(e && e.message) });
      }
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Length': st.size,
    });
    const stream = fs.createReadStream(fp);
    stream.on('error', () => res.end()); // stat raced a delete; don't crash
    stream.pipe(res);
    return true;
  }

  json(res, 405, { error: 'method not allowed' });
  return true;
}

// ---- self-test: node session-server.js ----
if (process.argv[1] && process.argv[1].endsWith('session-server.js')) {
  const { createServer } = await import('node:http');
  const os = await import('node:os');
  // never pollute live race telemetry: the self-test writes to its own temp dir
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-selftest-'));
  dirMade = false;
  const srv = createServer((req, res) => {
    handleTelemetry(req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('not telemetry'); }
    });
  });
  srv.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    let pass = true;
    const check = (ok, label) => {
      console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
      if (!ok) pass = false;
    };
    try {
      const marker = `selftest-${Date.now()}-émoji✓`; // multi-byte UTF-8 must survive chunking
      const snap = { user: 3, mode: 'hand', km: 1.23, cues: [], timeline: [], t: Date.now(), marker };

      let r = await fetch(`${base}/telemetry/3`, { method: 'POST', body: JSON.stringify(snap) });
      check(r.status === 200 && (await r.json()).ok === true, 'POST /telemetry/3 accepted');

      r = await fetch(`${base}/telemetry/3?latest=1`);
      const last = JSON.parse(await r.text());
      check(r.status === 200 && last.marker === marker, 'GET ?latest=1 returns the posted snapshot');

      r = await fetch(`${base}/telemetry/3`);
      const body = await r.text();
      check(r.status === 200 && body.includes(marker), 'GET /telemetry/3 streams JSONL containing snapshot');

      r = await fetch(`${base}/telemetry`);
      const list = await r.json();
      check(r.status === 200 && list.runners.some((x) => x.runner === 3 && x.lines >= 1), 'GET /telemetry lists runner 3');

      r = await fetch(`${base}/telemetry/5`, { method: 'POST', body: '{}' });
      check(r.status === 404, 'runner 5 rejected');

      r = await fetch(`${base}/telemetry/3`, { method: 'POST', body: 'not json' });
      check(r.status === 400, 'invalid JSON rejected');

      r = await fetch(`${base}/telemetry/3`, { method: 'DELETE' });
      check(r.status === 405, 'DELETE rejected 405');

      r = await fetch(`${base}/other`);
      check(r.status === 404 && (await r.text()) === 'not telemetry', 'non-telemetry path falls through');
    } catch (e) {
      console.log('FAIL self-test threw:', e);
      pass = false;
    }
    srv.close();
    console.log(pass ? 'ALL PASS' : 'FAILURES');
    process.exit(pass ? 0 : 1);
  });
}
