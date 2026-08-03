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

async function newPage({ mobile = true } = {}) {
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
      : { viewport: { width: 1280, height: 900 } },
  );

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  return page;
}

const tile = (page, id) => page.locator(`.tile[data-id="${id}"]`);
const group = (page, key) => page.locator(`.group[data-key="${key}"]`);
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
  equal(await water.locator('.group-count').textContent(), '0 / 6');
  equal(
    await water.locator('.group-power').textContent(),
    'Replenish shields while standing in water!',
  );
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
  equal(await group(page, 'water').locator('.group-count').textContent(), '1 / 6');
  equal(await group(page, 'fire').locator('.group-count').textContent(), '0 / 7');
});

await check('the heading goes gold as soon as anything in it is mastered', async () => {
  // Nothing mastered in Water yet — Earth has one.
  equal(await group(page, 'water').getAttribute('data-maxed'), 'none');
  equal(await group(page, 'earth').getAttribute('data-maxed'), 'some');

  // Mastering every variant of a sprite is the state that earns both halves.
  for (const id of ['johnwick', 'pollo']) {
    await tile(page, id).click();
    await tile(page, id).click();
  }

  equal(await group(page, 'johnwick').getAttribute('data-maxed'), 'all');
  equal(await group(page, 'pollo').getAttribute('data-maxed'), 'all');

  // The data attribute is only half of it — a CSS rule has to actually win.
  // "All collected" paints the left number green, and all-mastered has to beat
  // it, which is a specificity fight that loses silently.
  const colours = await group(page, 'johnwick').evaluate((el) => {
    // Resolve the --maxed token through the browser so the comparison is
    // against whatever the theme actually paints, not a hardcoded hex.
    const probe = document.createElement('span');
    probe.style.color = 'var(--maxed)';
    el.append(probe);
    const gold = getComputedStyle(probe).color;
    probe.remove();

    return {
      left: getComputedStyle(el.querySelector('.gc-have')).color,
      right: getComputedStyle(el.querySelector('.gc-total')).color,
      gold,
    };
  });

  equal(colours.left, colours.gold, 'left half of an all-mastered counter');
  equal(colours.right, colours.gold, 'right half of an all-mastered counter');

  // Put them back so the counts the later sync checks rely on still hold.
  for (const id of ['johnwick', 'pollo']) await tile(page, id).click();
  equal(await group(page, 'johnwick').getAttribute('data-maxed'), 'none');
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
