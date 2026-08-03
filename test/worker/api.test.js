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
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let child;
let stateDir;
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

  // Durable Object storage is persisted to disk, and wrangler's default is a
  // directory inside the repo that outlives the run. Sharing it between runs
  // means yesterday's vaults show up in today's assertions, so every run gets
  // an empty one of its own.
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forknife-wrangler-'));

  child = spawn(
    wrangler,
    [
      'dev',
      '--port', String(port),
      '--inspector-port', '0',
      '--log-level', 'warn',
      '--persist-to', stateDir,
    ],
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

after(async () => {
  await stopWrangler();
  // Only after workerd is gone, or it would rewrite the SQLite files on exit.
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
});

const CODE_A = 'ABCDEFGH12345678';
const CODE_B = 'ZYXWVTSR98765432';

/** A dozen real catalog ids, for the concurrency test. */
const IDS = [
  'water', 'water.gold', 'earth', 'fire.holofoil', 'fishy', 'air.gummy',
  'duck', 'ghost.galaxy', 'dream', 'punk.cube', 'grim', 'zeropoint.quack',
];

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

test('serves the shared modules the browser imports', async () => {
  // vault.js imports catalog.js, so a deploy that ships one without the other
  // leaves the app a blank page.
  for (const file of ['/lib/vault.js', '/lib/catalog.js']) {
    const res = await fetch(`${base}${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), /javascript/, file);
  }
});

test('_headers restores the hardening the Node server applied in code', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('never serves any part of the shell from cache-forever headers', async () => {
  // No filename carries a content hash, so every piece of the shell has to
  // revalidate together. A cached app.js paired with a fresh index.html reads
  // a document written by a schema it does not know and shows an empty
  // collection — a worse failure than simply not updating.
  for (const file of ['/', '/sw.js', '/app.js', '/styles.css', '/lib/vault.js', '/lib/catalog.js']) {
    const res = await fetch(`${base}${file}`);
    assert.match(res.headers.get('cache-control') || '', /no-cache/, `${file} may be served stale`);
  }
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
    sprites: {
      'water.gold': {
        id: 'water.gold', status: 'owned', hunting: false, name: '', notes: 'squadmate has it', updatedAt: 1000,
      },
    },
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).sprites['water.gold'].status, 'owned');

  const stored = await (await fetch(`${base}/api/vault/${CODE_A}`)).json();
  assert.equal(stored.sprites['water.gold'].notes, 'squadmate has it');
});

test('POST is accepted as an alias for PUT', async () => {
  const res = await fetch(`${base}/api/vault/PSTAAAAA11111111`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sprites: { fire: { id: 'fire', status: 'owned', updatedAt: 10 } } }),
  });
  assert.equal(res.status, 200);
});

test('two devices editing different sprites both survive a sync', async () => {
  await put(CODE_B, { sprites: { water: { id: 'water', status: 'owned', updatedAt: 100 } } });
  const merged = await (await put(CODE_B, {
    sprites: { fire: { id: 'fire', status: 'maxed', updatedAt: 110 } },
  })).json();

  assert.equal(merged.sprites.water.status, 'owned', 'the first device edit must not be clobbered');
  assert.equal(merged.sprites.fire.status, 'maxed');
});

test('a stale device cannot overwrite a newer edit', async () => {
  await put(CODE_B, { sprites: { dream: { id: 'dream', status: 'maxed', updatedAt: 5000 } } });
  const merged = await (await put(CODE_B, {
    sprites: { dream: { id: 'dream', status: 'needed', updatedAt: 4000 } },
  })).json();

  assert.equal(merged.sprites.dream.status, 'maxed');
});

test('concurrent writes to one vault do not lose edits', async () => {
  // The property the Durable Object exists to provide. On the Node server this
  // needed an explicit promise-chain lock; here it falls out of there being
  // exactly one single-threaded instance per vault.
  const code = 'CNCRRNT123456789';
  const writes = IDS.map((id, i) =>
    put(code, { sprites: { [id]: { id, status: 'owned', updatedAt: 1000 + i } } }),
  );

  await Promise.all(writes);
  const stored = await (await fetch(`${base}/api/vault/${code}`)).json();

  for (const id of IDS) {
    assert.equal(stored.sprites[id]?.status, 'owned', `${id} was lost in a concurrent write`);
  }
});

test('vaults are isolated from one another', async () => {
  const stored = await (await fetch(`${base}/api/vault/${CODE_A}`)).json();
  assert.equal(stored.sprites.water, undefined, `${CODE_B}'s edits must not appear in ${CODE_A}`);
});

test('untouched sprites are stripped before storage', async () => {
  const code = 'CMPACTAAAA111111';
  await put(code, {
    sprites: {
      water: { id: 'water', status: 'needed', hunting: false, name: '', notes: '', updatedAt: 10 },
      fire: { id: 'fire', status: 'owned', updatedAt: 10 },
    },
  });

  const stored = await (await fetch(`${base}/api/vault/${code}`)).json();
  assert.deepEqual(Object.keys(stored.sprites), ['fire']);
});

test('an entry the server has never heard of is stored rather than dropped', async () => {
  // A device on a newer catalog must not have its progress silently deleted by
  // a server that has not been redeployed yet.
  // No I, L, O or U — CODE_ALPHABET leaves out the lookalike glyphs.
  const code = 'TVTAAAAA11111111';
  await put(code, { sprites: { seven: { id: 'seven', status: 'owned', updatedAt: 10 } } });
  const merged = await (await put(code, {
    sprites: { 'brandnew.holofoil': { id: 'brandnew.holofoil', status: 'maxed', updatedAt: 20 } },
  })).json();

  assert.equal(merged.sprites['brandnew.holofoil'].status, 'maxed');
  assert.equal(merged.sprites.seven.status, 'owned');
});

test('the unreleased setting syncs like any other edit', async () => {
  const code = 'SH0WVNRE1EASED00';
  await put(code, { sprites: { grim: { id: 'grim', status: 'owned', updatedAt: 10 } } });
  const merged = await (await put(code, { sprites: {}, unreleased: true, unreleasedAt: 50 })).json();

  assert.equal(merged.unreleased, true);
  assert.equal(merged.sprites.grim.status, 'owned');
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
    body: JSON.stringify({ sprites: {}, pad: 'x'.repeat(900 * 1024) }),
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
