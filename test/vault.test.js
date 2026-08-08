import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyDoc,
  makeSprite,
  normalizeDoc,
  normalizeSprite,
  mergeDocs,
  compactDoc,
  countsFor,
  groupCounts,
  groupTier,
  customIds,
  nextCustomId,
  isBlankSprite,
  isValidEntryId,
  generateCode,
  normalizeCode,
  formatCode,
  isValidCode,
  MAX_ENTRIES,
} from '../public/lib/vault.js';

import { RELEASED_ENTRIES, ALL_ENTRIES } from '../public/lib/catalog.js';

const RELEASED = RELEASED_ENTRIES.length;

function docWith(sprites) {
  const doc = emptyDoc();
  for (const sprite of sprites) doc.sprites[sprite.id] = { ...makeSprite(sprite.id), ...sprite };
  return doc;
}

test('an empty doc tracks the released catalog and nothing else', () => {
  const doc = emptyDoc();
  assert.equal(doc.schema, 2);
  assert.equal(doc.unreleased, false);
  assert.deepEqual(doc.sprites, {});
  assert.equal(countsFor(doc).total, RELEASED);
});

test('entry ids are validated by shape, not by catalog membership', () => {
  assert.ok(isValidEntryId('water'));
  assert.ok(isValidEntryId('water.gold'));
  assert.ok(isValidEntryId('custom.12'));
  // A sprite from a catalog newer than this build still has to be storable.
  assert.ok(isValidEntryId('somethingnew.holofoil'));

  assert.ok(!isValidEntryId(''));
  assert.ok(!isValidEntryId(7));
  assert.ok(!isValidEntryId('Water'), 'uppercase is not the canonical form');
  assert.ok(!isValidEntryId('a.b.c'));
  assert.ok(!isValidEntryId('../../etc/passwd'));
  assert.ok(!isValidEntryId(`${'x'.repeat(33)}`));
});

test('normalizeSprite rejects garbage ids', () => {
  assert.equal(normalizeSprite({ id: 0 }), null);
  assert.equal(normalizeSprite({ id: 'BANANA!' }), null);
  assert.equal(normalizeSprite(null), null);
  assert.equal(normalizeSprite('nope'), null);
});

test('normalizeSprite clamps hostile field values', () => {
  const sprite = normalizeSprite({
    id: 'water',
    name: 'x'.repeat(500),
    status: 'legendary',
    hunting: 'yes',
    notes: 'n'.repeat(9000),
    updatedAt: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(sprite.name.length, 60);
  assert.equal(sprite.status, 'needed', 'unknown status falls back to needed');
  assert.equal(sprite.hunting, false, 'only a real boolean sets the flag');
  assert.equal(sprite.notes.length, 500);
  assert.equal(sprite.updatedAt, 0, 'an absurd clock value is discarded');
});

test('normalizeSprite strips control characters from text', () => {
  const sprite = normalizeSprite({ id: 'water', name: 'ab\u0000c\u001fd\u007fe' });
  assert.equal(sprite.name, 'ab c d e');
});

test('normalizeDoc keys entries by id and drops unusable ones', () => {
  const doc = normalizeDoc({
    sprites: {
      'water.gold': { status: 'owned' },
      'BAD ID': { status: 'owned' },
      grim: { id: 'grim', status: 'maxed' },
    },
  });

  assert.deepEqual(Object.keys(doc.sprites).sort(), ['grim', 'water.gold']);
  assert.equal(doc.sprites['water.gold'].status, 'owned');
});

test('normalizeDoc never throws on junk input', () => {
  for (const junk of [null, undefined, 42, 'string', [], { sprites: 5 }, { sprites: { a: 1 } }]) {
    assert.doesNotThrow(() => normalizeDoc(junk));
  }
});

test('normalizeDoc caps how many entries one payload can create', () => {
  const sprites = {};
  for (let i = 0; i < MAX_ENTRIES + 50; i += 1) sprites[`custom.${i + 1}`] = { status: 'owned' };
  assert.equal(Object.keys(normalizeDoc({ sprites }).sprites).length, MAX_ENTRIES);
});

/* ---------------------------------------------------------------------- */
/* v1 migration                                                           */
/* ---------------------------------------------------------------------- */

test('a v1 slot named like a real sprite lands on that catalog entry', () => {
  const doc = normalizeDoc({
    schema: 1,
    total: 111,
    sprites: {
      9: { id: 9, name: 'Gold Water Sprite', status: 'maxed', notes: 'from a chest', updatedAt: 100 },
      12: { id: 12, name: 'gold water', status: 'owned', updatedAt: 50 },
    },
  });

  assert.equal(doc.sprites['water.gold'].status, 'maxed', 'the newer of two matches wins');
  assert.equal(doc.sprites['water.gold'].notes, 'from a chest');
  assert.equal(doc.sprites['water.gold'].name, '', 'the catalog supplies the name now');
});

test("migration accepts Epic's patch-note spelling as well as the in-game one", () => {
  const doc = normalizeDoc({
    schema: 1,
    sprites: {
      1: { id: 1, name: 'Grim Reaper Sprite', status: 'owned', updatedAt: 1 },
      2: { id: 2, name: "Gold Lootin' Llama Sprite", status: 'owned', updatedAt: 1 },
      3: { id: 3, name: 'TheBurntPeanut Sprite', status: 'maxed', updatedAt: 1 },
    },
  });

  assert.equal(doc.sprites.grim.status, 'owned');
  assert.equal(doc.sprites['llama.gold'].status, 'owned');
  assert.equal(doc.sprites.burntpeanut.status, 'maxed');
});

test('a v1 slot the catalog does not recognise survives as a custom entry', () => {
  const doc = normalizeDoc({
    schema: 1,
    sprites: {
      47: { id: 47, name: 'the little blue one', status: 'owned', notes: 'mine', updatedAt: 1 },
      60: { id: 60, name: '', status: 'needed', hunting: true, updatedAt: 1 },
    },
  });

  assert.equal(doc.sprites['custom.47'].name, 'the little blue one');
  assert.equal(doc.sprites['custom.47'].notes, 'mine');
  // The number was the identity in v1, so it becomes the label.
  assert.equal(doc.sprites['custom.60'].name, 'Slot 60');
  assert.equal(doc.sprites['custom.60'].hunting, true);
});

test('untouched v1 slots do not become empty custom entries', () => {
  const sprites = {};
  for (let i = 1; i <= 111; i += 1) {
    sprites[i] = { id: i, name: '', status: 'needed', hunting: false, notes: '', updatedAt: 1 };
  }

  const doc = normalizeDoc({ schema: 1, total: 111, sprites });
  assert.deepEqual(doc.sprites, {});
  assert.equal(countsFor(doc).total, RELEASED);
});

test('migrating twice changes nothing the second time', () => {
  const once = normalizeDoc({
    schema: 1,
    sprites: {
      9: { id: 9, name: 'Gold Water Sprite', status: 'maxed', updatedAt: 100 },
      47: { id: 47, name: 'mystery', status: 'owned', updatedAt: 100 },
    },
  });

  assert.deepEqual(normalizeDoc(once), once);
});

/* ---------------------------------------------------------------------- */
/* Merge                                                                  */
/* ---------------------------------------------------------------------- */

test('merge keeps the newer edit per entry, not per document', () => {
  // The bug this guards against: phone marks Gold Water, PC marks Grim, and a
  // naive whole-document last-write-wins silently drops one of them.
  const phone = docWith([{ id: 'water.gold', status: 'owned', updatedAt: 1000 }]);
  const pc = docWith([{ id: 'grim', status: 'maxed', updatedAt: 900 }]);

  const merged = mergeDocs(phone, pc);
  assert.equal(merged.sprites['water.gold'].status, 'owned');
  assert.equal(merged.sprites.grim.status, 'maxed');
});

test('merge resolves a conflict on the same entry by timestamp', () => {
  const older = docWith([{ id: 'dream', status: 'owned', updatedAt: 100 }]);
  const newer = docWith([{ id: 'dream', status: 'maxed', updatedAt: 200 }]);

  assert.equal(mergeDocs(older, newer).sprites.dream.status, 'maxed');
  assert.equal(mergeDocs(newer, older).sprites.dream.status, 'maxed');
});

test('merge breaks ties in favour of the first argument', () => {
  const local = docWith([{ id: 'dream', status: 'owned', updatedAt: 500 }]);
  const remote = docWith([{ id: 'dream', status: 'maxed', updatedAt: 500 }]);
  assert.equal(mergeDocs(local, remote).sprites.dream.status, 'owned');
});

test('merge is idempotent and order independent for disjoint edits', () => {
  const a = docWith([{ id: 'water', status: 'owned', updatedAt: 10 }]);
  const b = docWith([{ id: 'fire', status: 'maxed', updatedAt: 20 }]);

  const ab = mergeDocs(a, b);
  const ba = mergeDocs(b, a);
  assert.deepEqual(ab.sprites, ba.sprites);
  assert.deepEqual(mergeDocs(ab, ab).sprites, ab.sprites);
});

test('merge takes the unreleased setting from whichever device changed it last', () => {
  const a = { ...emptyDoc(), unreleased: false, unreleasedAt: 100 };
  const b = { ...emptyDoc(), unreleased: true, unreleasedAt: 200 };
  assert.equal(mergeDocs(a, b).unreleased, true);
  assert.equal(mergeDocs(b, a).unreleased, true);
});

test('an entry from a newer catalog survives a merge instead of being dropped', () => {
  // A phone still on the old build must not delete progress made on a device
  // that already has the new one.
  const stale = docWith([{ id: 'water', status: 'owned', updatedAt: 10 }]);
  const fresh = docWith([{ id: 'brandnew.gold', status: 'maxed', updatedAt: 20 }]);

  const merged = mergeDocs(stale, fresh);
  assert.equal(merged.sprites['brandnew.gold'].status, 'maxed');
  assert.equal(countsFor(merged).collected, 1, 'but it is not counted until the catalog knows it');
});

/* ---------------------------------------------------------------------- */
/* Compaction and counting                                                */
/* ---------------------------------------------------------------------- */

test('compactDoc drops untouched entries but keeps every marked one', () => {
  const doc = docWith([
    { id: 'water', status: 'needed' },
    { id: 'fire', status: 'owned' },
    { id: 'earth', hunting: true },
    { id: 'dream', notes: 'traded' },
  ]);

  const compact = compactDoc(doc);
  assert.deepEqual(Object.keys(compact.sprites).sort(), ['dream', 'earth', 'fire']);
  assert.ok(isBlankSprite(doc.sprites.water));
});

test('a blanked custom entry is kept, because it is a deletion', () => {
  // Strip the tombstone and the server keeps the old copy, which the next
  // merge hands straight back — the entry you deleted reappears everywhere.
  const doc = docWith([{ id: 'custom.1', status: 'needed', name: '', updatedAt: 500 }]);

  assert.deepEqual(Object.keys(compactDoc(doc).sprites), ['custom.1']);
  assert.deepEqual(customIds(doc), [], 'but it is no longer an entry');
  assert.equal(countsFor(doc).total, RELEASED);
});

test('a deleted custom entry stays deleted after syncing with an older device', () => {
  const deleted = docWith([{ id: 'custom.1', status: 'needed', name: '', updatedAt: 500 }]);
  const other = docWith([{ id: 'custom.1', status: 'owned', name: 'New Sprite', updatedAt: 100 }]);

  assert.deepEqual(customIds(mergeDocs(deleted, other)), []);
  assert.deepEqual(customIds(mergeDocs(other, deleted)), []);
});

test('a new custom entry never reuses a deleted id', () => {
  const doc = docWith([
    { id: 'custom.1', status: 'owned', name: 'Kept' },
    { id: 'custom.2', status: 'needed', name: '' },
  ]);

  assert.deepEqual(customIds(doc), ['custom.1']);
  assert.equal(nextCustomId(doc), 'custom.3', 'reusing custom.2 would revive its tombstone');
});

test('counts split owned and maxed across the released catalog', () => {
  const doc = docWith([
    { id: 'water', status: 'owned' },
    { id: 'water.gold', status: 'maxed' },
    { id: 'fire', status: 'needed', hunting: true },
  ]);

  const c = countsFor(doc);
  assert.equal(c.total, RELEASED);
  assert.equal(c.owned, 1);
  assert.equal(c.maxed, 1);
  assert.equal(c.collected, 2);
  assert.equal(c.needed, RELEASED - 2);
  assert.equal(c.hunting, 1);
});

test('unreleased entries only count once you ask to see them', () => {
  // Gem Punk is the only entry left that the game has never released.
  const doc = docWith([{ id: 'punk.gem', status: 'owned' }]);

  assert.equal(countsFor(doc).total, RELEASED);
  assert.equal(countsFor(doc).collected, 0, 'hidden entries do not inflate progress');

  const shown = { ...doc, unreleased: true };
  assert.equal(countsFor(shown).total, ALL_ENTRIES.length);
  assert.equal(countsFor(shown).collected, 1);
});

test("custom entries count toward the player's own total", () => {
  const doc = docWith([{ id: 'custom.1', status: 'owned', name: 'Brand New Sprite' }]);
  const c = countsFor(doc);
  assert.equal(c.total, RELEASED + 1);
  assert.equal(c.collected, 1);
});

test('group counts read against the whole sprite, not the current filter', () => {
  const doc = docWith([
    { id: 'water', status: 'owned' },
    { id: 'water.gold', status: 'maxed' },
    { id: 'water.gummy', status: 'needed' },
  ]);

  const entries = RELEASED_ENTRIES.filter((entry) => entry.spriteKey === 'water');
  // maxed is separate from collected: the heading marks the two differently.
  // Seven since 6 August, when Water gained its Gem.
  assert.deepEqual(groupCounts(doc, entries), { collected: 2, maxed: 1, total: 7 });
});

test('a group is on exactly one rung, whatever the counts', () => {
  const tier = (collected, maxed, total) => groupTier({ collected, maxed, total });

  assert.equal(tier(0, 0, 6), 'none');
  assert.equal(tier(1, 0, 6), 'partial');
  assert.equal(tier(5, 0, 6), 'partial');
  assert.equal(tier(6, 0, 6), 'complete');

  // Mastering does not move you along the ladder; only collecting does. One
  // crowned variant out of six is the state the old two-flag version got
  // visibly wrong, painting the total gold while progress stayed grey.
  assert.equal(tier(1, 1, 6), 'partial', 'a crown is not progress towards the set');
  assert.equal(tier(6, 5, 6), 'complete', 'one short of mastery is still complete');
  assert.equal(tier(6, 6, 6), 'mastered');

  // A single-variant sprite skips straight past partial, and an empty group
  // (nothing in the catalog under it yet) is not a completed one.
  assert.equal(tier(1, 0, 1), 'complete');
  assert.equal(tier(1, 1, 1), 'mastered');
  assert.equal(tier(0, 0, 0), 'none');
});

/* ---------------------------------------------------------------------- */
/* Vault codes                                                            */
/* ---------------------------------------------------------------------- */

test('vault codes round-trip and reject bad input', () => {
  const code = generateCode((n) => Buffer.alloc(n, 7));
  assert.equal(code.length, 16);
  assert.ok(isValidCode(code));

  assert.ok(!isValidCode(''));
  assert.ok(!isValidCode('SHORT'));
  assert.ok(!isValidCode('../../etc/passwd'));
  assert.ok(!isValidCode('a'.repeat(16)), 'lowercase is not the canonical form');
});

test('typed codes tolerate dashes, case and lookalike glyphs', () => {
  const code = generateCode((n) => Buffer.alloc(n, 3));
  assert.equal(normalizeCode(formatCode(code)), code);
  assert.equal(normalizeCode('  abcd-efgh ijkl mnpq '), 'ABCDEFGH1JK1MNPQ');
  assert.equal(normalizeCode('O0oO0oO0oO0oO0oO'), '0000000000000000');
});

test('generated codes are spread across the alphabet', () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 11);
  const code = generateCode(() => bytes);
  assert.ok(new Set(code).size > 8, `expected variety, got ${code}`);
});
