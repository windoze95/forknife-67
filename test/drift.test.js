import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripHtml,
  extractSpriteNames,
  extractTotals,
  resolves,
  findDrift,
} from '../tools/check-catalog-drift.js';

/**
 * The drift check has two ways to be useless, and both are silent.
 *
 * It can miss a new sprite, in which case the catalog quietly rots. Or it can
 * fire on ordinary prose every single day, in which case the daily issue gets
 * muted and the real one arrives into a muted channel. These tests pin both
 * ends against text shaped like the pages it actually reads.
 */

const check = (html) => {
  const text = stripHtml(html);
  return findDrift(extractSpriteNames(text), extractTotals(text));
};

test('a page that matches the catalog reports no drift', () => {
  const report = check(`
    <p>There are currently 111 Sprites of varying rarity (though you can currently only find 109).</p>
    <table>
      <tr><td>Water Sprite</td><td>Rare</td></tr>
      <tr><td>Gold Water Sprite</td><td>Special</td></tr>
      <tr><td>Grim Sprite</td><td>Mythic</td></tr>
      <tr><td>Ironmouse Sprite</td><td>Mythic</td></tr>
    </table>
  `);

  assert.equal(report.drifted, false, JSON.stringify(report));
  assert.deepEqual(report.unknown, []);
  assert.deepEqual(report.unexplainedTotals, []);
});

test('a sprite the catalog has never heard of is reported', () => {
  const report = check('<li>Frostbite Sprite</li><li>Water Sprite</li>');

  assert.equal(report.drifted, true);
  assert.deepEqual(report.unknown, ['Frostbite']);
});

test('a variant of a known sprite is still caught when it is new', () => {
  // "Prismatic" is not a variant we know, so the whole name fails to resolve.
  const report = check('<li>Prismatic Water Sprite</li>');

  assert.equal(report.drifted, true);
  assert.deepEqual(report.unknown, ['Prismatic Water']);
});

test('the spellings Epic uses in patch notes do not raise a false alarm', () => {
  // These differ from the in-game names but are already aliases in the catalog.
  const report = check(`
    <li>Lootin' Llama Sprite</li>
    <li>Peeky Peely Sprite</li>
    <li>Grim Reaper Sprite</li>
    <li>TheBurntPeanut Sprite</li>
    <li>Gold Lootin' Llama Sprite</li>
  `);

  assert.deepEqual(report.unknown, []);
});

test('ordinary prose about sprites is not mistaken for a sprite', () => {
  const report = check(`
    <p>Find Sprites across the map. Master Sprites to earn rewards.</p>
    <p>The Best Sprite depends on your playstyle. Get More Sprites by extracting.</p>
    <h2>Fortnite Sprites</h2>
    <p>Each Sprite has an ability. These Sprites are worth tracking.</p>
  `);

  assert.deepEqual(report.unknown, [], 'a daily false alarm gets the whole check muted');
});

test('a label in front of the name does not read as part of it', () => {
  // Checklist tables put a status column next to the name, and flattening the
  // page runs them together.
  const report = check(`
    <tr><td>Mastered</td><td>Gold Air Sprite</td></tr>
    <tr><td>Reward</td><td>Quack Water Sprite</td></tr>
  `);

  assert.deepEqual(report.unknown, []);
});

test('a name cannot be assembled across a sentence boundary', () => {
  const report = check('<p>You have to extract the Sprite. Each Sprite counts once.</p>');
  assert.deepEqual(report.unknown, []);
});

test('suffix resolution accepts a real name and rejects an invented one', () => {
  assert.ok(resolves('Gold Water'));
  assert.ok(resolves('Mastered Gold Water'), 'leading label ignored');
  assert.ok(resolves('Zero Point'));
  assert.ok(!resolves('Frostbite'));
  assert.ok(!resolves('Prismatic Water'));
});

test('a total that changed is reported, and the ones we expect are not', () => {
  const same = check('<p>There are currently 111 Sprites, though only 109 are obtainable.</p>');
  assert.deepEqual(same.unexplainedTotals, []);

  const moved = check('<p>There are currently 126 Sprites, though only 124 are obtainable.</p>');
  assert.equal(moved.drifted, true);
  assert.deepEqual(moved.unexplainedTotals, [124, 126]);
});

test('counts that are not collection totals are ignored', () => {
  // Mastery rewards and dust prices are full of numbers that are not the size
  // of the collection.
  const report = check(`
    <p>There are currently 111 Sprites, though only 109 are obtainable.</p>
    <p>Master 60 Sprites for a reward. A variant costs 2,700 Sprite Dust.</p>
    <p>Extract 500 Sprites and 750 Sprites for the final rewards.</p>
  `);

  assert.deepEqual(report.unexplainedTotals, []);
});

test('a page with no totals at all does not invent any', () => {
  assert.deepEqual(extractTotals(stripHtml('<p>Sprites are great.</p>')), []);
});

test('block tags become line breaks so cells cannot merge', () => {
  const text = stripHtml('<td>Mastered</td><td>Water Sprite</td>');
  assert.ok(text.includes('\n'), 'table cells have to stay on separate lines');
  assert.deepEqual(extractSpriteNames(text), ['Water']);
});
