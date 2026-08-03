/**
 * forknife-67 — Fortnite sprite tracker.
 *
 * The whole point: in game you cannot tell a sprite is already yours unless it
 * is maxed (crowned). So the app is optimised for one action performed mid
 * match — "did I already get this one?" — answered in a glance, then marked in
 * a single tap, offline, on a phone.
 */

import {
  STATUSES,
  STATUS_LABEL,
  makeSprite,
  normalizeDoc,
  mergeDocs,
  compactDoc,
  emptyDoc,
  countsFor,
  groupCounts,
  groupTier,
  catalogEntry,
  customIds,
  nextCustomId,
  isBlankSprite,
  generateCode,
  normalizeCode,
  formatCode,
  isValidCode,
} from './lib/vault.js';

import {
  CATALOG_PATCH,
  ALL_ENTRIES,
  RELEASED_ENTRIES,
  VAULTED_ENTRIES,
  RARITY_LABEL,
  groupsFor,
  searchTextFor,
  formatDrop,
  isCustomId,
} from './lib/catalog.js';

const APP_VERSION = '2.5.3';
const DOC_KEY = 'forknife67.doc.v1';
const UI_KEY = 'forknife67.ui.v1';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------- */
/* State                                                                    */
/* ---------------------------------------------------------------------- */

let doc = emptyDoc();

let ui = {
  filter: 'all',
  query: '',
  compact: false,
  // Follow the device unless the player says otherwise: someone who runs their
  // phone dark is checking a chest in a dark room, and a white screen there is
  // the app's own fault. Anyone who picks Light or Dark keeps it on every load,
  // and it syncs nowhere — a phone and a PC can disagree about this one.
  theme: 'system',
  // Set once, by migrateTheme. See it for why this has to be sticky.
  themeMigrated: false,
  syncCode: '',
  lastSync: 0,
  installDismissed: false,
  // Which coming-back announcement was waved away, not merely that one was.
  soonDismissed: '',
};

/** Snapshot of the sprite before the most recent change, for the Undo button. */
let undoEntry = null;

let detailId = null;

/* ---------------------------------------------------------------------- */
/* Persistence                                                              */
/* ---------------------------------------------------------------------- */

function loadLocal() {
  try {
    const rawDoc = localStorage.getItem(DOC_KEY);
    if (rawDoc) doc = normalizeDoc(JSON.parse(rawDoc));
  } catch (err) {
    // A corrupted blob must not brick the app — start clean rather than crash.
    console.warn('[forknife] could not read saved sprites:', err);
  }

  try {
    const rawUi = localStorage.getItem(UI_KEY);
    if (rawUi) ui = { ...ui, ...JSON.parse(rawUi) };
  } catch (err) {
    console.warn('[forknife] could not read saved settings:', err);
  }

  if (!STATUSES.includes(ui.filter) && !['all', 'hunting'].includes(ui.filter)) {
    ui.filter = 'all';
  }

  migrateTheme();
}

/**
 * Carry devices from the old Light default onto System, once.
 *
 * `saveUi` writes the whole settings object, so every device that ever changed
 * a filter is holding a `light` nobody chose — it was simply the default at the
 * moment of some unrelated write. Left alone, those devices would never see the
 * new default at all.
 *
 * Only `light` is ambiguous: `dark` and `system` were never defaults, so a
 * stored one can only have come from the Appearance panel. The flag has to be
 * persisted even when nothing moved, because without it this would run again on
 * the next load and undo a Light the player has since picked on purpose.
 */
function migrateTheme() {
  if (ui.themeMigrated === true) return;
  if (ui.theme === 'light') ui.theme = 'system';
  ui.themeMigrated = true;
  saveUi();
}

function saveDoc() {
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(compactDoc(doc)));
  } catch (err) {
    console.error('[forknife] save failed:', err);
    toast('Could not save — device storage is full.');
  }
}

function saveUi() {
  try {
    // `query` is deliberately not persisted — coming back to a silently
    // filtered grid reads as missing data.
    localStorage.setItem(UI_KEY, JSON.stringify({ ...ui, query: '' }));
  } catch { /* settings are not worth an error message */ }
}

/* ---------------------------------------------------------------------- */
/* Sprite access                                                            */
/* ---------------------------------------------------------------------- */

/** Untouched slots are not stored, so reads fall back to a default record. */
function getSprite(id) {
  return doc.sprites[id] || makeSprite(id, 0);
}

function writeSprite(id, patch) {
  const next = { ...getSprite(id), ...patch, id, updatedAt: Date.now() };
  doc.sprites[id] = next;
  saveDoc();
  scheduleSync();
  return next;
}

function setStatus(id, status, { remember = true } = {}) {
  const before = { ...getSprite(id) };
  const patch = { status };

  // Finding a sprite takes it off the hunting list automatically — leaving it
  // flagged would mean re-checking things you already have.
  if (status !== 'needed' && before.hunting) patch.hunting = false;

  writeSprite(id, patch);
  if (remember) undoEntry = before;

  updateTile(id);
  renderProgress();
  return patch;
}

function toggleHunting(id) {
  const before = { ...getSprite(id) };
  writeSprite(id, { hunting: !before.hunting });
  undoEntry = before;
  updateTile(id);
  renderProgress();
  return !before.hunting;
}

function applyUndo() {
  if (!undoEntry) return;
  const { id } = undoEntry;
  doc.sprites[id] = { ...undoEntry, updatedAt: Date.now() };
  undoEntry = null;
  saveDoc();
  scheduleSync();
  updateTile(id);
  renderProgress();
  if (detailId === id) renderDetail();
  hideToast();
}

/* ---------------------------------------------------------------------- */
/* Filtering                                                                */
/* ---------------------------------------------------------------------- */

/**
 * The catalog grouped by base sprite, with the player's own additions as a
 * final group. Groups are the unit of layout: one heading per sprite, then its
 * variants, because "which Water Sprites am I missing" is the question you
 * actually ask standing over a chest.
 */
function allGroups() {
  const groups = groupsFor(doc.unreleased).map(({ sprite, entries }) => ({
    key: sprite.key,
    sprite,
    entries,
  }));

  const mine = customIds(doc);
  if (mine.length) {
    groups.push({
      key: 'custom',
      sprite: null,
      entries: mine.map((id) => ({ id, name: getSprite(id).name || 'Untitled', variantLabel: '' })),
    });
  }

  return groups;
}

function matchesFilter(id) {
  const sprite = getSprite(id);
  if (ui.filter === 'hunting') return sprite.hunting;
  if (ui.filter === 'all') return true;
  return sprite.status === ui.filter;
}

/**
 * Search covers the catalog name, the spelling Epic uses in patch notes, the
 * rarity, the sprite's power and where it is found — plus whatever the player
 * wrote in their own notes.
 */
function matchesQuery(id, query) {
  if (!query) return true;
  if (searchTextFor(id).includes(query)) return true;

  const sprite = getSprite(id);
  return (
    sprite.name.toLowerCase().includes(query) || sprite.notes.toLowerCase().includes(query)
  );
}

/** Groups trimmed to the entries that survive the filter and the search. */
function visibleGroups() {
  const query = ui.query.trim().toLowerCase();
  const out = [];

  for (const group of allGroups()) {
    const entries = group.entries.filter(
      (entry) => matchesFilter(entry.id) && matchesQuery(entry.id, query),
    );
    // `all` is kept so the heading can read "2 / 6" against the whole sprite
    // rather than against whatever the current filter left standing.
    if (entries.length) out.push({ ...group, entries, all: group.entries });
  }

  return out;
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                                */
/* ---------------------------------------------------------------------- */

const grid = $('grid');
const tileNodes = new Map();

/** Ids currently on screen, in order — what Prev/Next in the sheet walks. */
let flatVisible = [];

/** The name the game shows. Custom entries fall back to what the player typed. */
function displayName(id) {
  const entry = catalogEntry(id);
  if (entry) return entry.name;
  return getSprite(id).name || 'Untitled entry';
}

/**
 * Artwork is keyed by entry id and generated by tools/fetch-sprite-art.js.
 * Custom entries have none — you can't have art for a sprite the app has never
 * heard of — so they fall back to the crown mark.
 */
function artFor(id) {
  return catalogEntry(id) ? `/sprites/${id}.webp` : '';
}

/**
 * A tile is a group wrapping two real buttons rather than one clickable div.
 * Nesting the hunt button inside a role="button" element would leave it
 * unreachable to a screen reader, and a div needs hand-rolled Enter/Space
 * handling that a <button> gets for free.
 */
function tileFor(id) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = id;
  tile.setAttribute('role', 'group');

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'tile-main';

  const mark = document.createElement('span');
  mark.className = 'tile-mark';
  main.append(mark);

  const art = document.createElement('img');
  art.className = 'tile-img';
  art.alt = '';
  // 109 tiles is 109 requests if they all load at once; only what is on screen
  // matters, and the rest arrive as you scroll.
  art.loading = 'lazy';
  art.decoding = 'async';
  art.width = 34;
  art.height = 34;
  main.append(art);

  const label = document.createElement('span');
  label.className = 'tile-label';
  main.append(label);

  tile.append(main);

  const hunt = document.createElement('button');
  hunt.type = 'button';
  hunt.className = 'tile-hunt';
  hunt.dataset.hunt = id;
  hunt.innerHTML = '<svg aria-hidden="true"><use href="#i-target"/></svg>';
  tile.append(hunt);

  tileNodes.set(id, tile);
  paintTile(tile, getSprite(id));
  return tile;
}

const MARK = { needed: '', owned: '✓', maxed: '♛' };

function paintTile(tile, sprite) {
  const entry = catalogEntry(sprite.id);
  const name = displayName(sprite.id);

  tile.dataset.status = sprite.status;
  tile.dataset.hunting = String(sprite.hunting);
  if (entry) {
    tile.dataset.variant = entry.variant;
    tile.dataset.state = entry.state;
  }

  tile.querySelector('.tile-mark').textContent = MARK[sprite.status];
  // Inside a group the sprite's name is already the heading, so the tile only
  // has to say which variant it is.
  tile.querySelector('.tile-label').textContent = entry ? entry.variantLabel : name;

  const art = tile.querySelector('.tile-img');
  const src = artFor(sprite.id);
  // Art is for recognising the thing you just saw in game, so it stays full
  // colour whatever the status — the fill and the mark already carry that.
  if (src) art.src = src;
  art.hidden = !src;

  const bits = [name, STATUS_LABEL[sprite.status]];
  if (sprite.hunting) bits.push('on hunting list');

  const label = bits.join(', ');
  tile.setAttribute('aria-label', label);
  tile.querySelector('.tile-main').setAttribute('aria-label', `${label}. Change status`);

  const hunt = tile.querySelector('.tile-hunt');
  hunt.setAttribute('aria-pressed', String(sprite.hunting));
  hunt.setAttribute(
    'aria-label',
    sprite.hunting ? `Remove ${name} from hunting list` : `Add ${name} to hunting list`,
  );
}

function updateTile(id) {
  const tile = tileNodes.get(id);
  if (!tile) return;

  paintTile(tile, getSprite(id));
  repaintGroupCount(tile.closest('.group'));

  // If the change pushed it out of the active filter, drop it on the next
  // render rather than yanking it away mid-tap.
  tile.classList.remove('just-changed');
  void tile.offsetWidth; // restart the animation
  tile.classList.add('just-changed');
}

function repaintGroupCount(section) {
  if (!section) return;

  const ids = JSON.parse(section.dataset.all);
  const counts = groupCounts(doc, ids.map((id) => ({ id })));
  const { collected, maxed, total } = counts;

  section.querySelector('.gc-have').textContent = String(collected);
  section.querySelector('.gc-total').textContent = String(total);

  // One value, four rungs — see `groupTier` and the block it drives in the CSS.
  section.dataset.progress = groupTier(counts);

  // A crown appearing, rather than a colour changing, is what says "there is
  // something mastered in here": it reads the same to someone who cannot pull
  // gold apart from green.
  section.querySelector('.gc-crown').hidden = maxed === 0;

  // The counter says more in colour than it does in text, and none of that
  // reaches a screen reader. Spell it out — role="img" on the element means
  // this label is read *instead of* "1 / 6", which would otherwise come out as
  // "1 slash 6" and still be missing the crown.
  section.querySelector('.group-count').setAttribute(
    'aria-label',
    maxed === 0
      ? `${collected} of ${total} collected`
      : `${collected} of ${total} collected, ${maxed} mastered`,
  );
}

function groupSection(group) {
  const section = document.createElement('section');
  section.className = 'group';
  section.dataset.key = group.key;
  section.dataset.all = JSON.stringify(group.all.map((entry) => entry.id));

  const head = document.createElement('div');
  head.className = 'group-head';

  const title = document.createElement('h2');
  title.className = 'group-name';
  title.textContent = group.sprite ? group.sprite.name : 'Your own entries';
  head.append(title);

  if (group.sprite) {
    const rarity = document.createElement('span');
    rarity.className = 'rarity';
    rarity.dataset.rarity = group.sprite.rarity;
    rarity.textContent = RARITY_LABEL[group.sprite.rarity];
    head.append(rarity);
  }

  const count = document.createElement('span');
  count.className = 'group-count';
  count.setAttribute('role', 'img'); // labelled in repaintGroupCount
  // Split into spans because the two halves colour independently. The crown is
  // the tile's own mastery mark, so the heading and the grid cannot drift apart.
  count.innerHTML =
    `<span class="gc-crown" hidden>${MARK.maxed}</span>` +
    '<span class="gc-have"></span> / <span class="gc-total"></span>';
  head.append(count);

  if (group.sprite?.power) {
    const power = document.createElement('p');
    power.className = 'group-power';
    power.textContent = group.sprite.power;
    head.append(power);
  }

  section.append(head);

  const tiles = document.createElement('div');
  tiles.className = 'group-tiles';
  for (const entry of group.entries) tiles.append(tileFor(entry.id));
  section.append(tiles);

  repaintGroupCount(section);
  return section;
}

function renderGrid() {
  const groups = visibleGroups();
  const frag = document.createDocumentFragment();

  tileNodes.clear();
  flatVisible = [];

  for (const group of groups) {
    frag.append(groupSection(group));
    for (const entry of group.entries) flatVisible.push(entry.id);
  }

  grid.replaceChildren(frag);
  $('empty').hidden = flatVisible.length > 0;

  const counts = countsFor(doc);
  const filtered = ui.filter !== 'all' || ui.query.trim() !== '';
  $('resultLine').textContent = filtered
    ? `Showing ${flatVisible.length} of ${counts.total}`
    : '';
}

function renderProgress() {
  const c = countsFor(doc);

  $('progressCount').textContent = `${c.collected} / ${c.total}`;
  $('progressPct').textContent = `${c.percent}%`;
  $('barMaxed').style.width = `${c.total ? (c.maxed / c.total) * 100 : 0}%`;
  $('barOwned').style.width = `${c.total ? (c.owned / c.total) * 100 : 0}%`;
  $('progressBar').setAttribute('aria-valuenow', String(c.percent));

  $('legendMaxed').textContent = String(c.maxed);
  $('legendOwned').textContent = String(c.owned);
  $('legendHunting').textContent = String(c.hunting);
  $('legendNeeded').textContent = String(c.needed);
}

function renderChips() {
  for (const chip of document.querySelectorAll('.chip')) {
    chip.classList.toggle('is-active', chip.dataset.filter === ui.filter);
    chip.setAttribute('aria-pressed', String(chip.dataset.filter === ui.filter));
  }
}

function applyTheme() {
  const resolved =
    ui.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : ui.theme;

  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#2d1f3b');

  for (const btn of document.querySelectorAll('[data-theme-set]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === ui.theme));
  }
}

/**
 * What the coming-back section is currently announcing.
 *
 * Dismissal is remembered against this rather than as a plain flag, so waving
 * away "Ironmouse, 4 August" does not also silence the next sprite Epic pulls,
 * or a return date that moves. Anything that changes what the section would say
 * brings it back; re-reading the same news does not.
 */
function comingSoonKey() {
  return VAULTED_ENTRIES.map((entry) => `${entry.id}:${entry.returns || ''}`).join(',');
}

/**
 * The handful of entries that shipped, got pulled, and are due back.
 *
 * They are worth calling out rather than leaving greyed out somewhere down the
 * grid — knowing Ironmouse lands on the 4th is the kind of thing you check the
 * app for. The section removes itself once the catalog marks them live, so
 * nothing has to be cleaned up by hand afterwards.
 *
 * Once you have read it, it is just a banner above the thing you came for, so
 * it can be waved away — see `comingSoonKey` for how long that lasts. The
 * entries stay in the grid either way; this is the announcement, not the data.
 */
function renderComingSoon() {
  const section = $('comingSoon');
  section.hidden = VAULTED_ENTRIES.length === 0 || ui.soonDismissed === comingSoonKey();
  if (section.hidden) return;

  const frag = document.createDocumentFragment();

  for (const entry of VAULTED_ENTRIES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'soon-item';
    item.dataset.id = entry.id;

    const art = document.createElement('img');
    art.src = artFor(entry.id);
    art.alt = '';
    art.width = 30;
    art.height = 30;
    art.decoding = 'async';
    item.append(art);

    const name = document.createElement('span');
    name.className = 'soon-name';
    name.textContent = entry.name;
    item.append(name);

    const when = document.createElement('span');
    when.className = 'soon-when';
    when.textContent = entry.returns ? formatDate(entry.returns) : 'No date yet';
    item.append(when);

    item.setAttribute(
      'aria-label',
      `${entry.name}, ${entry.returns ? `returns ${formatDate(entry.returns)}` : 'no return date announced'}`,
    );
    frag.append(item);
  }

  $('soonList').replaceChildren(frag);
}

$('soonList').addEventListener('click', (event) => {
  const item = event.target.closest('.soon-item');
  if (item) openDetail(item.dataset.id);
});

$('soonDismiss').addEventListener('click', () => {
  ui.soonDismissed = comingSoonKey();
  saveUi();
  renderComingSoon();
});

function renderAll() {
  document.body.classList.toggle('compact', ui.compact);
  renderChips();
  renderProgress();
  renderComingSoon();
  renderGrid();
}

/* ---------------------------------------------------------------------- */
/* Install                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Installing matters more here than for most web apps: on the home screen it
 * opens full screen and the service worker has already cached the shell, so it
 * works with no signal. That is the situation the whole app is for.
 *
 * Three routes, and only one of them is the standard event:
 *
 *   Chrome / Edge / Android  fire `beforeinstallprompt`, which we hold onto and
 *                            replay when the player asks.
 *   iOS Safari               never fires it. The only route is the Share sheet,
 *                            so the app has to describe it. Skipping this would
 *                            leave iPhone users — the ones most likely to want
 *                            a home screen icon — with nothing at all.
 *   Already installed        say so, and offer nothing.
 */
let installPrompt = null;

function isInstalled() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's own flag, which predates the standard media query.
    navigator.standalone === true
  );
}

function isIos() {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

function renderInstall() {
  const installed = isInstalled();
  const canPrompt = installPrompt !== null;
  const ios = isIos();

  $('installTag').textContent = installed ? 'Installed' : 'Not installed';
  $('installTag').dataset.on = String(installed);
  $('installActions').hidden = installed || !canPrompt;
  $('installSteps').hidden = installed || canPrompt || !ios;

  $('installBlurb').textContent = installed
    ? "You're running the installed copy — it opens full screen and works offline."
    : ios
      ? 'Add it to your home screen and it opens full screen, with no Safari chrome and no signal needed.'
      : 'Installed, it opens in its own window and works with no signal — which is the point, since you will be using it mid-match.';

  if (!installed && !canPrompt && !ios) {
    $('installBlurb').textContent =
      'Your browser offers this from its own menu — look for Install or Add to Home Screen.';
  }

  // The strip is a one-time nudge: only where there is a route to offer, and
  // never again once it has been waved away.
  const dismissed = ui.installDismissed === true;
  const bar = $('installBar');
  bar.hidden = installed || dismissed || (!canPrompt && !ios);

  if (!bar.hidden) {
    $('installBarAction').textContent = ios ? 'How' : 'Install';
    $('installBarText').textContent = ios
      ? 'Add it to your home screen to open it full screen, offline.'
      : 'Keep it a tap away — add it to your home screen.';
  }
}

window.addEventListener('beforeinstallprompt', (event) => {
  // Suppress the browser's own bar so the offer sits where the app controls it.
  event.preventDefault();
  installPrompt = event;
  renderInstall();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  ui.installDismissed = true;
  saveUi();
  renderInstall();
  toast('Installed — open it from your home screen');
});

async function runInstall() {
  if (!installPrompt) return;

  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;

  // The event is single-use whichever way it goes; a dismissal means the
  // browser will offer it again later on its own terms.
  installPrompt = null;
  if (outcome === 'dismissed') toast('No problem — it is in the menu when you want it');
  renderInstall();
}

$('installBtn').addEventListener('click', runInstall);

$('installBarAction').addEventListener('click', () => {
  if (installPrompt) {
    runInstall();
    return;
  }
  // iOS: nothing to prompt, so show the steps.
  openMenu();
  $('installPanel').scrollIntoView({ block: 'start', behavior: 'smooth' });
});

$('installDismiss').addEventListener('click', () => {
  ui.installDismissed = true;
  saveUi();
  renderInstall();
});

/* ---------------------------------------------------------------------- */
/* Toast                                                                    */
/* ---------------------------------------------------------------------- */

let toastTimer = null;

function toast(message, { undo = false } = {}) {
  $('toastText').textContent = message;
  $('toastUndo').hidden = !undo;
  $('toast').hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 4500 : 2600);
}

function hideToast() {
  $('toast').hidden = true;
  clearTimeout(toastTimer);
}

/* ---------------------------------------------------------------------- */
/* Tile interaction                                                         */
/* ---------------------------------------------------------------------- */

const LONG_PRESS_MS = 480;
let pressTimer = null;
let pressId = null;
let longFired = false;
let pressOrigin = null;

function cycleStatus(id) {
  const current = getSprite(id).status;
  const next = STATUSES[(STATUSES.indexOf(current) + 1) % STATUSES.length];
  setStatus(id, next);

  const name = displayName(id);
  const label =
    next === 'maxed'
      ? `${name} → Maxed ♛`
      : next === 'owned'
        ? `${name} → Owned`
        : `${name} → Needed`;
  toast(label, { undo: true });
}

grid.addEventListener('pointerdown', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile || event.target.closest('.tile-hunt')) return;

  pressId = tile.dataset.id;
  longFired = false;
  pressOrigin = { x: event.clientX, y: event.clientY };

  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longFired = true;
    openDetail(pressId);
    if (navigator.vibrate) navigator.vibrate(12);
  }, LONG_PRESS_MS);
});

// A scroll gesture starts as a press; cancel once the finger actually moves.
grid.addEventListener('pointermove', (event) => {
  if (!pressOrigin) return;
  const dx = Math.abs(event.clientX - pressOrigin.x);
  const dy = Math.abs(event.clientY - pressOrigin.y);
  if (dx > 10 || dy > 10) {
    clearTimeout(pressTimer);
    pressOrigin = null;
  }
});

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  grid.addEventListener(type, () => {
    clearTimeout(pressTimer);
    pressOrigin = null;
  });
}

grid.addEventListener('click', (event) => {
  const huntBtn = event.target.closest('.tile-hunt');
  if (huntBtn) {
    const id = huntBtn.dataset.hunt;
    const now = toggleHunting(id);
    const name = displayName(id);
    toast(now ? `Hunting ${name}` : `${name} off the hunting list`, { undo: true });
    return;
  }

  const tile = event.target.closest('.tile');
  if (!tile) return;

  // The long-press already opened the detail sheet; do not also cycle.
  if (longFired) {
    longFired = false;
    return;
  }

  cycleStatus(tile.dataset.id);
});

// Enter and Space already fire click on a real <button>, so only the shortcut
// for the detail sheet needs handling here.
grid.addEventListener('keydown', (event) => {
  if (event.key !== 'i' && event.key !== 'I') return;

  const tile = event.target.closest('.tile');
  if (!tile) return;

  event.preventDefault();
  openDetail(tile.dataset.id);
});

/* ---------------------------------------------------------------------- */
/* Detail sheet                                                             */
/* ---------------------------------------------------------------------- */

const detailDialog = $('detail');

function openDetail(id) {
  detailId = id;
  renderDetail();
  if (!detailDialog.open) detailDialog.showModal();
}

/** Sets a fact row's value, hiding the whole row when there is nothing to say. */
function fact(id, value, label) {
  const dd = $(id);
  const row = dd.closest('.fact');
  row.hidden = !value;
  dd.textContent = value || '';
  if (label) row.querySelector('dt').textContent = label;
}

function renderDetail() {
  const sprite = getSprite(detailId);
  const entry = catalogEntry(detailId);

  $('detailTitle').textContent = displayName(detailId);

  $('detailMeta').hidden = !entry;
  // The name is the game's for a catalog entry, and the player's own for an
  // entry they added, so the field only appears where it can be edited.
  $('detailNameField').hidden = !!entry;
  $('detailDelete').hidden = !isCustomId(detailId);

  if (entry) {
    $('detailArt').src = artFor(detailId);

    const rarity = $('detailRarity');
    rarity.textContent = RARITY_LABEL[entry.rarity];
    rarity.dataset.rarity = entry.rarity;

    const variant = $('detailVariant');
    variant.textContent = entry.variantLabel;
    variant.hidden = entry.variant === 'base';

    const state = $('detailState');
    state.hidden = entry.released;
    state.textContent = entry.state === 'vaulted'
      ? entry.returns
        ? `Vaulted · back ${formatDate(entry.returns)}`
        : 'Vaulted · no return announced'
      : 'Never released';

    $('detailPower').textContent = entry.power;

    fact('factPerk', entry.perk, `${entry.variantLabel} bonus`);
    fact('factScaling', entry.scaling);
    fact('factWhere', entry.where);
    fact('factDrop', entry.released ? formatDrop(entry.drop) : '');
    fact('factDust', `${entry.dust.toLocaleString('en-US')} Sprite Dust`);
  }

  for (const opt of detailDialog.querySelectorAll('.status-opt')) {
    opt.setAttribute('aria-checked', String(opt.dataset.status === sprite.status));
  }

  $('detailHunting').checked = sprite.hunting;
  $('detailName').value = sprite.name;
  $('detailNotes').value = sprite.notes;

  $('detailUpdated').textContent = sprite.updatedAt
    ? `Updated ${relativeTime(sprite.updatedAt)}`
    : 'Never marked';

  const index = flatVisible.indexOf(detailId);
  $('detailPrev').disabled = index <= 0;
  $('detailNext').disabled = index < 0 || index >= flatVisible.length - 1;
}

/** "2026-08-04" -> "4 Aug". Parsed as UTC so it cannot slip a day westward. */
function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function relativeTime(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

detailDialog.addEventListener('click', (event) => {
  const opt = event.target.closest('.status-opt');
  if (!opt) return;
  setStatus(detailId, opt.dataset.status);
  renderDetail();
});

$('detailHunting').addEventListener('change', (event) => {
  writeSprite(detailId, { hunting: event.target.checked });
  updateTile(detailId);
  renderProgress();
  renderDetail();
});

// Text fields commit on blur rather than per keystroke, so a rename is one
// sync push instead of thirty.
for (const [elId, key] of [['detailName', 'name'], ['detailNotes', 'notes']]) {
  $(elId).addEventListener('change', (event) => {
    const value = event.target.value.trim();
    if (value === getSprite(detailId)[key]) return;
    writeSprite(detailId, { [key]: value });
    updateTile(detailId);
    renderDetail();
  });
}

$('detailDelete').addEventListener('click', () => {
  const name = displayName(detailId);
  if (!confirm(`Delete ${name}? It goes from every device you sync with.`)) return;

  // Blanking rather than removing leaves a tombstone that compactDoc keeps, so
  // the deletion actually reaches the other devices instead of bouncing back.
  writeSprite(detailId, { name: '', status: 'needed', hunting: false, notes: '' });
  detailDialog.close();
  renderAll();
  toast(`Deleted ${name}`);
});

// Prev/Next walk what is actually on screen, so stepping through a filtered
// list stays inside that list instead of wandering into hidden entries.
function step(delta) {
  const next = flatVisible[flatVisible.indexOf(detailId) + delta];
  if (next) openDetail(next);
}

$('detailPrev').addEventListener('click', () => step(-1));
$('detailNext').addEventListener('click', () => step(1));

detailDialog.addEventListener('close', () => {
  detailId = null;
  // A status change may have moved the sprite out of the current filter.
  renderGrid();
});

/* ---------------------------------------------------------------------- */
/* Toolbar                                                                  */
/* ---------------------------------------------------------------------- */

$('search').addEventListener('input', (event) => {
  ui.query = event.target.value;
  $('searchClear').hidden = ui.query === '';
  renderGrid();
});

$('searchClear').addEventListener('click', () => {
  ui.query = '';
  $('search').value = '';
  $('searchClear').hidden = true;
  renderGrid();
  $('search').focus();
});

function setFilter(filter) {
  ui.filter = filter;
  saveUi();
  renderChips();
  renderGrid();
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => setFilter(chip.dataset.filter));
}

for (const item of document.querySelectorAll('.legend-item')) {
  item.addEventListener('click', () => {
    setFilter(item.dataset.jump);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

$('toastUndo').addEventListener('click', applyUndo);

// Show the toolbar's separator only once it is actually pinned.
new IntersectionObserver(
  ([entry]) => $('toolbar').classList.toggle('is-stuck', !entry.isIntersecting),
  { threshold: 0 },
).observe($('stickySentinel'));

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }

  if (event.key === '/') {
    event.preventDefault();
    $('search').focus();
  } else if ((event.key === 'z' || event.key === 'Z') && (event.metaKey || event.ctrlKey)) {
    if (undoEntry) {
      event.preventDefault();
      applyUndo();
    }
  }
});

/* ---------------------------------------------------------------------- */
/* Menu                                                                     */
/* ---------------------------------------------------------------------- */

const menuDialog = $('menu');

function openMenu() {
  $('unreleasedToggle').checked = doc.unreleased;
  $('compactToggle').checked = ui.compact;
  renderSyncUi();
  renderInstall();
  applyTheme();
  menuDialog.showModal();
}

$('menuBtn').addEventListener('click', openMenu);

for (const btn of document.querySelectorAll('[data-close-menu]')) {
  btn.addEventListener('click', () => menuDialog.close());
}

// Click on the backdrop (outside the panel) closes either sheet.
for (const dialog of [menuDialog, detailDialog]) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

$('unreleasedToggle').addEventListener('change', (event) => {
  doc.unreleased = event.target.checked;
  doc.unreleasedAt = Date.now();
  saveDoc();
  scheduleSync();
  renderAll();
  toast(doc.unreleased ? 'Showing unreleased entries' : 'Hiding unreleased entries');
});

$('compactToggle').addEventListener('change', (event) => {
  ui.compact = event.target.checked;
  saveUi();
  document.body.classList.toggle('compact', ui.compact);
});

for (const btn of document.querySelectorAll('[data-theme-set]')) {
  btn.addEventListener('click', () => {
    ui.theme = btn.dataset.themeSet;
    saveUi();
    applyTheme();
  });
}

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (ui.theme === 'system') applyTheme();
});

/* ---------------------------------------------------------------------- */
/* Your own entries                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Epic ships sprites faster than this app can be redeployed, so there has to
 * be a way to track one the same day it lands. A custom entry behaves exactly
 * like a catalog entry — it counts, syncs and filters — it just carries a name
 * you typed instead of one from the game files.
 */
$('addCustom').addEventListener('click', () => {
  const name = $('customName').value.trim().slice(0, 60);
  if (!name) {
    toast('Give it a name first');
    $('customName').focus();
    return;
  }

  const id = nextCustomId(doc);
  writeSprite(id, { name });
  $('customName').value = '';

  renderAll();
  toast(`Added ${name}`);
});

$('customName').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('addCustom').click();
  }
});

/* ---------------------------------------------------------------------- */
/* Import / export                                                          */
/* ---------------------------------------------------------------------- */

$('exportBtn').addEventListener('click', () => {
  const payload = { app: 'forknife-67', version: APP_VERSION, exportedAt: Date.now(), ...compactDoc(doc) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);

  const link = document.createElement('a');
  link.href = url;
  link.download = `forknife67-sprites-${stamp}.json`;
  link.click();

  URL.revokeObjectURL(url);
  toast('Backup downloaded');
});

$('importBtn').addEventListener('click', () => $('importInput').click());

$('importInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const incoming = normalizeDoc(JSON.parse(await file.text()));
    doc = mergeDocs(doc, incoming);
    saveDoc();
    scheduleSync();
    renderAll();
    toast('Backup merged in');
  } catch (err) {
    console.error('[forknife] import failed:', err);
    toast("That file isn't a forknife backup");
  }
});

/* ---------------------------------------------------------------------- */
/* Danger zone                                                              */
/* ---------------------------------------------------------------------- */

$('resetStatuses').addEventListener('click', () => {
  if (!confirm('Set every sprite back to Needed? Names and notes are kept.')) return;

  const now = Date.now();
  for (const sprite of Object.values(doc.sprites)) {
    doc.sprites[sprite.id] = { ...sprite, status: 'needed', hunting: false, updatedAt: now };
  }

  saveDoc();
  scheduleSync();
  renderAll();
  toast('All statuses reset');
});

$('resetAll').addEventListener('click', () => {
  if (!confirm('Erase every sprite, name and note on this device? This cannot be undone.')) return;

  doc = emptyDoc();
  doc.unreleasedAt = Date.now();
  saveDoc();
  renderAll();
  toast('Everything erased');
});

/* ---------------------------------------------------------------------- */
/* Cloud sync                                                               */
/* ---------------------------------------------------------------------- */

let syncTimer = null;

/**
 * Syncs run one at a time, chained. Dropping a sync because another was in
 * flight meant a "Sync now" tap could do nothing at all, and left the caller
 * unable to tell whether their own edits had reached the server yet.
 *
 * Chaining instead means the returned promise always covers a run that started
 * after the caller's edits.
 */
let syncChain = Promise.resolve();

function setSyncState(state, message) {
  $('syncBtn').dataset.state = state;
  $('syncBtn').title = message;
  $('syncStatus').textContent = message;

  const tag = $('syncTag');
  tag.textContent = state === 'off' ? 'Off' : state === 'error' ? 'Error' : state === 'busy' ? 'Syncing' : 'On';
  tag.dataset.on = String(state === 'on');
}

function renderSyncUi() {
  $('codeInput').value = ui.syncCode ? formatCode(ui.syncCode) : '';

  if (!ui.syncCode) {
    setSyncState('off', 'Not connected. Your data is saved on this device only.');
  } else if (ui.lastSync) {
    setSyncState('on', `Synced ${relativeTime(ui.lastSync)}.`);
  } else {
    setSyncState('on', 'Connected. Not synced yet.');
  }
}

function scheduleSync() {
  if (!ui.syncCode) return;
  clearTimeout(syncTimer);
  // Batch a burst of taps into one request; the player is often marking
  // several sprites in a row after a match.
  syncTimer = setTimeout(() => syncNow({ quiet: true }), 2500);
}

function syncNow(options = {}) {
  // Never let one failed run break the chain for the next caller.
  syncChain = syncChain.then(() => runSync(options), () => runSync(options));
  return syncChain;
}

async function runSync({ quiet = false } = {}) {
  if (!ui.syncCode) {
    if (!quiet) toast('Connect a vault code first');
    return;
  }

  if (!navigator.onLine) {
    setSyncState('error', 'Offline — will sync when you reconnect.');
    return;
  }

  setSyncState('busy', 'Syncing…');

  try {
    const response = await fetch(`/api/vault/${ui.syncCode}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(compactDoc(doc)),
    });

    if (!response.ok) throw new Error(`server said ${response.status}`);

    // The server returns the merged truth; adopt it so the other device's
    // edits land here without a second round trip.
    doc = mergeDocs(normalizeDoc(await response.json()), doc);
    ui.lastSync = Date.now();

    saveDoc();
    saveUi();
    renderAll();
    if (detailId !== null) renderDetail();

    setSyncState('on', `Synced ${relativeTime(ui.lastSync)}.`);
    if (!quiet) toast('Synced');
  } catch (err) {
    console.error('[forknife] sync failed:', err);
    setSyncState('error', 'Sync failed — your data is still safe on this device.');
    if (!quiet) toast('Sync failed');
  }
}

$('syncNow').addEventListener('click', () => syncNow());

$('syncBtn').addEventListener('click', () => {
  if (!ui.syncCode) {
    openMenu();
    $('codeInput').focus();
  } else {
    syncNow();
  }
});

$('codeCreate').addEventListener('click', async () => {
  if (ui.syncCode && !confirm('Replace your current vault code? Make sure you have it written down.')) {
    return;
  }

  ui.syncCode = generateCode((n) => crypto.getRandomValues(new Uint8Array(n)));
  ui.lastSync = 0;
  saveUi();
  renderSyncUi();

  await syncNow();
  toast('Vault created — save the code somewhere safe');
});

$('codeConnect').addEventListener('click', async () => {
  const code = normalizeCode($('codeInput').value);

  if (!isValidCode(code)) {
    toast('That code does not look right (16 characters)');
    return;
  }

  ui.syncCode = code;
  ui.lastSync = 0;
  saveUi();
  renderSyncUi();

  // Pull first so this device adopts the vault before pushing anything into it.
  try {
    const response = await fetch(`/api/vault/${code}`);
    if (response.ok) {
      doc = mergeDocs(normalizeDoc(await response.json()), doc);
      saveDoc();
      renderAll();
    }
  } catch (err) {
    console.warn('[forknife] initial pull failed:', err);
  }

  await syncNow();
});

$('codeDisconnect').addEventListener('click', () => {
  if (!ui.syncCode) return;
  if (!confirm('Stop syncing this device? Your sprites stay here, and the vault stays on the server.')) {
    return;
  }

  ui.syncCode = '';
  ui.lastSync = 0;
  saveUi();
  renderSyncUi();
  toast('Sync disconnected');
});

window.addEventListener('online', () => {
  if (ui.syncCode) syncNow({ quiet: true });
});

window.addEventListener('offline', () => {
  if (ui.syncCode) setSyncState('error', 'Offline — will sync when you reconnect.');
});

// Catch the case where the app was backgrounded mid-edit on another device.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.syncCode) syncNow({ quiet: true });
});

/* ---------------------------------------------------------------------- */
/* Boot                                                                     */
/* ---------------------------------------------------------------------- */

loadLocal();
applyTheme();

$('search').value = ui.query || '';
$('searchClear').hidden = !ui.query;
$('version').textContent = `forknife 67 · v${APP_VERSION} · catalog ${CATALOG_PATCH}`;
$('catalogSize').textContent = String(RELEASED_ENTRIES.length);
$('catalogUnreleased').textContent = String(ALL_ENTRIES.length - RELEASED_ENTRIES.length);
$('catalogVaulted').textContent = String(ALL_ENTRIES.filter((e) => e.state === 'vaulted').length);
$('catalogDatamined').textContent = String(ALL_ENTRIES.filter((e) => e.state === 'datamined').length);
$('catalogPatch').textContent = CATALOG_PATCH;

renderAll();
renderSyncUi();
renderInstall();

if (ui.syncCode) syncNow({ quiet: true });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[forknife] offline mode unavailable:', err);
    });
  });
}

// Exposed for the browser-driven smoke test in test/.
window.__forknife = {
  getDoc: () => doc,
  getCounts: () => countsFor(doc),
  getVisible: () => [...flatVisible],
  isBlankSprite,
  // Resolves only once a sync that began after this call has finished, which
  // is the only reliable "my edits are on the server" signal for a test.
  sync: () => syncNow({ quiet: true }),
  lastSync: () => ui.lastSync,
};
