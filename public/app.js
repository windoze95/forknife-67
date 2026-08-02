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
  DEFAULT_TOTAL,
  MAX_TOTAL,
  makeSprite,
  normalizeDoc,
  mergeDocs,
  compactDoc,
  emptyDoc,
  countsFor,
  isBlankSprite,
  generateCode,
  normalizeCode,
  formatCode,
  isValidCode,
} from './lib/vault.js';

const APP_VERSION = '1.0.0';
const DOC_KEY = 'forknife67.doc.v1';
const UI_KEY = 'forknife67.ui.v1';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------- */
/* State                                                                    */
/* ---------------------------------------------------------------------- */

let doc = emptyDoc(DEFAULT_TOTAL);

let ui = {
  filter: 'all',
  query: '',
  compact: false,
  theme: 'light',
  syncCode: '',
  lastSync: 0,
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

function visibleIds() {
  const query = ui.query.trim().toLowerCase();
  const out = [];

  for (let id = 1; id <= doc.total; id += 1) {
    const sprite = getSprite(id);

    if (ui.filter === 'hunting') {
      if (!sprite.hunting) continue;
    } else if (ui.filter !== 'all' && sprite.status !== ui.filter) {
      continue;
    }

    if (query) {
      const name = sprite.name.toLowerCase();
      const notes = sprite.notes.toLowerCase();
      const num = String(id);
      if (!num.startsWith(query) && !name.includes(query) && !notes.includes(query)) {
        continue;
      }
    }

    out.push(id);
  }

  return out;
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                                */
/* ---------------------------------------------------------------------- */

const grid = $('grid');
const tileNodes = new Map();

/**
 * A tile is a group wrapping two real buttons rather than one clickable div.
 * Nesting the hunt button inside a role="button" element would leave it
 * unreachable to a screen reader, and a div needs hand-rolled Enter/Space
 * handling that a <button> gets for free.
 */
function tileFor(id) {
  const sprite = getSprite(id);

  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = String(id);
  tile.setAttribute('role', 'group');

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'tile-main';

  const mark = document.createElement('span');
  mark.className = 'tile-mark';
  main.append(mark);

  const num = document.createElement('span');
  num.className = 'tile-num';
  num.textContent = String(id);
  main.append(num);

  const name = document.createElement('span');
  name.className = 'tile-name';
  main.append(name);

  tile.append(main);

  const hunt = document.createElement('button');
  hunt.type = 'button';
  hunt.className = 'tile-hunt';
  hunt.dataset.hunt = String(id);
  hunt.innerHTML = '<svg aria-hidden="true"><use href="#i-target"/></svg>';
  tile.append(hunt);

  tileNodes.set(id, tile);
  paintTile(tile, sprite);
  return tile;
}

const MARK = { needed: '', owned: '✓', maxed: '♛' };

function paintTile(tile, sprite) {
  tile.dataset.status = sprite.status;
  tile.dataset.hunting = String(sprite.hunting);
  tile.querySelector('.tile-mark').textContent = MARK[sprite.status];
  tile.querySelector('.tile-name').textContent = sprite.name;

  const bits = [`Sprite ${sprite.id}`];
  if (sprite.name) bits.push(sprite.name);
  bits.push(STATUS_LABEL[sprite.status]);
  if (sprite.hunting) bits.push('on hunting list');

  const label = bits.join(', ');
  tile.setAttribute('aria-label', label);
  tile.querySelector('.tile-main').setAttribute('aria-label', `${label}. Change status`);

  const hunt = tile.querySelector('.tile-hunt');
  hunt.setAttribute('aria-pressed', String(sprite.hunting));
  hunt.setAttribute(
    'aria-label',
    sprite.hunting ? `Remove sprite ${sprite.id} from hunting list` : `Add sprite ${sprite.id} to hunting list`,
  );
}

function updateTile(id) {
  const tile = tileNodes.get(id);
  if (!tile) return;

  paintTile(tile, getSprite(id));

  // If the change pushed it out of the active filter, drop it on the next
  // render rather than yanking it away mid-tap.
  tile.classList.remove('just-changed');
  void tile.offsetWidth; // restart the animation
  tile.classList.add('just-changed');
}

function renderGrid() {
  const ids = visibleIds();
  const frag = document.createDocumentFragment();

  tileNodes.clear();
  for (const id of ids) frag.append(tileFor(id));

  grid.replaceChildren(frag);
  $('empty').hidden = ids.length > 0;

  const counts = countsFor(doc);
  const filtered = ui.filter !== 'all' || ui.query.trim() !== '';
  $('resultLine').textContent = filtered
    ? `Showing ${ids.length} of ${counts.total}`
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

function renderAll() {
  document.body.classList.toggle('compact', ui.compact);
  renderChips();
  renderProgress();
  renderGrid();
}

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

  const label =
    next === 'maxed'
      ? `Sprite ${id} → Maxed ♛`
      : next === 'owned'
        ? `Sprite ${id} → Owned`
        : `Sprite ${id} → Needed`;
  toast(label, { undo: true });
}

grid.addEventListener('pointerdown', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile || event.target.closest('.tile-hunt')) return;

  pressId = Number(tile.dataset.id);
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
    const id = Number(huntBtn.dataset.hunt);
    const now = toggleHunting(id);
    toast(now ? `Sprite ${id} added to hunting list` : `Sprite ${id} off the hunting list`, {
      undo: true,
    });
    return;
  }

  const tile = event.target.closest('.tile');
  if (!tile) return;

  // The long-press already opened the detail sheet; do not also cycle.
  if (longFired) {
    longFired = false;
    return;
  }

  cycleStatus(Number(tile.dataset.id));
});

// Enter and Space already fire click on a real <button>, so only the shortcut
// for the detail sheet needs handling here.
grid.addEventListener('keydown', (event) => {
  if (event.key !== 'i' && event.key !== 'I') return;

  const tile = event.target.closest('.tile');
  if (!tile) return;

  event.preventDefault();
  openDetail(Number(tile.dataset.id));
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

function renderDetail() {
  const sprite = getSprite(detailId);

  $('detailTitle').textContent = sprite.name
    ? `#${sprite.id} · ${sprite.name}`
    : `Sprite #${sprite.id}`;

  for (const opt of detailDialog.querySelectorAll('.status-opt')) {
    opt.setAttribute('aria-checked', String(opt.dataset.status === sprite.status));
  }

  $('detailHunting').checked = sprite.hunting;
  $('detailName').value = sprite.name;
  $('detailNotes').value = sprite.notes;

  $('detailUpdated').textContent = sprite.updatedAt
    ? `Updated ${relativeTime(sprite.updatedAt)}`
    : 'Never marked';

  $('detailPrev').disabled = detailId <= 1;
  $('detailNext').disabled = detailId >= doc.total;
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

$('detailPrev').addEventListener('click', () => {
  if (detailId > 1) openDetail(detailId - 1);
});

$('detailNext').addEventListener('click', () => {
  if (detailId < doc.total) openDetail(detailId + 1);
});

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

$('menuBtn').addEventListener('click', () => {
  $('totalInput').value = String(doc.total);
  $('compactToggle').checked = ui.compact;
  renderSyncUi();
  applyTheme();
  menuDialog.showModal();
});

for (const btn of document.querySelectorAll('[data-close-menu]')) {
  btn.addEventListener('click', () => menuDialog.close());
}

// Click on the backdrop (outside the panel) closes either sheet.
for (const dialog of [menuDialog, detailDialog]) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

$('totalInput').addEventListener('change', (event) => {
  const next = Math.min(MAX_TOTAL, Math.max(1, Math.floor(Number(event.target.value) || DEFAULT_TOTAL)));
  event.target.value = String(next);
  if (next === doc.total) return;

  doc.total = next;
  doc.totalUpdatedAt = Date.now();
  saveDoc();
  scheduleSync();
  renderAll();
  toast(`Now tracking ${next} sprites`);
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
/* Bulk names                                                               */
/* ---------------------------------------------------------------------- */

$('bulkLoad').addEventListener('click', () => {
  const lines = [];
  for (let id = 1; id <= doc.total; id += 1) lines.push(getSprite(id).name);
  $('bulkNames').value = lines.join('\n');
});

$('bulkApply').addEventListener('click', () => {
  const lines = $('bulkNames').value.split('\n');
  const now = Date.now();
  let changed = 0;

  for (let i = 0; i < lines.length && i < doc.total; i += 1) {
    const name = lines[i].trim().slice(0, 60);
    const current = getSprite(i + 1);
    if (name === current.name) continue;
    doc.sprites[i + 1] = { ...current, name, updatedAt: now };
    changed += 1;
  }

  if (!changed) {
    toast('No names changed');
    return;
  }

  saveDoc();
  scheduleSync();
  renderAll();
  toast(`Named ${changed} sprite${changed === 1 ? '' : 's'}`);
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

  doc = emptyDoc(doc.total);
  doc.totalUpdatedAt = Date.now();
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
    $('totalInput').value = String(doc.total);
    $('compactToggle').checked = ui.compact;
    renderSyncUi();
    applyTheme();
    menuDialog.showModal();
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
$('version').textContent = `forknife 67 · v${APP_VERSION}`;

renderAll();
renderSyncUi();

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
  isBlankSprite,
  // Resolves only once a sync that began after this call has finished, which
  // is the only reliable "my edits are on the server" signal for a test.
  sync: () => syncNow({ quiet: true }),
  lastSync: () => ui.lastSync,
};
