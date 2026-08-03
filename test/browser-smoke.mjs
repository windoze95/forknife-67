/**
 * End-to-end smoke test against a real browser.
 *
 * Kept out of `npm test` because it needs Chromium and playwright, neither of
 * which the app itself depends on. It boots its own server on a random port:
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   node test/browser-smoke.mjs
 *
 * It exercises the interactions the unit tests cannot reach: tap-to-cycle,
 * the hunting flag, filters, search, the detail sheet, undo, and two devices
 * converging through the sync API.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Resolve playwright from node_modules by default; PLAYWRIGHT_MODULE lets a
// machine with only a global install point at it instead.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forknife-shots');

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  // Lists compare by value: several checks assert on the exact set of entries
  // a filter or search left on screen, and `!==` would pass every one of them.
  const same =
    expected !== null && typeof expected === 'object'
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;

  if (!same) {
    throw new Error(`${message || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------ boot server ----------------------------- */

// BASE_URL points the whole suite at something already running instead of the
// Node dev server — `npm run dev:worker`, or a real deployment. That is how the
// Cloudflare Worker gets the same 24 tests, sync and offline behaviour
// included, rather than a second suite that only rhymes with this one.
const external = process.env.BASE_URL;

let dataDir;
let server;
let base = external;

if (!external) {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forknife-e2e-'));
  process.env.DATA_DIR = dataDir;

  const { createServer } = await import('../server/server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

console.log(`server: ${base}${external ? ' (external)' : ''}\n`);

await fs.mkdir(SHOT_DIR, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);

const consoleErrors = [];

async function newPage({ mobile = true, colorScheme } = {}) {
  const context = await browser.newContext({
    ...(mobile
      ? { viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
      : { viewport: { width: 1280, height: 900 } }),
    // Left unset, playwright reports a light device — which is what every other
    // check here assumes, so only the theme checks pass this.
    ...(colorScheme ? { colorScheme } : {}),
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  return page;
}

const tile = (page, id) => page.locator(`.tile[data-id="${id}"]`);
const group = (page, key) => page.locator(`.group[data-key="${key}"]`);

/**
 * What a group heading's counter is actually painting, next to the tokens it
 * should be painting with. Resolving those through the browser keeps the
 * comparison against whatever the theme renders rather than a hardcoded hex.
 */
async function counterInk(page, key) {
  // The counter fades between rungs, and a colour read mid-fade is an
  // interpolation that matches no token in the theme.
  await group(page, key)
    .locator('.group-count')
    .evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
    );

  return group(page, key).evaluate((el) => {
    const token = (name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      el.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };

    return {
      left: getComputedStyle(el.querySelector('.gc-have')).color,
      right: getComputedStyle(el.querySelector('.gc-total')).color,
      crowned: !el.querySelector('.gc-crown').hidden,
      label: el.querySelector('.group-count').getAttribute('aria-label'),
      muted: token('--muted'),
      green: token('--owned-ink'),
      gold: token('--maxed-ink'),
    };
  });
}

const tileIds = (page) =>
  page.locator('.tile').evaluateAll((els) => els.map((e) => e.dataset.id));

/* --------------------------------- tests -------------------------------- */

const page = await newPage();
await page.goto(base);
await page.waitForSelector('.tile');

await check('renders the released catalog, grouped by sprite', async () => {
  // 109 obtainable plus the two vaulted ones, which are drawn but not counted.
  equal(await page.locator('.tile').count(), 111, 'entry count');
  equal(await page.locator('.group').count(), 25, 'base sprites');
});

await check('sprites due back are called out, without inflating the total', async () => {
  // Knowing Ironmouse lands on the 4th is a thing you open the app to check.
  const items = await page.locator('.soon-item').evaluateAll((els) =>
    els.map((el) => ({
      id: el.dataset.id,
      name: el.querySelector('.soon-name').textContent,
      when: el.querySelector('.soon-when').textContent,
    })),
  );

  equal(items.length, 2, 'two sprites are vaulted right now');
  const ironmouse = items.find((item) => item.id === 'ironmouse');
  assert(ironmouse, 'Ironmouse should be listed');
  // Formatted in the viewer's locale, so assert the parts rather than an order.
  assert(/4/.test(ironmouse.when) && /Aug/i.test(ironmouse.when), `got ${ironmouse.when}`);
  equal(items.find((item) => item.id === 'grim.gem').when, 'No date yet');

  // Visible in the grid, but never part of what you are counting down.
  equal(await tile(page, 'ironmouse').count(), 1, 'drawn in the grid too');
  equal(await page.locator('#progressCount').textContent(), '0 / 109', 'and not in the total');
});

await check('starts at 0 / 109 collected', async () => {
  equal(await page.locator('#progressCount').textContent(), '0 / 109');
  equal(await page.locator('#progressPct').textContent(), '0%');
});

await check('a group heading names the sprite, its rarity and its power', async () => {
  const water = group(page, 'water');
  equal(await water.locator('.group-name').textContent(), 'Water Sprite');
  equal(await water.locator('.rarity').textContent(), 'Rare');
  // innerText, not textContent: the counter also holds the mastery crown, which
  // is display:none until something in the group is crowned.
  equal(await water.locator('.group-count').innerText(), '0 / 6');
  equal(
    await water.locator('.group-power').textContent(),
    'Replenish shields while standing in water!',
  );
});

await check('the paper band stays put while the page scrolls out from under it', async () => {
  // Both copies are real and both are painted; what stops that reading as two
  // bands is that they occupy the same 6px until the toolbar pins. Geometry is
  // the whole trick, so geometry is what this asserts.
  const band = () =>
    page.evaluate(() => {
      const topbar = document.querySelector('.topbar').getBoundingClientRect();
      const toolbar = document.getElementById('toolbar').getBoundingClientRect();
      const search = document.querySelector('.search').getBoundingClientRect();
      const header = getComputedStyle(document.querySelector('.topbar'), '::after');
      const hanging = getComputedStyle(document.getElementById('toolbar'), '::before');

      return {
        paint: header.backgroundImage,
        samePaint: header.backgroundImage === hanging.backgroundImage,
        // The toolbar's copy hangs above its box, so the toolbar's top edge is
        // the band's bottom edge in both states.
        top: +(toolbar.top - parseFloat(hanging.height)).toFixed(1),
        bottom: +toolbar.top.toFixed(1),
        headerBandBottom: +topbar.bottom.toFixed(1),
        gapToSearch: +(search.top - toolbar.top).toFixed(1),
      };
    });

  const rest = await band();
  assert(rest.paint.includes('repeating-linear-gradient'), 'the band is the gradient pair');
  assert(rest.samePaint, 'drawn twice, so the two have to be the same paint');
  equal(
    rest.bottom,
    rest.headerBandBottom,
    'at rest the toolbar\'s copy lands exactly on the header\'s, which is why one band is all you see',
  );

  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForFunction(() => document.getElementById('toolbar').classList.contains('is-stuck'));

  const pinned = await band();
  equal(pinned.top, 0, 'pinned, the band is the top of the screen');
  assert(pinned.headerBandBottom < 0, 'and the header has gone, rather than handed anything over');
  equal(
    pinned.gapToSearch,
    rest.gapToSearch,
    'the search field sits the same distance under the band either way — the band hangs outside the toolbar, so it costs the layout nothing',
  );

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.getElementById('toolbar').classList.contains('is-stuck'));
});

await check('every tile carries the sprite artwork', async () => {
  const shape = await tile(page, 'water.gold').locator('.tile-img').evaluate((el) => ({
    src: new URL(el.src).pathname,
    loading: el.loading,
    alt: el.alt,
  }));

  equal(shape.src, '/sprites/water.gold.webp');
  equal(shape.loading, 'lazy', '109 eager images would be 109 requests on load');
  equal(shape.alt, '', 'the name is already on the tile, so the image is decorative');

  // A broken path renders an empty box, which the src assertion above would
  // happily pass, so check the bytes actually arrived.
  const ok = await page.evaluate(async () => {
    const res = await fetch('/sprites/zeropoint.holofoil.webp');
    return res.ok && res.headers.get('content-type') === 'image/webp';
  });
  assert(ok, 'sprite artwork is not being served');
});

await check('a tile is labelled by its variant, not repeating the sprite name', async () => {
  equal(await tile(page, 'water').locator('.tile-label').textContent(), 'Base');
  equal(await tile(page, 'water.gold').locator('.tile-label').textContent(), 'Gold');
  assert(
    (await tile(page, 'water.gold').getAttribute('aria-label')).startsWith('Gold Water Sprite'),
    'the full name still has to reach a screen reader',
  );
});

await check('tapping a tile cycles needed -> owned -> maxed -> needed', async () => {
  const t = tile(page, 'water.gold');
  equal(await t.getAttribute('data-status'), 'needed', 'initial');

  await t.click();
  equal(await t.getAttribute('data-status'), 'owned', 'after 1st tap');

  await t.click();
  equal(await t.getAttribute('data-status'), 'maxed', 'after 2nd tap');

  await t.click();
  equal(await t.getAttribute('data-status'), 'needed', 'after 3rd tap');
});

await check('progress counts owned and maxed separately', async () => {
  await tile(page, 'water').click(); // owned
  await tile(page, 'earth').click();
  await tile(page, 'earth').click(); // maxed

  equal(await page.locator('#progressCount').textContent(), '2 / 109');
  equal(await page.locator('#legendOwned').textContent(), '1');
  equal(await page.locator('#legendMaxed').textContent(), '1');
  equal(await page.locator('#legendNeeded').textContent(), '107');
});

await check('a group heading tracks its own sprite', async () => {
  equal(await group(page, 'water').locator('.group-count').innerText(), '1 / 6');
  equal(await group(page, 'fire').locator('.group-count').innerText(), '0 / 7');
});

await check('collecting climbs the counter; mastering marks it', async () => {
  // Where the taps above left things: one of six Water collected and none of
  // them crowned, one of Earth's collected and crowned, Fire untouched.
  const water = await counterInk(page, 'water');
  equal(await group(page, 'water').getAttribute('data-progress'), 'partial');
  equal(water.left, water.green, 'the half that moved is the half that colours');
  equal(water.right, water.muted, 'a total is not an achievement');
  equal(water.crowned, false);
  equal(water.label, '1 of 6 collected');

  const earth = await counterInk(page, 'earth');
  equal(
    await group(page, 'earth').getAttribute('data-progress'),
    'partial',
    'one crowned variant out of several is still one variant out of several',
  );
  equal(earth.left, earth.green);
  equal(earth.right, earth.muted, 'the number that did not move stays put');
  equal(earth.crowned, true, 'the crown is what carries mastery instead');
  assert(earth.label.endsWith(', 1 mastered'), `crown reaches a screen reader: ${earth.label}`);

  const fire = await counterInk(page, 'fire');
  equal(await group(page, 'fire').getAttribute('data-progress'), 'none');
  equal(fire.left, fire.muted);
  equal(fire.right, fire.muted);

  // John Wick has one variant, so a tap completes him and a second masters him.
  // Every rung has to actually beat the one below it in the cascade, which is a
  // fight that loses silently.
  await tile(page, 'johnwick').click();
  const complete = await counterInk(page, 'johnwick');
  equal(await group(page, 'johnwick').getAttribute('data-progress'), 'complete');
  equal(complete.left, complete.green, 'left half of a complete counter');
  equal(complete.right, complete.green, 'and the total with it — the set is whole');
  equal(complete.crowned, false);

  await tile(page, 'johnwick').click();
  const mastered = await counterInk(page, 'johnwick');
  equal(await group(page, 'johnwick').getAttribute('data-progress'), 'mastered');
  equal(mastered.left, mastered.gold, 'left half of an all-mastered counter');
  equal(mastered.right, mastered.gold, 'right half of an all-mastered counter');
  equal(mastered.crowned, true);
  equal(mastered.label, '1 of 1 collected, 1 mastered');

  // Put him back so the counts the later sync checks rely on still hold.
  await tile(page, 'johnwick').click();
  equal(await group(page, 'johnwick').getAttribute('data-progress'), 'none');
});

await check('nothing on the page can be zoomed, by any of the three routes', async () => {
  const gestures = await page.evaluate(() => {
    // Dispatched at the body so it has to bubble: the handler is on document,
    // and a listener registered as passive silently cannot do this.
    const pinch = new Event('gesturestart', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(pinch);

    return {
      tile: getComputedStyle(document.querySelector('.tile-main')).touchAction,
      body: getComputedStyle(document.body).touchAction,
      sheet: getComputedStyle(document.getElementById('detail')).touchAction,
      notes: getComputedStyle(document.getElementById('detailNotes')).fontSize,
      name: getComputedStyle(document.getElementById('detailName')).fontSize,
      viewport: document.querySelector('meta[name="viewport"]').content,
      pinchRefused: pinch.defaultPrevented,
    };
  });

  // 1. The gestures, on the tap target itself as well as the document — a pinch
  //    answers to whatever is under the fingers.
  equal(gestures.tile, 'pan-x pan-y', 'a tile');
  equal(gestures.body, 'pan-x pan-y', 'the document');
  equal(gestures.sheet, 'pan-x pan-y', 'a sheet, which is in the top layer');

  // 2. The meta, for the browsers that honour it.
  assert(/user-scalable=no/.test(gestures.viewport), `viewport: ${gestures.viewport}`);
  assert(/maximum-scale=1/.test(gestures.viewport), `viewport: ${gestures.viewport}`);

  // 3. And WebKit's own gesture events, which are all iOS answers to.
  assert(gestures.pinchRefused, 'iOS pinches the page regardless of the other two');

  // Focus zoom is a fourth route: iOS magnifies any field under 16px as it
  // takes focus, and leaves you there.
  equal(gestures.notes, '16px', 'notes field');
  equal(gestures.name, '16px', 'name field');
});

await check('the maxed tile shows a crown mark', async () => {
  equal(await tile(page, 'earth').locator('.tile-mark').textContent(), '♛');
  equal(await tile(page, 'water').locator('.tile-mark').textContent(), '✓');
});

await check('the hunting button flags a sprite without changing status', async () => {
  await tile(page, 'fire').locator('.tile-hunt').click();
  equal(await tile(page, 'fire').getAttribute('data-hunting'), 'true');
  equal(await tile(page, 'fire').getAttribute('data-status'), 'needed', 'status untouched');
  equal(await page.locator('#legendHunting').textContent(), '1');
});

await check('finding a hunted sprite takes it off the hunting list', async () => {
  await tile(page, 'fire').click(); // -> owned
  equal(await tile(page, 'fire').getAttribute('data-status'), 'owned');
  equal(await tile(page, 'fire').getAttribute('data-hunting'), 'false', 'should auto-clear');
  equal(await page.locator('#legendHunting').textContent(), '0');
});

await check('undo restores the previous state', async () => {
  await tile(page, 'fishy').click(); // -> owned
  equal(await tile(page, 'fishy').getAttribute('data-status'), 'owned');

  await page.locator('#toastUndo').click();
  equal(await tile(page, 'fishy').getAttribute('data-status'), 'needed', 'after undo');
});

await check('a tile is operable from the keyboard', async () => {
  const main = tile(page, 'air').locator('.tile-main');
  await main.focus();

  await page.keyboard.press('Enter');
  equal(await tile(page, 'air').getAttribute('data-status'), 'owned', 'Enter cycles once');

  await page.keyboard.press('Space');
  equal(await tile(page, 'air').getAttribute('data-status'), 'maxed', 'Space cycles once, not twice');

  await page.keyboard.press('Enter');
  equal(await tile(page, 'air').getAttribute('data-status'), 'needed', 'back to needed');
});

await check('the hunt button is separately reachable and labelled', async () => {
  const hunt = tile(page, 'duck').locator('.tile-hunt');
  await hunt.focus();
  equal(await hunt.getAttribute('aria-pressed'), 'false');
  assert(
    (await hunt.getAttribute('aria-label')).includes('Duck Sprite'),
    'hunt button needs to name the sprite it flags',
  );

  await page.keyboard.press('Enter');
  equal(await tile(page, 'duck').getAttribute('data-hunting'), 'true');
  equal(await tile(page, 'duck').getAttribute('data-status'), 'needed', 'must not also cycle status');

  await page.keyboard.press('Enter'); // toggle back off
  equal(await tile(page, 'duck').getAttribute('data-hunting'), 'false');
});

await check('the middle of a tile is the status button, never the hunt ring', async () => {
  // The hunt ring lives inside the tile, so shrinking the tile can slide it
  // under the centre — where a thumb lands. That turns "mark this owned" into
  // "add it to the hunting list", silently, on every tile.
  const first = page.locator('.tile').first();
  // elementFromPoint reads viewport coordinates, so the tile has to be in it.
  await first.scrollIntoViewIfNeeded();

  const hit = (el) => {
    const box = el.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return target?.closest('button')?.className || 'nothing';
  };

  equal(await first.evaluate(hit), 'tile-main', 'centre of the tile');

  // Compact mode shrinks the tile and the ring by different amounts, so it is
  // its own chance to get this wrong.
  await page.evaluate(() => document.body.classList.add('compact'));
  equal(await first.evaluate(hit), 'tile-main', 'centre of a compact tile');
  await page.evaluate(() => document.body.classList.remove('compact'));
});

await check('every tile exposes exactly two focusable controls', async () => {
  const shape = await page.locator('.tile').first().evaluate((el) => ({
    role: el.getAttribute('role'),
    buttons: el.querySelectorAll('button').length,
    nested: el.querySelectorAll('button button').length,
  }));

  equal(shape.role, 'group');
  equal(shape.buttons, 2, 'status button + hunt button');
  equal(shape.nested, 0, 'no interactive element inside another');
});

await check('filters narrow the grid', async () => {
  await page.locator('.chip[data-filter="maxed"]').click();
  equal(await page.locator('.tile').count(), 1, 'maxed filter');
  equal(await page.locator('.tile').first().getAttribute('data-id'), 'earth');

  await page.locator('.chip[data-filter="owned"]').click();
  equal(await page.locator('.tile').count(), 2, 'owned filter');

  await page.locator('.chip[data-filter="all"]').click();
  equal(await page.locator('.tile').count(), 111, 'back to all');
});

await check('search finds an entry by the name the game gives it', async () => {
  await page.locator('#search').fill('gold water');
  equal(await tileIds(page), ['water.gold']);

  await page.locator('#searchClear').click();
  equal(await page.locator('.tile').count(), 111, 'cleared');
});

await check("search also accepts Epic's patch-note spelling", async () => {
  // The game calls it Grim; the v41.10 notes call it Grim Reaper. Players who
  // only ever read the patch notes have to be able to find it.
  await page.locator('#search').fill('grim reaper');
  const names = await page.locator('.group-name').allTextContents();
  equal(names, ['Grim Sprite']);

  await page.locator('#searchClear').click();
});

await check('search matches what a sprite does and where it is found', async () => {
  await page.locator('#search').fill('pickaxe');
  equal(await page.locator('.group-name').allTextContents(), ['King Sprite']);

  await page.locator('#search').fill('nighttime');
  equal(await page.locator('.group-name').allTextContents(), ['Ghost Sprite']);

  await page.locator('#searchClear').click();
});

await check('the detail sheet carries the numbers you would otherwise go look up', async () => {
  await tile(page, 'zeropoint.holofoil').click({ delay: 700 }); // long press
  await page.waitForSelector('#detail[open]');

  equal(await page.locator('#detailTitle').textContent(), 'Holofoil Zero Point Sprite');
  equal(await page.locator('#detailRarity').textContent(), 'Mythic');
  equal(await page.locator('#detailVariant').textContent(), 'Holofoil');
  assert(
    (await page.locator('#detailPower').textContent()).includes('Shield Bubble Jr.'),
    'the base power belongs on every variant',
  );
  assert(
    (await page.locator('#factPerk').textContent()).includes('rare Sprite Variants'),
    'and the variant adds its own perk on top',
  );
  equal(await page.locator('#factDust').textContent(), '10,000 Sprite Dust');
  // A string of leading zeroes would tell the player nothing.
  equal(await page.locator('#factDrop').textContent(), '1 in 357,143');

  // The game supplies the name here, so there is nothing to rename.
  assert(await page.locator('#detailNameField').isHidden(), 'no name field on a catalog entry');
  assert(await page.locator('#detailDelete').isHidden(), 'a catalog entry cannot be deleted');
});

await check('notes written in the sheet are searchable', async () => {
  await page.locator('#detailNotes').fill('squadmate has this one');
  await page.locator('#detailNotes').blur();
  await page.keyboard.press('Escape');
  await page.waitForSelector('#detail[open]', { state: 'detached' }).catch(() => {});

  await page.locator('#search').fill('squadmate');
  equal(await tileIds(page), ['zeropoint.holofoil']);
  await page.locator('#searchClear').click();
});

await check('the long press did not also cycle the status', async () => {
  equal(await tile(page, 'zeropoint.holofoil').getAttribute('data-status'), 'needed');
});

await check('state survives a reload', async () => {
  await page.reload();
  await page.waitForSelector('.tile');

  equal(await page.locator('#progressCount').textContent(), '3 / 109');
  equal(await tile(page, 'earth').getAttribute('data-status'), 'maxed');
});

await check('a sprite Epic ships early can be added by hand', async () => {
  // The catalog is a snapshot of a live game, so there has to be a way to
  // track something that landed before the app was redeployed.
  await page.locator('#menuBtn').click();
  await page.waitForSelector('#menu[open]');
  await page.locator('#customName').fill('Brand New Sprite');
  await page.locator('#addCustom').click();
  await page.keyboard.press('Escape');

  equal(await page.locator('#progressCount').textContent(), '3 / 110');
  equal(await page.locator('.group').last().locator('.group-name').textContent(), 'Your own entries');
  equal(await tile(page, 'custom.1').locator('.tile-label').textContent(), 'Brand New Sprite');

  await page.locator('#search').fill('brand new');
  equal(await tileIds(page), ['custom.1']);
  await page.locator('#searchClear').click();
});

// The real checkbox is visually hidden behind a custom switch, so the label is
// what a person actually taps.
const toggleSwitch = (target, id) => target.locator(`label.switch:has(#${id})`).click();

await check('never-released entries stay hidden until you ask for them', async () => {
  // Vaulted is not the same as never released: one is coming back on a date,
  // the other has never existed for players, and only the second is hidden.
  equal(await tile(page, 'ironmouse').count(), 1, 'vaulted, so shown');
  equal(await tile(page, 'water.gem').count(), 0, 'never shipped, so hidden');

  await page.locator('#menuBtn').click();
  await page.waitForSelector('#menu[open]');
  await toggleSwitch(page, 'unreleasedToggle');
  await page.keyboard.press('Escape');

  equal(await page.locator('#progressCount').textContent(), '3 / 119');
  equal(await tile(page, 'water.gem').count(), 1, 'now showing');
  equal(await tile(page, 'ironmouse').getAttribute('data-state'), 'vaulted');
  equal(await tile(page, 'water.gem').getAttribute('data-state'), 'datamined');
  equal(await tile(page, 'water').getAttribute('data-state'), 'live');

  await tile(page, 'ironmouse').click({ delay: 700 });
  await page.waitForSelector('#detail[open]');
  assert(
    (await page.locator('#detailState').textContent()).startsWith('Vaulted'),
    'a vaulted sprite has to say when it comes back',
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('#detail[open]', { state: 'detached' }).catch(() => {});

  await page.locator('#menuBtn').click();
  await page.waitForSelector('#menu[open]');
  await toggleSwitch(page, 'unreleasedToggle');
  await page.keyboard.press('Escape');
  equal(await page.locator('#progressCount').textContent(), '3 / 110');
});

/* ------------------------------ install --------------------------------- */

await check('the install panel reports where you stand', async () => {
  await page.locator('#menuBtn').click();
  await page.waitForSelector('#menu[open]');

  equal(await page.locator('#installTag').textContent(), 'Not installed');
  // Headless Chrome fires no beforeinstallprompt and is not iOS, so there is
  // nothing to offer — and the app says so rather than showing a dead button.
  assert(await page.locator('#installActions').isHidden(), 'no button without a prompt to replay');
  assert(await page.locator('#installSteps').isHidden(), 'the Share steps are iOS-only');
  assert(
    (await page.locator('#installBlurb').textContent()).includes('own menu'),
    'it should point at the browser menu instead',
  );

  await page.keyboard.press('Escape');
  assert(await page.locator('#installBar').isHidden(), 'no nudge with no route to offer');
});

await check('an iPhone gets the Share steps, because it never fires the prompt', async () => {
  // The case that matters most here and is easiest to leave broken: iOS Safari
  // has no beforeinstallprompt at all, so a prompt-only implementation shows
  // iPhone users nothing.
  const ios = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

  const phone = await ios.newPage();
  phone.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await phone.goto(base);
  await phone.waitForSelector('.tile');

  assert(await phone.locator('#installBar').isVisible(), 'the nudge should show');
  equal(await phone.locator('#installBarAction').textContent(), 'How');

  await phone.locator('#installBarAction').click();
  await phone.waitForSelector('#menu[open]');
  assert(await phone.locator('#installSteps').isVisible(), 'Share steps');
  assert(await phone.locator('#installActions').isHidden(), 'nothing to prompt on iOS');
  await phone.keyboard.press('Escape');

  // Waving it away has to stick, or it becomes the thing you dismiss daily.
  await phone.locator('#installDismiss').click();
  assert(await phone.locator('#installBar').isHidden(), 'hidden after dismiss');

  await phone.reload();
  await phone.waitForSelector('.tile');
  assert(await phone.locator('#installBar').isHidden(), 'still hidden after a reload');

  await ios.close();
});

await check('the installed copy is not asked to install itself', async () => {
  const installed = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await installed.addInitScript(() => {
    // Safari's flag for "launched from the home screen".
    Object.defineProperty(navigator, 'standalone', { get: () => true });
  });

  const app = await installed.newPage();
  await app.goto(base);
  await app.waitForSelector('.tile');

  assert(await app.locator('#installBar').isHidden(), 'no nudge once installed');
  await app.locator('#menuBtn').click();
  await app.waitForSelector('#menu[open]');
  equal(await app.locator('#installTag').textContent(), 'Installed');
  assert(await app.locator('#installActions').isHidden());
  assert(await app.locator('#installSteps').isHidden());

  await installed.close();
});

await check('the coming-back list can be waved away, until the news changes', async () => {
  // Its own context: dismissing it here would take it out of every check and
  // screenshot that follows.
  const reader = await newPage();
  await reader.goto(base);
  await reader.waitForSelector('.tile');
  assert(await reader.locator('#comingSoon').isVisible(), 'shown to start with');

  await reader.locator('#soonDismiss').click();
  assert(await reader.locator('#comingSoon').isHidden(), 'gone on the tap');

  await reader.reload();
  await reader.waitForSelector('.tile');
  assert(await reader.locator('#comingSoon').isHidden(), 'and still gone after a reload');

  // Dismissal is against what the section said, not the section itself. Age the
  // stored key the way a new vaulting or a moved date would.
  await reader.evaluate(() => {
    const ui = JSON.parse(localStorage.getItem('forknife67.ui.v1'));
    localStorage.setItem('forknife67.ui.v1', JSON.stringify({ ...ui, soonDismissed: 'oldnews:2020-01-01' }));
  });
  await reader.reload();
  await reader.waitForSelector('.tile');
  assert(await reader.locator('#comingSoon').isVisible(), 'new news has to get through');

  await reader.context().close();
});

await check('a first run takes the palette from the device, not a fixed default', async () => {
  const night = await newPage({ colorScheme: 'dark' });
  await night.goto(base);
  await night.waitForSelector('.tile');

  equal(await night.evaluate(() => document.documentElement.dataset.theme), 'dark');
  equal(
    await night.locator('[data-theme-set="system"]').getAttribute('aria-pressed'),
    'true',
    'and the menu says which one is doing the choosing',
  );

  // Picking one is still a decision: it sticks, and it outranks the device.
  await night.locator('#menuBtn').click();
  await night.waitForSelector('#menu[open]');
  await night.locator('[data-theme-set="light"]').click();
  await night.reload();
  await night.waitForSelector('.tile');
  equal(await night.evaluate(() => document.documentElement.dataset.theme), 'light');

  await night.context().close();
});

await check('a device carrying the old Light default is moved onto System, once', async () => {
  const upgraded = await newPage({ colorScheme: 'dark' });
  await upgraded.goto(base);

  // Exactly what the previous version wrote for someone who never opened the
  // Appearance panel: saveUi serialises the whole object, so the default of the
  // day is on every device whether or not anyone chose it.
  await upgraded.evaluate(() => {
    localStorage.setItem(
      'forknife67.ui.v1',
      JSON.stringify({ filter: 'all', query: '', compact: false, theme: 'light', syncCode: '', lastSync: 0, installDismissed: false }),
    );
  });
  await upgraded.reload();
  await upgraded.waitForSelector('.tile');

  equal(await upgraded.evaluate(() => document.documentElement.dataset.theme), 'dark');
  equal(
    await upgraded.evaluate(() => JSON.parse(localStorage.getItem('forknife67.ui.v1')).theme),
    'system',
    'and the upgrade is written down, not re-derived every load',
  );

  // The one that matters: picking Light afterwards is a real choice, and a
  // second run of the migration must not take it away again.
  await upgraded.locator('#menuBtn').click();
  await upgraded.waitForSelector('#menu[open]');
  await upgraded.locator('[data-theme-set="light"]').click();
  await upgraded.reload();
  await upgraded.waitForSelector('.tile');
  equal(await upgraded.evaluate(() => document.documentElement.dataset.theme), 'light');

  await upgraded.context().close();
});

/* ------------------------- two-device sync ------------------------------ */

let vaultCode = '';

await check('creating a vault pushes this device up to the server', async () => {
  await page.locator('#menuBtn').click();
  await page.waitForSelector('#menu[open]');
  await page.locator('#codeCreate').click();

  await page.waitForFunction(() => document.getElementById('syncTag').textContent === 'On', null, {
    timeout: 8000,
  });

  vaultCode = (await page.locator('#codeInput').inputValue()).replace(/-/g, '');
  equal(vaultCode.length, 16, 'code length');
  await page.keyboard.press('Escape');
});

const second = await newPage({ mobile: false });

await check('a second device connecting with the code pulls the collection', async () => {
  await second.goto(base);
  await second.waitForSelector('.tile');
  equal(await second.locator('#progressCount').textContent(), '0 / 109', 'starts empty');

  await second.locator('#menuBtn').click();
  await second.waitForSelector('#menu[open]');
  await second.locator('#codeInput').fill(vaultCode);
  await second.locator('#codeConnect').click();

  await second.waitForFunction(() => document.getElementById('progressCount').textContent === '3 / 110', null, {
    timeout: 8000,
  });

  equal(await second.locator('#legendMaxed').textContent(), '1');
  // The hand-added entry has to travel too, or the two devices disagree on the
  // denominator and neither total means anything.
  equal(await second.locator('.tile[data-id="custom.1"] .tile-label').textContent(), 'Brand New Sprite');
  await second.keyboard.press('Escape');
});

/**
 * Awaiting __forknife.sync() is the only deterministic "my edits are on the
 * server" signal. Watching the sync badge flip to "On" is a trap: it is
 * already "On" from the previous sync, so the wait returns instantly and the
 * assertion races the request.
 */
const syncDevice = (target) => target.evaluate(() => window.__forknife.sync());

await check('an edit on device two reaches device one', async () => {
  await second.locator('.tile[data-id="ghost"]').click(); // -> owned
  await syncDevice(second); // push must land before device one pulls
  await syncDevice(page);

  equal(await tile(page, 'ghost').getAttribute('data-status'), 'owned');
  equal(await page.locator('#progressCount').textContent(), '4 / 110');
});

await check('simultaneous edits on different sprites both survive', async () => {
  await page.locator('.tile[data-id="king"]').click(); // device one -> owned
  await second.locator('.tile[data-id="striker"]').click(); // device two -> owned

  // Both push, then both pull, so each device has seen the other's edit.
  await Promise.all([syncDevice(page), syncDevice(second)]);
  await Promise.all([syncDevice(page), syncDevice(second)]);

  equal(await tile(page, 'king').getAttribute('data-status'), 'owned', 'own edit kept');
  equal(await tile(page, 'striker').getAttribute('data-status'), 'owned', 'other device edit received');
  equal(await page.locator('#progressCount').textContent(), '6 / 110', 'device one');
  equal(await second.locator('#progressCount').textContent(), '6 / 110', 'device two');
});

await check('a queued sync is never silently dropped', async () => {
  // Three overlapping calls with no awaits between them: chaining means all
  // three run, and the last one still reflects the edit made before them.
  await page.locator('.tile[data-id="seven"]').click();
  await page.evaluate(() => Promise.all([
    window.__forknife.sync(),
    window.__forknife.sync(),
    window.__forknife.sync(),
  ]));

  await syncDevice(second);
  equal(await tile(second, 'seven').getAttribute('data-status'), 'owned', 'edit reached the other device');
});

await check('deleting a hand-added entry does not come back on the next sync', async () => {
  // A plain delete would leave the server holding the old copy, and the next
  // merge would hand it straight back to both devices.
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await tile(page, 'custom.1').click({ delay: 700 });
  await page.waitForSelector('#detail[open]');
  await page.locator('#detailDelete').click();

  equal(await tile(page, 'custom.1').count(), 0, 'gone from device one');

  await syncDevice(page);
  await syncDevice(second);
  equal(await tile(second, 'custom.1').count(), 0, 'and gone from device two');

  await syncDevice(page);
  equal(await tile(page, 'custom.1').count(), 0, 'and it stays gone');
});

/* ------------------------------ offline --------------------------------- */

await check('the app still works with the network cut', async () => {
  await page.context().setOffline(true);
  await page.locator('.tile[data-id="grim"]').click();
  equal(await tile(page, 'grim').getAttribute('data-status'), 'owned', 'marking works offline');
  await page.context().setOffline(false);
});

/* ---------------------------- screenshots ------------------------------- */

await page.keyboard.press('Escape');
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: path.join(SHOT_DIR, '01-mobile-light.png'), fullPage: false });

await page.locator('.chip[data-filter="owned"]').click();
await page.screenshot({ path: path.join(SHOT_DIR, '02-mobile-filter.png') });
await page.locator('.chip[data-filter="all"]').click();

await tile(page, 'zeropoint.holofoil').click({ delay: 700 });
await page.waitForSelector('#detail[open]');
await page.screenshot({ path: path.join(SHOT_DIR, '03-mobile-detail.png') });
await page.keyboard.press('Escape');

await page.locator('#menuBtn').click();
await page.waitForSelector('#menu[open]');
await page.screenshot({ path: path.join(SHOT_DIR, '04-mobile-menu.png') });
await page.locator('[data-theme-set="dark"]').click();
await page.keyboard.press('Escape');

// Reload rather than screenshot the theme swap in place. A hidden or throttled
// tab freezes CSS transitions at their first frame, so the tiles would still be
// painted in the old palette when the shutter goes; after a reload they render
// in the new one directly, with nothing to transition from.
await page.reload();
await page.waitForSelector('.tile');
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: path.join(SHOT_DIR, '05-mobile-dark.png') });

await second.evaluate(() => window.scrollTo(0, 0));
await second.screenshot({ path: path.join(SHOT_DIR, '06-desktop-light.png') });


/* ------------------------------- report --------------------------------- */

await check('no uncaught console errors during the whole run', () => {
  const ignorable = [
    // A failed fetch while deliberately offline is expected, not a defect.
    /sync failed|Failed to fetch|net::ERR_INTERNET_DISCONNECTED/i,
    // Cloudflare injects its analytics beacon into HTML served on the custom
    // domain, after the Worker has run and regardless of the zone's RUM
    // setting being off. Our CSP blocks it, which is the correct outcome and
    // exactly why it logs. Nothing we ship references it, and there is no
    // setting in the dashboard that stops it — so when BASE_URL points at
    // production this is the one error that is not ours.
    //
    // Matched by host, not by "CSP violation": a violation caused by our own
    // code still has to fail this check.
    /static\.cloudflareinsights\.com/i,
  ];

  const real = consoleErrors.filter((line) => !ignorable.some((re) => re.test(line)));
  assert(real.length === 0, `console errors:\n${real.join('\n')}`);
});

await browser.close();
if (server) await new Promise((resolve) => server.close(resolve));
if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
console.log(`screenshots: ${SHOT_DIR}`);
process.exit(failures.length ? 1 : 0);
