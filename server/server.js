/**
 * forknife-67 server.
 *
 * Production runs on Cloudflare Workers (see src/worker.js). This is the same
 * API on plain Node, for three things the Worker cannot do: `npm start` with
 * nothing installed, reaching the app over your LAN, and self-hosting it on
 * your own box without Cloudflare in the picture.
 *
 * Zero runtime dependencies on purpose, so there is no npm install step to fail
 * and nothing to patch on a schedule beyond Node itself. It is held to the same
 * externally visible contract as the Worker by test/server.test.js and
 * test/worker/api.test.js, so the two cannot quietly drift apart.
 *
 * Responsibilities:
 *   1. Serve the static PWA out of ../public
 *   2. Provide the optional cross-device sync API (GET/PUT /api/vault/:code)
 *
 * The app is fully usable with the server doing nothing but (1) — sync is
 * strictly additive, so a sync outage never blocks the player.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { mergeDocs, normalizeDoc, compactDoc, isValidCode } from '../public/lib/vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

/** Generous for a 118-entry doc (~21 KB) but small enough to bound memory. */
const MAX_BODY_BYTES = 512 * 1024;

/** Per-IP write budget. A human syncing two devices never approaches this. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITES = 60;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------------------------------------------------------------- */
/* Storage                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Vaults are stored under sha256(code) so a filesystem or backup leak does not
 * hand out working codes. The code itself is never written to disk or logged.
 */
function vaultPath(code) {
  const hash = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
  return path.join(DATA_DIR, `${hash}.json`);
}

async function readVault(code) {
  try {
    const raw = await fsp.readFile(vaultPath(code), 'utf8');
    return normalizeDoc(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // A truncated or corrupted file must not take the endpoint down; treat it
    // as absent so the client's own copy wins on the next PUT.
    console.error('[vault] read failed:', err.message);
    return null;
  }
}

/**
 * Atomic write: a machine losing power mid-write leaves either the old file or
 * the new one, never a half-written vault.
 */
async function writeVault(code, doc) {
  const target = vaultPath(code);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(doc), 'utf8');
  await fsp.rename(tmp, target);
}

/**
 * Serialize writes per vault. Two devices syncing at the same instant would
 * otherwise read-modify-write concurrently and lose one side's edits.
 */
const writeChains = new Map();

function withVaultLock(code, task) {
  const prev = writeChains.get(code) || Promise.resolve();
  const next = prev.then(task, task);
  // Keep the chain alive but never let a rejection poison the next caller.
  writeChains.set(
    code,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/* ---------------------------------------------------------------------- */
/* Rate limiting                                                          */
/* ---------------------------------------------------------------------- */

const rateBuckets = new Map();

function clientIp(req) {
  // Only trust the proxy header when we are actually behind our own proxy.
  const forwarded = req.headers['x-forwarded-for'];
  if (process.env.TRUST_PROXY === '1' && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX_WRITES;
}

// Bounded cleanup so a long-lived process cannot accumulate buckets forever.
const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.start < cutoff) rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
rateSweep.unref();

/* ---------------------------------------------------------------------- */
/* HTTP helpers                                                           */
/* ---------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // Everything is same-origin and self-contained; no external loads at all.
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; '),
};

/* ---------------------------------------------------------------------- */
/* Static files                                                           */
/* ---------------------------------------------------------------------- */

async function serveStatic(req, res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed percent-escape ("%zz") throws; that is a bad request, not a
    // server fault.
    sendJson(res, 400, { error: 'bad path' });
    return;
  }

  // A NUL byte truncates the path inside libc, which is a classic way to slip
  // past an extension check. Nothing legitimate contains one.
  if (decoded.includes('\0')) {
    sendJson(res, 400, { error: 'bad path' });
    return;
  }

  const rel = decoded === '/' ? '/index.html' : decoded;

  // `_headers` lives in public/ because that is where Cloudflare reads it from,
  // but it is configuration for the edge, not a file anyone should be able to
  // fetch. The Worker never serves it; neither should this.
  if (path.basename(rel) === '_headers') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const target = path.join(PUBLIC_DIR, rel);

  // Containment check: rejects ../ traversal and absolute-path tricks.
  const resolved = path.resolve(target);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    stat = null;
  }

  // Single-page app: unknown paths fall back to the shell rather than 404ing,
  // so a bookmarked deep link still boots the app.
  let filePath = resolved;
  if (!stat || stat.isDirectory()) {
    if (rel.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    filePath = path.join(PUBLIC_DIR, 'index.html');
    try {
      stat = await fsp.stat(filePath);
    } catch {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  // The shell must never be served stale, or a deploy would not reach devices
  // that already installed the app — and that has to include the scripts. No
  // filename here carries a content hash, so a cached app.js will happily pair
  // itself with a freshly fetched index.html, and half-updated is worse than
  // not updated at all.
  //
  // Mirrors public/_headers, which does the same job for the edge-served copy.
  // `no-cache` means revalidate, not "don't store": the ETag above turns nearly
  // all of these into a 304.
  const isShell = ext === '.html' || ext === '.css' || ext === '.js';
  const cacheControl = isShell ? 'no-cache' : 'public, max-age=3600, must-revalidate';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cacheControl, ...SECURITY_HEADERS });
    res.end();
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    etag,
    'cache-control': cacheControl,
    ...SECURITY_HEADERS,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ---------------------------------------------------------------------- */
/* API                                                                    */
/* ---------------------------------------------------------------------- */

async function handleVault(req, res, code) {
  if (!isValidCode(code)) {
    sendJson(res, 400, { error: 'invalid vault code' });
    return;
  }

  if (req.method === 'GET') {
    const doc = await readVault(code);
    if (!doc) {
      sendJson(res, 404, { error: 'vault not found' });
      return;
    }
    sendJson(res, 200, doc);
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    if (rateLimited(clientIp(req))) {
      sendJson(res, 429, { error: 'slow down' });
      return;
    }

    let incoming;
    try {
      incoming = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid json' });
      return;
    }

    const merged = await withVaultLock(code, async () => {
      const existing = await readVault(code);
      // Existing goes first so a tie resolves to what is already stored; the
      // client always stamps updatedAt on a real edit, so real edits still win.
      const result = compactDoc(existing ? mergeDocs(existing, incoming) : normalizeDoc(incoming));
      await writeVault(code, result);
      return result;
    });

    sendJson(res, 200, merged);
    return;
  }

  res.writeHead(405, { allow: 'GET, PUT, POST' });
  res.end();
}

/* ---------------------------------------------------------------------- */
/* Server                                                                 */
/* ---------------------------------------------------------------------- */

export function createServer() {
  return http.createServer(async (req, res) => {
    let urlPath;
    try {
      urlPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }

    try {
      if (urlPath === '/api/health') {
        sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
        return;
      }

      const vaultMatch = urlPath.match(/^\/api\/vault\/([^/]+)$/);
      if (vaultMatch) {
        await handleVault(req, res, vaultMatch[1]);
        return;
      }

      if (urlPath.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }

      await serveStatic(req, res, urlPath);
    } catch (err) {
      console.error('[server] unhandled:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
      else res.destroy();
    }
  });
}

/** True when this file was run directly (not imported by a test). */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const server = createServer();

  server.listen(PORT, HOST, () => {
    console.log(`forknife-67 listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`\n[server] ${signal} received, shutting down`);
      server.close(() => process.exit(0));
      // Do not hang forever on keep-alive connections during a deploy.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
