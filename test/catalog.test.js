import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import {
  SPRITES,
  ALL_ENTRIES,
  RELEASED_ENTRIES,
  VAULTED_ENTRIES,
  ENTRY_BY_ID,
  VARIANTS,
  VARIANT_ORDER,
  VARIANT_DUST,
  RARITIES,
  groupsFor,
  entriesFor,
  visibleEntries,
  idForName,
  formatDrop,
} from '../public/lib/catalog.js';

import { isValidEntryId } from '../public/lib/vault.js';

/**
 * The counts every other number in the app is derived from, taken from the
 * game files on 2026-08-08, after the 6 August Gem release moved eight entries
 * into reach. Both this app's first version and the tracker it was compared
 * against said 111, and both were wrong.
 *
 * When Epic ships more sprites, update these deliberately — a silent change
 * here is the app quietly lying about how far off completion you are.
 */
const RELEASED = 117;
const TOTAL = 118;
const RELEASED_SPRITES = 25;

test('the catalog holds the counts the game reports', () => {
  assert.equal(RELEASED_ENTRIES.length, RELEASED);
  assert.equal(ALL_ENTRIES.length, TOTAL);
  assert.equal(SPRITES.length, 25);
  assert.equal(groupsFor(true).length, SPRITES.length);
});

test('what counts and what is drawn are not the same set', () => {
  // A sprite you cannot obtain must not sit in the denominator, but one with a
  // known return date is still worth seeing. Collapsing these two into one
  // "released" flag is what makes a tracker either lie about your progress or
  // hide the thing you are waiting for.
  //
  // The vault is empty as of 6 August, so the two sets happen to coincide.
  // What is pinned here is the rule, not the coincidence — assert against
  // VAULTED_ENTRIES so this keeps meaning something the next time Epic pulls
  // something back.
  assert.equal(entriesFor(false).length, RELEASED, 'countable is obtainable-only');
  assert.equal(
    visibleEntries(false).length,
    RELEASED + VAULTED_ENTRIES.length,
    'drawn is the countable set plus whatever is waiting to come back',
  );
  assert.equal(groupsFor(false).length, RELEASED_SPRITES);

  // Gem Punk is the only thing either set leaves out of the full 118.
  const countable = new Set(entriesFor(false).map((entry) => entry.id));
  const drawn = new Set(visibleEntries(false).map((entry) => entry.id));
  const missing = (set) => ALL_ENTRIES.filter((entry) => !set.has(entry.id)).map((e) => e.id);

  assert.deepEqual(missing(countable), ['punk.gem']);
  assert.deepEqual(missing(drawn), ['punk.gem']);

  // The toggle widens both to everything.
  assert.equal(entriesFor(true).length, TOTAL);
  assert.equal(visibleEntries(true).length, TOTAL);
});

test('every entry id is unique and storable', () => {
  const ids = ALL_ENTRIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id in the catalog');

  for (const id of ids) {
    assert.ok(isValidEntryId(id), `${id} would be rejected by the vault`);
  }
});

test('every sprite carries the fields the UI renders', () => {
  for (const sprite of SPRITES) {
    assert.ok(sprite.key, 'sprite is missing a key');
    assert.match(sprite.name, /\S/, `${sprite.key} has no name`);
    assert.ok(RARITIES.includes(sprite.rarity), `${sprite.key} has rarity ${sprite.rarity}`);
    assert.match(sprite.power, /\S/, `${sprite.key} has no power text`);
    assert.ok(Number.isFinite(sprite.dust) && sprite.dust > 0, `${sprite.key} has no summon cost`);
    assert.ok(Number.isFinite(sprite.drop), `${sprite.key} has no drop rate`);
    assert.equal(typeof sprite.where, 'string');
  }
});

test('every variant is a known one, listed once, in display order', () => {
  for (const sprite of SPRITES) {
    const names = sprite.variants.map((v) => v.v);

    for (const name of names) {
      assert.ok(VARIANTS[name], `${sprite.key} has unknown variant ${name}`);
      assert.notEqual(name, 'base', 'base is implicit, never listed');
    }

    assert.equal(new Set(names).size, names.length, `${sprite.key} repeats a variant`);

    const ordered = [...names].sort((a, b) => VARIANT_ORDER.indexOf(a) - VARIANT_ORDER.indexOf(b));
    assert.deepEqual(
      groupsFor(true)
        .find((group) => group.sprite.key === sprite.key)
        .entries.slice(1)
        .map((entry) => entry.variant),
      ordered,
      `${sprite.key} variants render out of order`,
    );
  }
});

test('entry names read the way the game writes them', () => {
  assert.equal(ENTRY_BY_ID.get('water').name, 'Water Sprite');
  assert.equal(ENTRY_BY_ID.get('water.gold').name, 'Gold Water Sprite');
  assert.equal(ENTRY_BY_ID.get('zeropoint.holofoil').name, 'Holofoil Zero Point Sprite');
  assert.equal(ENTRY_BY_ID.get('burntpeanut').name, 'Burnt Peanut');

  const names = ALL_ENTRIES.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, 'two entries share a name');
});

test("Epic's patch-note spellings resolve to the in-game entry", () => {
  // The four names where the game files and the patch notes disagree.
  assert.equal(idForName('Grim Reaper Sprite'), 'grim');
  assert.equal(idForName("Lootin' Llama Sprite"), 'llama');
  assert.equal(idForName('Peeky Peely Sprite'), 'peely');
  assert.equal(idForName('TheBurntPeanut Sprite'), 'burntpeanut');

  // And the everyday forms a player would actually type.
  assert.equal(idForName('gold water'), 'water.gold');
  assert.equal(idForName('GOLD WATER SPRITE'), 'water.gold');
  assert.equal(idForName('Holofoil Grim Reaper Sprite'), 'grim.holofoil');
  assert.equal(idForName('not a sprite'), '');
});

test('a variant costs what its base sprite rarity says it costs', () => {
  for (const entry of ALL_ENTRIES) {
    if (entry.variant === 'base') continue;
    assert.equal(
      entry.dust,
      VARIANT_DUST[entry.rarity],
      `${entry.name} is priced off its rarity table`,
    );
  }
});

test('a variant inherits its base power and adds only its own perk', () => {
  const base = ENTRY_BY_ID.get('water');
  const gold = ENTRY_BY_ID.get('water.gold');

  assert.equal(gold.power, base.power);
  assert.equal(gold.perk, VARIANTS.gold.perk);
  assert.equal(base.perk, '', 'a base sprite has no variant perk');

  // Cube and Quack are pure cosmetics — the game gives them no extra line.
  assert.equal(ENTRY_BY_ID.get('earth.cube').perk, '');
  assert.equal(ENTRY_BY_ID.get('water.quack').perk, '');
});

test('an unreleased variant cannot hide inside the released list', () => {
  assert.equal(ENTRY_BY_ID.get('punk.gem').released, false, 'the Gem left behind');
  assert.equal(ENTRY_BY_ID.get('water.gem').released, true, 'shipped 6 August');
  assert.equal(ENTRY_BY_ID.get('ironmouse').released, true, 'back from the vault');
  assert.equal(ENTRY_BY_ID.get('llama.gem').released, true, 'this one shipped earlier');

  assert.ok(RELEASED_ENTRIES.every((entry) => entry.released));
});

test('vaulted and never-released are tracked apart, and both totals reconcile', () => {
  // fortnite.gg and IGN both publish 117 and the game files list 118. Neither
  // is wrong: the extra one is Gem Punk, which has art in the files and no way
  // to obtain it. Conflating the two states is how the app would end up
  // quoting a number nobody else recognises.
  const count = (state) => ALL_ENTRIES.filter((entry) => entry.state === state).length;

  assert.equal(count('live'), RELEASED, 'the number that actually matters');
  assert.equal(count('vaulted'), 0, '6 August emptied the vault');
  assert.equal(count('datamined'), 1);
  assert.equal(count('live') + count('vaulted'), 117, 'what both trackers publish');
  assert.equal(ALL_ENTRIES.length, TOTAL, "the game files' total");
});

test('an entry that cannot be obtained says which kind of gone it is', () => {
  // Nothing is vaulted today, so the two cases left are never-shipped and
  // ordinary. They must not read alike: one is worth waiting for and one is
  // not, and the grid draws them differently.
  const punk = ENTRY_BY_ID.get('punk.gem');
  assert.equal(punk.state, 'datamined');
  assert.equal(punk.returns, '', 'never shipped, so there is nothing to return to');

  assert.deepEqual(VAULTED_ENTRIES, [], 'the vault is empty');

  const ironmouse = ENTRY_BY_ID.get('ironmouse');
  assert.equal(ironmouse.state, 'live', 'came back 4 August');
  assert.equal(ironmouse.returns, '', 'and the date it was waiting on is spent');

  assert.equal(ENTRY_BY_ID.get('grim.gem').state, 'live');
  assert.equal(ENTRY_BY_ID.get('water.gem').state, 'live');
  assert.equal(ENTRY_BY_ID.get('water').state, 'live');
});

test("a variant cannot outlive the sprite it belongs to", () => {
  // Ironmouse has no variants today, but if it gains one while vaulted the
  // variant must not advertise itself as obtainable.
  for (const entry of ALL_ENTRIES) {
    if (entry.variant === 'base') continue;
    const base = ENTRY_BY_ID.get(entry.spriteKey);
    if (base.state !== 'live') {
      assert.equal(entry.state, base.state, `${entry.name} outlives ${base.name}`);
    }
  }
});

test('never-released entries stay out of the default grid; vaulted ones do not', () => {
  const visible = new Set(visibleEntries(false).map((entry) => entry.id));

  assert.ok(visible.has('ironmouse'), 'back from the vault, so it is shown');
  assert.ok(visible.has('grim.gem'), 'so is the Gem that came back with it');
  assert.ok(!visible.has('punk.gem'), 'never shipped, so it is not');

  // The rule, rather than today's three examples of it: only never-released
  // entries are held back from the grid.
  assert.deepEqual(
    [...new Set(ALL_ENTRIES.filter((entry) => !visible.has(entry.id)).map((e) => e.state))],
    ['datamined'],
  );
});

test('every entry has artwork, and nothing is shipped that nothing points at', () => {
  // The app builds the src from the entry id, so a missing file is a broken
  // image on a real tile, and a stray file is dead weight in the deploy.
  const dir = path.join(REPO_ROOT, 'public', 'sprites');
  const onDisk = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.webp')));

  for (const entry of ALL_ENTRIES) {
    assert.ok(onDisk.delete(`${entry.id}.webp`), `no artwork for ${entry.name} (${entry.id})`);
  }

  assert.deepEqual([...onDisk], [], 'artwork with no catalog entry');
});

test('the artwork is small enough to ship', () => {
  const dir = path.join(REPO_ROOT, 'public', 'sprites');
  const total = fs
    .readdirSync(dir)
    .reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0);

  // The 512px originals would be 3.2 MB. Anything near that means someone
  // committed unresized art.
  assert.ok(total < 600 * 1024, `sprite art is ${(total / 1024).toFixed(0)} KB`);
});

test('drop chances stay readable across five orders of magnitude', () => {
  assert.equal(formatDrop(6.48), '6.48%');
  assert.equal(formatDrop(0.53), '0.53%');
  assert.equal(formatDrop(0), '—');
  // Zero Point's Cube variant; a string of leading zeroes tells you nothing.
  assert.equal(formatDrop(0.000014), '1 in 7,142,857');
});
