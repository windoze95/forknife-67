import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkCatalog, SOURCES, extractSpriteNames } from '../tools/check-catalog-drift.js';
import { parseRosterIndex, parseVariantTable, parseBuild } from '../tools/catalog-sources.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog-checklist.json', import.meta.url)));
const indexUrl = SOURCES.find((s) => s.type === 'roster').url;
const jonesyUrl = 'https://spritechecklist.org/sprites/jonesy/';
const baseUrl = 'https://spritechecklist.org/sprites/mega-man/';
const now = new Date('2026-09-10T15:00:00Z');
const replay = (overrides = {}, options = {}) => checkCatalog({
  now,
  ...options,
  fetchImpl: async (url) => {
    const body = Object.hasOwn(overrides, url) ? overrides[url] : fixture.sources[url];
    if (body instanceof Error) throw body;
    return new Response(body ?? 'Unavailable', { status: body == null ? 503 : 200 });
  },
});

test('captured live pages cover every current family and variant', async () => {
  const result = await replay();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.status, 'checked');
  assert.equal(result.reports[1].families, 16);
  assert.equal(result.reports[1].entriesRead, 61);
  // The source still called today's 14 Loot Hackers upcoming. Read those rows
  // too, without downgrading the separately verified catalog's release state.
  assert.equal(result.reports[1].publishedTotal, 47);
  assert.equal(result.reports[1].pendingInSource, 14);
});

test('the missed season update is caught even if a checklist stops changing', async () => {
  const result = await replay({}, { patch: 'v41.30', verified: '2026-09-10' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reports[0].patch, 'v42.10');
  assert.equal(result.reports[0].drifted, true);
});

test('a season rotation cannot silently compare the wrong collection', async () => {
  const result = await replay({ [indexUrl]: fixture.sources[indexUrl].replace('Chapter 7 Season 4', 'Chapter 7 Season 5') });
  assert.equal(result.exitCode, 1);
  assert.match(result.reports[1].reason, /C7 S5/);
});

test('a new base sprite is reported from its actual roster row', async () => {
  const url = 'https://spritechecklist.org/sprites/frostbite/';
  const result = await replay({
    [indexUrl]: fixture.sources[indexUrl].replace('16 Sprites across 47', '17 Sprites across 48')
      + '<a href="/sprites/frostbite/">Frostbite Sprite Rare</a>',
    [url]: fixture.sources[baseUrl].replaceAll('Mega Man', 'Frostbite'),
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result));
  assert.deepEqual(result.reports[1].unknown, ['Frostbite']);
});

test('a new variant of an existing family cannot resolve as its base', async () => {
  const result = await replay({
    [indexUrl]: fixture.sources[indexUrl].replace('16 Sprites across 47', '16 Sprites across 48'),
    [jonesyUrl]: fixture.sources[jonesyUrl].replace('</tbody>',
      '<tr><td>Holofoil Jonesy</td><td>—</td><td>Bonus</td><td>Released</td></tr></tbody>'),
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result));
  assert.deepEqual(result.reports[1].unknown, ['Holofoil Jonesy']);
});

test('all failed sources are incomplete, never a successful empty check', async () => {
  const result = await replay(Object.fromEntries(SOURCES.map((s) => [s.url, null])));
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.reports.every((r) => r.error.includes('HTTP 503')));
});

test('a healthy build does not mask a blocked roster or timed-out family', async () => {
  for (const overrides of [
    { [indexUrl]: '<html><title>Just a moment</title><script>renderRoster()</script></html>' },
    { [jonesyUrl]: new Error('Request timed out') },
    { [jonesyUrl]: '<table><thead><tr><th>Variant</th></tr></thead></table>' },
    { [jonesyUrl]: fixture.sources[jonesyUrl].replaceAll('<td>', '<th>') },
  ]) {
    const result = await replay(overrides);
    assert.equal(result.exitCode, 2, JSON.stringify(result));
    assert.ok(result.reports[1].error);
  }
});

test('partial family coverage and inconsistent totals cannot pass', async () => {
  for (const html of [
    fixture.sources[indexUrl].replace('16 Sprites across', '17 Sprites across'),
    fixture.sources[indexUrl].replace('across 47', 'across 48'),
  ]) {
    const result = await replay({ [indexUrl]: html });
    assert.equal(result.exitCode, 2, JSON.stringify(result));
    assert.match(result.reports[1].error, /Incomplete/);
  }
});

test('same-patch hotfixes cannot leave the catalog unchecked indefinitely', async () => {
  const result = await replay({}, { verified: '2026-08-20' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reviewDue, true);
});

test('an absent build or roster source is not enough evidence to pass', async () => {
  for (const sources of [[], [SOURCES[0]], [SOURCES[1]]]) {
    assert.equal((await replay({}, { sources })).exitCode, 2);
  }
});

test('numbers, hyphens and multiword variant labels survive prose parsing', () => {
  assert.deepEqual(extractSpriteNames('8-Bit Sprite. X-Ray Sprite. Loot Hacker X-Ray Sprite. Cheat Master Storm Scout Sprite.'),
    ['8-Bit', 'X-Ray', 'Loot Hacker X-Ray', 'Cheat Master Storm Scout']);
});

test('source parsers reject empty success payloads and unexpected layouts', () => {
  assert.throws(() => parseRosterIndex('<html>OK</html>', indexUrl), /missing/);
  assert.throws(() => parseVariantTable('<html>OK</html>'), /missing/);
  assert.throws(() => parseBuild('{"status":200,"data":{}}'), /malformed/);
  assert.throws(() => parseVariantTable(fixture.sources[jonesyUrl].replaceAll('Released', 'Unknown')), /status changed/);
});
