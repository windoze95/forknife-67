import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

let server;
let base;
let dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forknife-test-'));
  process.env.DATA_DIR = dataDir;

  const { createServer } = await import('../server/server.js');
  server = createServer();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
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

test('health endpoint reports ok', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('serves the app shell', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);

  const html = await res.text();
  assert.match(html, /forknife/i);
});

test('serves the shared vault module the browser imports', async () => {
  const res = await fetch(`${base}/lib/vault.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('sets hardening headers on static responses', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('never serves any part of the shell from cache-forever headers', async () => {
  // No filename carries a content hash, so every piece of the shell has to
  // revalidate together. A cached app.js paired with a fresh index.html reads
  // a document written by a schema it does not know and shows an empty
  // collection — a worse failure than simply not updating.
  for (const file of ['/', '/sw.js', '/app.js', '/styles.css', '/lib/vault.js', '/lib/catalog.js']) {
    const res = await fetch(`${base}${file}`);
    assert.equal(res.headers.get('cache-control'), 'no-cache', `${file} may be served stale`);
  }

  // Artwork does not have this problem and should stay cacheable.
  const icon = await fetch(`${base}/icons/icon-192.png`);
  assert.match(icon.headers.get('cache-control'), /max-age=\d+/);
});

test('_headers is edge configuration, never a served file', async () => {
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

/**
 * fetch() normalises `/../` away before the request leaves the process, so a
 * traversal has to be sent down a raw socket to reach the server at all.
 */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });

    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(4000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
  });
}

test('no traversal form ever leaks a file outside public/', async () => {
  // The property that matters is "nothing outside public/ comes back", not any
  // particular status. Most of these are normalised by the URL parser into a
  // harmless in-scope path and land on the SPA shell; only the %2f form still
  // looks like a traversal by the time the containment check sees it.
  for (const target of [
    '/../package.json',
    '/..%2fpackage.json',
    '/..%2F..%2Fetc%2Fpasswd',
    '/lib/../../server/server.js',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/....//package.json',
  ]) {
    const response = await rawGet(target);

    assert.ok(!response.includes('"forknife-67"'), `${target} leaked package.json`);
    assert.ok(!response.includes('MAX_BODY_BYTES'), `${target} leaked server source`);
    assert.ok(!response.includes('root:x:'), `${target} leaked /etc/passwd`);
    assert.ok(!/^HTTP\/1\.1 5/.test(response), `${target} caused a server error`);
  }
});

test('a traversal that survives URL normalisation is refused outright', async () => {
  // %2f is not decoded during normalisation, so this one reaches the
  // containment check and must be rejected there.
  const response = await rawGet('/..%2fpackage.json');
  assert.match(response, /^HTTP\/1\.1 403/);
});

test('a malformed percent-escape is a 400, not a crash', async () => {
  const response = await rawGet('/%zz');
  assert.match(response, /^HTTP\/1\.1 400/);
});

test('a traversal that resolves back inside public/ is still served', async () => {
  // Guards against the containment check being so strict it breaks real URLs.
  const response = await rawGet('/lib/../styles.css');
  assert.match(response, /^HTTP\/1\.1 200/);
  assert.match(response, /--maxed/);
});

test('rejects malformed vault codes without touching disk', async () => {
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

test('the raw vault code is never used as a filename', async () => {
  const files = await fs.readdir(dataDir);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(!file.includes(CODE_A), 'the code itself must not appear on disk');
    assert.match(file, /^[a-f0-9]{64}\.json$/);
  }
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

  // The server destroys the socket once the cap is passed, so either a 413 or
  // a connection reset is a pass — what matters is that it is not accepted.
  if (huge) assert.notEqual(huge.status, 200);

  const stillThere = await fetch(`${base}/api/vault/${CODE_A}`);
  assert.equal(stillThere.status, 200, 'a bad request must not corrupt the stored vault');
});

test('a corrupted vault file does not take the endpoint down', async () => {
  const code = 'CRRPT11111111111';
  await put(code, { sprites: { seven: { id: 'seven', status: 'owned', updatedAt: 1 } } });

  const files = await fs.readdir(dataDir);
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
  assert.ok(files.includes(`${hash}.json`));
  await fs.writeFile(path.join(dataDir, `${hash}.json`), '{ truncated');

  const res = await fetch(`${base}/api/vault/${code}`);
  assert.equal(res.status, 404, 'unreadable vault reads as absent rather than 500');

  const recovered = await put(code, { sprites: { seven: { id: 'seven', status: 'maxed', updatedAt: 2 } } });
  assert.equal(recovered.status, 200, 'the client copy can heal the vault');
});

test('DELETE is not an accepted method on a vault', async () => {
  const res = await fetch(`${base}/api/vault/${CODE_A}`, { method: 'DELETE' });
  assert.equal(res.status, 405);
});
