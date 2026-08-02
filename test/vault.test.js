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
  isBlankSprite,
  generateCode,
  normalizeCode,
  formatCode,
  isValidCode,
  DEFAULT_TOTAL,
  MAX_TOTAL,
} from '../public/lib/vault.js';

function docWith(sprites, total = DEFAULT_TOTAL) {
  const doc = emptyDoc(total);
  for (const sprite of sprites) doc.sprites[sprite.id] = { ...makeSprite(sprite.id), ...sprite };
  return doc;
}

test('empty doc defaults to 111 sprites', () => {
  const doc = emptyDoc();
  assert.equal(doc.total, 111);
  assert.equal(DEFAULT_TOTAL, 111);
  assert.deepEqual(doc.sprites, {});
});

test('normalizeSprite rejects out-of-range and garbage ids', () => {
  assert.equal(normalizeSprite({ id: 0 }), null);
  assert.equal(normalizeSprite({ id: -4 }), null);
  assert.equal(normalizeSprite({ id: MAX_TOTAL + 1 }), null);
  assert.equal(normalizeSprite({ id: 'banana' }), null);
  assert.equal(normalizeSprite(null), null);
  assert.equal(normalizeSprite('nope'), null);
});

test('normalizeSprite clamps hostile field values', () => {
  const sprite = normalizeSprite({
    id: 5,
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
  const sprite = normalizeSprite({ id: 1, name: 'ab\u0000c\u001fd\u007fe' });
  assert.equal(sprite.name, 'ab c d e');
});

test('normalizeDoc accepts both array and object sprite collections', () => {
  const fromArray = normalizeDoc({ total: 12, sprites: [{ status: 'owned' }, { status: 'maxed' }] });
  assert.equal(fromArray.sprites[1].status, 'owned');
  assert.equal(fromArray.sprites[2].status, 'maxed');

  const fromObject = normalizeDoc({ total: 12, sprites: { 7: { id: 7, status: 'owned' } } });
  assert.equal(fromObject.sprites[7].status, 'owned');
});

test('normalizeDoc never throws on junk input', () => {
  for (const junk of [null, undefined, 42, 'string', [], { sprites: 5 }, { total: NaN }]) {
    assert.doesNotThrow(() => normalizeDoc(junk));
  }
  assert.equal(normalizeDoc({ total: 99999 }).total, MAX_TOTAL);
  assert.equal(normalizeDoc({ total: -3 }).total, 1);
});

test('merge keeps the newer edit per sprite, not per document', () => {
  // The bug this guards against: phone marks #14, PC marks #92, and a naive
  // whole-document last-write-wins silently drops one of them.
  const phone = docWith([{ id: 14, status: 'owned', updatedAt: 1000 }]);
  const pc = docWith([{ id: 92, status: 'maxed', updatedAt: 900 }]);

  const merged = mergeDocs(phone, pc);
  assert.equal(merged.sprites[14].status, 'owned');
  assert.equal(merged.sprites[92].status, 'maxed');
});

test('merge resolves a conflict on the same sprite by timestamp', () => {
  const older = docWith([{ id: 3, status: 'owned', updatedAt: 100 }]);
  const newer = docWith([{ id: 3, status: 'maxed', updatedAt: 200 }]);

  assert.equal(mergeDocs(older, newer).sprites[3].status, 'maxed');
  assert.equal(mergeDocs(newer, older).sprites[3].status, 'maxed');
});

test('merge breaks ties in favour of the first argument', () => {
  const local = docWith([{ id: 3, status: 'owned', updatedAt: 500 }]);
  const remote = docWith([{ id: 3, status: 'maxed', updatedAt: 500 }]);
  assert.equal(mergeDocs(local, remote).sprites[3].status, 'owned');
});

test('merge is idempotent and order independent for disjoint edits', () => {
  const a = docWith([{ id: 1, status: 'owned', updatedAt: 10 }]);
  const b = docWith([{ id: 2, status: 'maxed', updatedAt: 20 }]);

  const ab = mergeDocs(a, b);
  const ba = mergeDocs(b, a);
  assert.deepEqual(ab.sprites, ba.sprites);
  assert.deepEqual(mergeDocs(ab, ab).sprites, ab.sprites);
});

test('merge takes the total from whichever device changed it last', () => {
  const a = { ...emptyDoc(111), totalUpdatedAt: 100 };
  const b = { ...emptyDoc(120), totalUpdatedAt: 200 };
  assert.equal(mergeDocs(a, b).total, 120);
  assert.equal(mergeDocs(b, a).total, 120);
});

test('compactDoc drops untouched sprites but keeps every marked one', () => {
  const doc = docWith([
    { id: 1, status: 'needed' },
    { id: 2, status: 'owned' },
    { id: 3, hunting: true },
    { id: 4, name: 'Ember' },
    { id: 5, notes: 'traded' },
  ]);

  const compact = compactDoc(doc);
  assert.deepEqual(Object.keys(compact.sprites).sort(), ['2', '3', '4', '5']);
  assert.ok(isBlankSprite(doc.sprites[1]));
});

test('counts split owned and maxed, and ignore slots above the total', () => {
  const doc = docWith(
    [
      { id: 1, status: 'owned' },
      { id: 2, status: 'maxed' },
      { id: 3, status: 'needed', hunting: true },
      { id: 50, status: 'maxed' },
    ],
    10,
  );

  const c = countsFor(doc);
  assert.equal(c.total, 10);
  assert.equal(c.owned, 1);
  assert.equal(c.maxed, 1);
  assert.equal(c.collected, 2);
  assert.equal(c.needed, 8);
  assert.equal(c.hunting, 1);
  assert.equal(c.percent, 20);
});

test('counts never report a negative remaining after shrinking the total', () => {
  const doc = docWith([{ id: 1, status: 'owned' }, { id: 2, status: 'maxed' }], 1);
  const c = countsFor(doc);
  assert.equal(c.collected, 1);
  assert.equal(c.needed, 0);
});

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
