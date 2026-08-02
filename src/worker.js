/**
 * forknife-67 on Cloudflare Workers.
 *
 * The static PWA is served by Workers Static Assets straight from `public/`,
 * without invoking this script at all — `run_worker_first` in wrangler.jsonc
 * limits that to `/api/*`. So this file is only the sync API:
 *
 *   GET  /api/health
 *   GET  /api/vault/:code      the stored document, or 404
 *   PUT  /api/vault/:code      merge and return the result
 *   POST /api/vault/:code      same as PUT
 *
 * The app is fully usable with none of this reachable — sync is strictly
 * additive, so an outage here never blocks the player.
 */

import { isValidCode } from '../public/lib/vault.js';

export { VaultObject } from './vault-object.js';

/** Generous for a 111-entry doc (~20 KB) but small enough to bound memory. */
const MAX_BODY_BYTES = 512 * 1024;

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * Vaults are addressed by sha256(code) so the code itself never becomes a
 * Durable Object name, which would surface it in dashboards and logs.
 */
async function vaultName(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the body with a hard ceiling. `request.text()` would happily buffer
 * whatever was sent, so the limit is enforced while streaming.
 */
async function readBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('payload too large'), { status: 413 });
  }

  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('payload too large'), { status: 413 });
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function handleVault(request, env, code) {
  if (!isValidCode(code)) return json(400, { error: 'invalid vault code' });

  const stub = env.VAULT.get(env.VAULT.idFromName(await vaultName(code)));

  if (request.method === 'GET') {
    const doc = await stub.read();
    return doc ? json(200, doc) : json(404, { error: 'vault not found' });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    let incoming;
    try {
      incoming = JSON.parse(await readBody(request));
    } catch (err) {
      return json(err.status || 400, { error: err.status ? err.message : 'invalid json' });
    }

    const result = await stub.write(incoming);
    return result.ok ? json(200, result.doc) : json(result.status, { error: result.error });
  }

  return new Response(null, { status: 405, headers: { allow: 'GET, PUT, POST' } });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    try {
      if (pathname === '/api/health') {
        // No `uptime` counterpart to the Node server's: a Worker isolate's age
        // says nothing about the service, so reporting one would be noise.
        return json(200, { ok: true, runtime: 'workers' });
      }

      const vaultMatch = pathname.match(/^\/api\/vault\/([^/]+)$/);
      if (vaultMatch) {
        return await handleVault(request, env, vaultMatch[1]);
      }

      if (pathname.startsWith('/api/')) {
        return json(404, { error: 'not found' });
      }

      // Only reachable if run_worker_first is ever widened; hand it back to the
      // static assets so the SPA keeps working either way.
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('[worker] unhandled:', err);
      return json(500, { error: 'server error' });
    }
  },
};
