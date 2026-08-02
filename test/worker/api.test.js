/**
 * Contract tests for the Cloudflare Worker, run against a real `wrangler dev`.
 *
 * Kept out of `npm test` because it boots workerd, which the app itself does
 * not depend on:
 *
 *   npm run test:worker
 *
 * The overlap with test/server.test.js is deliberate. Both suites assert the
 * same externally visible contract against two different runtimes, so the Node
 * dev server and the deployed Worker cannot quietly drift apart. What is *not*
 * duplicated is anything filesystem-shaped — path traversal, on-disk
 * filenames, corrupted files — because none of it exists on Workers.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let child;
let base = process.env.BASE_URL || '';

/** Ask the OS for a port, then let go of it, so wrangler can bind it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // wrangler is still starting; workerd has not bound the port yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error(`wrangler dev never became healthy at ${url}`);
}

before(async () => {
  // BASE_URL points the suite at an already-running instance — a `wrangler dev`
  // you started yourself, or a real deployment.
  if (base) {
    await waitForHealth(base);
    return;
  }

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  // Run the wrangler binary directly rather than through `npx`, and in its own
  // process group. wrangler spawns workerd as a grandchild: signalling only the
  // process we hold leaves workerd alive, and its still-open stdio pipes keep
  // this test process from ever exiting. Killing the group is what makes
  // teardown reliable — macOS tolerated the sloppier version, Linux did not.
  const wrangler = path.join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');

  child = spawn(
    wrangler,
    ['dev', '--port', String(port), '--inspector-port', '0', '--log-level', 'warn'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    },
  );

  const output = [];
  child.stdout.on('data', (c) => output.push(c.toString()));
  child.stderr.on('data', (c) => output.push(c.toString()));
  child.on('error', (err) => output.push(`spawn failed: ${err.message}`));

  try {
    await waitForHealth(base);
  } catch (err) {
    await stopWrangler();
    throw new Error(`${err.message}\n\nwrangler output:\n${output.join('') || '(none)'}`);
  }
});

/** Kill the whole wrangler process group, workerd included. */
async function stopWrangler() {
  if (!child || child.exitCode !== null) return;

  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone, or never started.
    return;
  }

  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Nothing left to kill.
    }
  }, 5000);

  await exited;
  clearTimeout(timer);

  // Nothing should be holding the event loop open once the group is gone, but
  // an unread pipe would do exactly that.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

after(stopWrangler);

const CODE_A = 'ABCDEFGH12345678';
const CODE_B = 'ZYXWVTSR98765432';

function put(code, body) {
  return fetch(`${base}/api/vault/${code}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ------------------------------ static side ----------------------------- */

test('health endpoint reports ok', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('serves the app shell', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /forknife/i);
});

test('serves the shared vault module the browser imports', async () => {
  const res = await fetch(`${base}/lib/vault.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('_headers restores the hardening the Node server applied in code', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('never serves the app shell from cache-forever headers', async () => {
  const shell = await fetch(`${base}/`);
  assert.match(shell.headers.get('cache-control'), /no-cache/);

  const sw = await fetch(`${base}/sw.js`);
  assert.match(sw.headers.get('cache-control'), /no-cache/, 'a cached SW would freeze deploys');
});

test('_headers is configuration, not a public file', async () => {
  // It lives inside the asset directory, so the thing worth asserting is that
  // its contents are never served. The SPA fallback answers with the shell.
  const res = await fetch(`${base}/_headers`);
  assert.doesNotMatch(await res.text(), /X-Content-Type-Options/, '_headers was served verbatim');
});

test('unknown page paths fall back to the shell, unknown API paths 404', async () => {
  const page = await fetch(`${base}/some/deep/link`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);

  const api = await fetch(`${base}/api/nope`);
  assert.equal(api.status, 404);
});

/* -------------------------------- the API ------------------------------- */

test('rejects malformed vault codes', async () => {
  for (const code of ['short', '../etc/passwd', 'abcdefgh12345678', 'A'.repeat(40)]) {
    const res = await fetch(`${base}/api/vault/${encodeURIComponent(code)}`);
    assert.equal(res.status, 400, `expected 400 for ${code}`);
  }
});

test('GET on an unknown vault is a 404, not an empty vault', async () => {
  const res = await fetch(`${base}/api/vault/QQQQQQQQQQQQQQQQ`);
  assert.equal(res.status, 404);
});

test('PUT stores a vault and GET returns it', async () => {
  const res = await put(CODE_A, {
    total: 111,
    sprites: { 14: { id: 14, status: 'owned', hunting: false, name: 'blue one', notes: '', updatedAt: 1000 } },
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).sprites[14].status, 'owned');

  const stored = await (await fetch(`${base}/api/vault/${CODE_A}`)).json();
  assert.equal(stored.sprites[14].name, 'blue one');
});

test('POST is accepted as an alias for PUT', async () => {
  const res = await fetch(`${base}/api/vault/PSTAAAAA11111111`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ total: 111, sprites: { 3: { id: 3, status: 'owned', updatedAt: 10 } } }),
  });
  assert.equal(res.status, 200);
});

test('two devices editing different sprites both survive a sync', async () => {
  await put(CODE_B, { total: 111, sprites: { 1: { id: 1, status: 'owned', updatedAt: 100 } } });
  const merged = await (await put(CODE_B, {
    total: 111,
    sprites: { 2: { id: 2, status: 'maxed', updatedAt: 110 } },
  })).json();

  assert.equal(merged.sprites[1].status, 'owned', 'the first device edit must not be clobbered');
  assert.equal(merged.sprites[2].status, 'maxed');
});

test('a stale device cannot overwrite a newer edit', async () => {
  await put(CODE_B, { total: 111, sprites: { 5: { id: 5, status: 'maxed', updatedAt: 5000 } } });
  const merged = await (await put(CODE_B, {
    total: 111,
    sprites: { 5: { id: 5, status: 'needed', updatedAt: 4000 } },
  })).json();

  assert.equal(merged.sprites[5].status, 'maxed');
});

test('concurrent writes to one vault do not lose edits', async () => {
  // The property the Durable Object exists to provide. On the Node server this
  // needed an explicit promise-chain lock; here it falls out of there being
  // exactly one single-threaded instance per vault.
  const code = 'CNCRRNT123456789';
  const writes = [];

  for (let i = 1; i <= 12; i += 1) {
    writes.push(put(code, { total: 111, sprites: { [i]: { id: i, status: 'owned', updatedAt: 1000 + i } } }));
  }

  await Promise.all(writes);
  const stored = await (await fetch(`${base}/api/vault/${code}`)).json();

  for (let i = 1; i <= 12; i += 1) {
    assert.equal(stored.sprites[i]?.status, 'owned', `sprite ${i} was lost in a concurrent write`);
  }
});

test('vaults are isolated from one another', async () => {
  const stored = await (await fetch(`${base}/api/vault/${CODE_A}`)).json();
  assert.equal(stored.sprites[1], undefined, `${CODE_B}'s edits must not appear in ${CODE_A}`);
});

test('untouched sprites are stripped before storage', async () => {
  const code = 'CMPACTAAAA111111';
  await put(code, {
    total: 111,
    sprites: {
      1: { id: 1, status: 'needed', hunting: false, name: '', notes: '', updatedAt: 10 },
      2: { id: 2, status: 'owned', updatedAt: 10 },
    },
  });

  const stored = await (await fetch(`${base}/api/vault/${code}`)).json();
  assert.deepEqual(Object.keys(stored.sprites), ['2']);
});

test('a raised total adds slots without losing data', async () => {
  // No I, L, O or U — CODE_ALPHABET leaves out the lookalike glyphs.
  const code = 'TVTAAAAA11111111';
  await put(code, { total: 111, sprites: { 7: { id: 7, status: 'owned', updatedAt: 10 } } });
  const grown = await (await put(code, { total: 150, sprites: {}, totalUpdatedAt: 20 })).json();

  assert.equal(grown.total, 150);
  assert.equal(grown.sprites[7].status, 'owned');
});

test('malformed JSON and oversized bodies are refused', async () => {
  const bad = await fetch(`${base}/api/vault/${CODE_A}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);

  const huge = await fetch(`${base}/api/vault/${CODE_A}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ total: 111, pad: 'x'.repeat(900 * 1024) }),
  }).catch(() => null);

  if (huge) assert.equal(huge.status, 413);

  const stillThere = await fetch(`${base}/api/vault/${CODE_A}`);
  assert.equal(stillThere.status, 200, 'a bad request must not corrupt the stored vault');
});

test('API responses are never cached', async () => {
  const res = await fetch(`${base}/api/vault/${CODE_A}`);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'a cached vault would look like data loss');
});

test('DELETE is not an accepted method on a vault', async () => {
  const res = await fetch(`${base}/api/vault/${CODE_A}`, { method: 'DELETE' });
  assert.equal(res.status, 405);
});
