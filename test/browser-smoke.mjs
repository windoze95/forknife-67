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
  if (actual !== expected) {
    throw new Error(`${message || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------ boot server ----------------------------- */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forknife-e2e-'));
process.env.DATA_DIR = dataDir;

const { createServer } = await import('../server/server.js');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`server: ${base}\n`);

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

/* --------------------------------- tests -------------------------------- */

const page = await newPage();
await page.goto(base);
await page.waitForSelector('.tile');

await check('renders exactly 111 sprite tiles', async () => {
  equal(await page.locator('.tile').count(), 111, 'tile count');
});

await check('starts at 0 / 111 collected', async () => {
  equal(await page.locator('#progressCount').textContent(), '0 / 111');
  equal(await page.locator('#progressPct').textContent(), '0%');
});

await check('tapping a tile cycles needed -> owned -> maxed -> needed', async () => {
  const t = tile(page, 7);
  equal(await t.getAttribute('data-status'), 'needed', 'initial');

  await t.click();
  equal(await t.getAttribute('data-status'), 'owned', 'after 1st tap');

  await t.click();
  equal(await t.getAttribute('data-status'), 'maxed', 'after 2nd tap');

  await t.click();
  equal(await t.getAttribute('data-status'), 'needed', 'after 3rd tap');
});

await check('progress counts owned and maxed separately', async () => {
  await tile(page, 1).click(); // owned
  await tile(page, 2).click();
  await tile(page, 2).click(); // maxed

  equal(await page.locator('#progressCount').textContent(), '2 / 111');
  equal(await page.locator('#legendOwned').textContent(), '1');
  equal(await page.locator('#legendMaxed').textContent(), '1');
  equal(await page.locator('#legendNeeded').textContent(), '109');
});

await check('the maxed tile shows a crown mark', async () => {
  equal(await tile(page, 2).locator('.tile-mark').textContent(), '♛');
  equal(await tile(page, 1).locator('.tile-mark').textContent(), '✓');
});

await check('the hunting button flags a sprite without changing status', async () => {
  await tile(page, 30).locator('.tile-hunt').click();
  equal(await tile(page, 30).getAttribute('data-hunting'), 'true');
  equal(await tile(page, 30).getAttribute('data-status'), 'needed', 'status untouched');
  equal(await page.locator('#legendHunting').textContent(), '1');
});

await check('finding a hunted sprite takes it off the hunting list', async () => {
  await tile(page, 30).click(); // -> owned
  equal(await tile(page, 30).getAttribute('data-status'), 'owned');
  equal(await tile(page, 30).getAttribute('data-hunting'), 'false', 'should auto-clear');
  equal(await page.locator('#legendHunting').textContent(), '0');
});

await check('undo restores the previous state', async () => {
  await tile(page, 55).click(); // -> owned
  equal(await tile(page, 55).getAttribute('data-status'), 'owned');

  await page.locator('#toastUndo').click();
  equal(await tile(page, 55).getAttribute('data-status'), 'needed', 'after undo');
});

await check('a tile is operable from the keyboard', async () => {
  const main = tile(page, 60).locator('.tile-main');
  await main.focus();

  await page.keyboard.press('Enter');
  equal(await tile(page, 60).getAttribute('data-status'), 'owned', 'Enter cycles once');

  await page.keyboard.press('Space');
  equal(await tile(page, 60).getAttribute('data-status'), 'maxed', 'Space cycles once, not twice');

  await page.keyboard.press('Enter');
  equal(await tile(page, 60).getAttribute('data-status'), 'needed', 'back to needed');
});

await check('the hunt button is separately reachable and labelled', async () => {
  const hunt = tile(page, 61).locator('.tile-hunt');
  await hunt.focus();
  equal(await hunt.getAttribute('aria-pressed'), 'false');
  assert(
    (await hunt.getAttribute('aria-label')).includes('hunting list'),
    'hunt button needs its own label',
  );

  await page.keyboard.press('Enter');
  equal(await tile(page, 61).getAttribute('data-hunting'), 'true');
  equal(await tile(page, 61).getAttribute('data-status'), 'needed', 'must not also cycle status');

  await page.keyboard.press('Enter'); // toggle back off
  equal(await tile(page, 61).getAttribute('data-hunting'), 'false');
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
  equal(await page.locator('.tile').first().getAttribute('data-id'), '2');

  await page.locator('.chip[data-filter="owned"]').click();
  equal(await page.locator('.tile').count(), 2, 'owned filter');

  await page.locator('.chip[data-filter="all"]').click();
  equal(await page.locator('.tile').count(), 111, 'back to all');
});

await check('search matches by number', async () => {
  await page.locator('#search').fill('10');
  // 10, 100-109, 110, 111 all start with "10" or "1"… prefix match on "10"
  const ids = await page.locator('.tile').evaluateAll((els) => els.map((e) => e.dataset.id));
  assert(ids.includes('10'), 'sprite 10 should match');
  assert(ids.includes('100'), 'sprite 100 should match');
  assert(!ids.includes('11'), 'sprite 11 should not match "10"');
  await page.locator('#searchClear').click();
  equal(await page.locator('.tile').count(), 111, 'cleared');
});

await check('the detail sheet renames a sprite and search finds it', async () => {
  await tile(page, 42).click({ delay: 700 }); // long press
  await page.waitForSelector('#detail[open]');

  await page.locator('#detailName').fill('little blue one');
  await page.locator('#detailNotes').fill('found near the river');
  await page.locator('#detailName').blur();
  await page.locator('#detailNotes').blur();
  await page.keyboard.press('Escape');
  await page.waitForSelector('#detail[open]', { state: 'detached' }).catch(() => {});

  await page.locator('#search').fill('blue');
  const ids = await page.locator('.tile').evaluateAll((els) => els.map((e) => e.dataset.id));
  equal(ids.length, 1, 'one match for "blue"');
  equal(ids[0], '42');

  await page.locator('#searchClear').click();
});

await check('the long press did not also cycle the status', async () => {
  equal(await tile(page, 42).getAttribute('data-status'), 'needed');
});

await check('state survives a reload', async () => {
  await page.reload();
  await page.waitForSelector('.tile');

  equal(await page.locator('#progressCount').textContent(), '3 / 111');
  equal(await tile(page, 2).getAttribute('data-status'), 'maxed');
  equal(await tile(page, 42).locator('.tile-name').textContent(), 'little blue one');
});

await check('raising the total adds slots without losing data', async () => {
  await page.locator('#menuBtn').click();
  await page.waitForSelector('#menu[open]');
  await page.locator('#totalInput').fill('120');
  await page.locator('#totalInput').blur();
  await page.keyboard.press('Escape');

  equal(await page.locator('.tile').count(), 120);
  equal(await page.locator('#progressCount').textContent(), '3 / 120');
  equal(await tile(page, 2).getAttribute('data-status'), 'maxed', 'existing marks kept');

  // put it back
  await page.locator('#menuBtn').click();
  await page.locator('#totalInput').fill('111');
  await page.locator('#totalInput').blur();
  await page.keyboard.press('Escape');
  equal(await page.locator('.tile').count(), 111);
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
  equal(await second.locator('#progressCount').textContent(), '0 / 111', 'starts empty');

  await second.locator('#menuBtn').click();
  await second.waitForSelector('#menu[open]');
  await second.locator('#codeInput').fill(vaultCode);
  await second.locator('#codeConnect').click();

  await second.waitForFunction(() => document.getElementById('progressCount').textContent === '3 / 111', null, {
    timeout: 8000,
  });

  equal(await second.locator('#legendMaxed').textContent(), '1');
  equal(await second.locator('.tile[data-id="42"] .tile-name').textContent(), 'little blue one');
  await second.keyboard.press('Escape');
});

await check('an edit on device two reaches device one', async () => {
  await second.locator('.tile[data-id="88"]').click(); // -> owned
  await second.evaluate(() => document.getElementById('syncNow').click());
  await second.waitForFunction(() => document.getElementById('syncTag').textContent === 'On', null, {
    timeout: 8000,
  });

  await page.evaluate(() => document.getElementById('syncNow').click());
  await page.waitForFunction(
    () => document.querySelector('.tile[data-id="88"]')?.dataset.status === 'owned',
    null,
    { timeout: 8000 },
  );

  equal(await page.locator('#progressCount').textContent(), '4 / 111');
});

await check('simultaneous edits on different sprites both survive', async () => {
  await page.locator('.tile[data-id="15"]').click(); // device one -> owned
  await second.locator('.tile[data-id="16"]').click(); // device two -> owned

  await page.evaluate(() => document.getElementById('syncNow').click());
  await second.evaluate(() => document.getElementById('syncNow').click());
  await page.evaluate(() => document.getElementById('syncNow').click());
  await second.evaluate(() => document.getElementById('syncNow').click());

  await page.waitForFunction(
    () =>
      document.querySelector('.tile[data-id="15"]')?.dataset.status === 'owned' &&
      document.querySelector('.tile[data-id="16"]')?.dataset.status === 'owned',
    null,
    { timeout: 8000 },
  );

  equal(await page.locator('#progressCount').textContent(), '6 / 111', 'device one');
  equal(await second.locator('#progressCount').textContent(), '6 / 111', 'device two');
});

/* ------------------------------ offline --------------------------------- */

await check('the app still works with the network cut', async () => {
  await page.context().setOffline(true);
  await page.locator('.tile[data-id="99"]').click();
  equal(await tile(page, 99).getAttribute('data-status'), 'owned', 'marking works offline');
  await page.context().setOffline(false);
});

/* ---------------------------- screenshots ------------------------------- */

await page.keyboard.press('Escape');
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: path.join(SHOT_DIR, '01-mobile-dark.png'), fullPage: false });

await page.locator('.chip[data-filter="owned"]').click();
await page.screenshot({ path: path.join(SHOT_DIR, '02-mobile-filter.png') });
await page.locator('.chip[data-filter="all"]').click();

await tile(page, 42).click({ delay: 700 });
await page.waitForSelector('#detail[open]');
await page.screenshot({ path: path.join(SHOT_DIR, '03-mobile-detail.png') });
await page.keyboard.press('Escape');

await page.locator('#menuBtn').click();
await page.waitForSelector('#menu[open]');
await page.screenshot({ path: path.join(SHOT_DIR, '04-mobile-menu.png') });
await page.locator('[data-theme-set="light"]').click();
await page.keyboard.press('Escape');
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: path.join(SHOT_DIR, '05-mobile-light.png') });

await second.evaluate(() => window.scrollTo(0, 0));
await second.screenshot({ path: path.join(SHOT_DIR, '06-desktop-dark.png') });

/* ------------------------------- report --------------------------------- */

await check('no uncaught console errors during the whole run', () => {
  // A failed fetch while deliberately offline is expected and not a defect.
  const real = consoleErrors.filter((line) => !/sync failed|Failed to fetch|net::ERR_INTERNET_DISCONNECTED/i.test(line));
  assert(real.length === 0, `console errors:\n${real.join('\n')}`);
});

await browser.close();
await new Promise((resolve) => server.close(resolve));
await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
console.log(`screenshots: ${SHOT_DIR}`);
process.exit(failures.length ? 1 : 0);
