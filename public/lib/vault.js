/**
 * Shared vault model + merge logic.
 *
 * This module is imported by BOTH the browser app (as a static ES module) and
 * the Node server, so the two can never drift out of sync. Keep it dependency
 * free and side-effect free.
 */

import {
  CUSTOM_PREFIX,
  ENTRY_BY_ID,
  entriesFor,
  idForName,
  isCustomId,
} from './catalog.js';

/**
 * v1 tracked 111 numbered slots that the player named by hand. v2 tracks the
 * real catalog, keyed by entry id. See `migrateEntry` for how the old data is
 * carried across.
 */
export const SCHEMA_VERSION = 2;

/** Hard ceiling so a malicious/garbled payload cannot balloon storage. */
export const MAX_ENTRIES = 2000;

export const MAX_NAME_LEN = 60;
export const MAX_NOTES_LEN = 500;

/**
 * Entry ids are `water`, `water.gold`, or `custom.7`.
 *
 * This validates the SHAPE, not membership of the catalog. An id from a newer
 * catalog than this build knows about is stored and synced untouched rather
 * than dropped, so a phone that has not picked up the latest deploy cannot
 * quietly delete progress made on a device that has.
 */
const ID_RE = /^[a-z0-9]{1,32}(\.[a-z0-9]{1,24})?$/;

export function isValidEntryId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Status order is also the tap-cycle order in the UI:
 *   needed -> owned -> maxed -> needed
 *
 * needed = not in my collection yet (this is what I'm hunting)
 * owned  = extracted, but not at max level (no crown in game)
 * maxed  = mastered, so in game it wears a crown
 */
export const STATUSES = ['needed', 'owned', 'maxed'];

export const STATUS_LABEL = {
  needed: 'Needed',
  owned: 'Owned',
  maxed: 'Maxed',
};

export function isStatus(value) {
  return STATUSES.includes(value);
}

function clampString(value, max) {
  if (typeof value !== 'string') return '';
  // Strip control characters; they only ever arrive from a corrupted import.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function clampTimestamp(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  // Anything past year 3000 is a bad clock or a hostile payload; treat as now.
  return n > 32503680000000 ? 0 : n;
}

export function emptyDoc() {
  return {
    schema: SCHEMA_VERSION,
    unreleased: false,
    unreleasedAt: 0,
    sprites: {},
  };
}

/**
 * A record is only stored once the player has touched it. Untouched entries
 * are implicit "needed" and cost nothing, which keeps the sync payload tiny on
 * a fresh account.
 */
export function makeSprite(id, now = Date.now()) {
  return {
    id,
    name: '',
    status: 'needed',
    hunting: false,
    notes: '',
    updatedAt: now,
  };
}

export function normalizeSprite(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;

  const id = raw.id ?? fallbackId;
  if (!isValidEntryId(id)) return null;

  return {
    id,
    name: clampString(raw.name, MAX_NAME_LEN),
    status: isStatus(raw.status) ? raw.status : 'needed',
    hunting: raw.hunting === true,
    notes: clampString(raw.notes, MAX_NOTES_LEN),
    updatedAt: clampTimestamp(raw.updatedAt),
  };
}

/** True when a record carries no information worth storing or syncing. */
export function isBlankSprite(sprite) {
  return (
    sprite.status === 'needed' &&
    !sprite.hunting &&
    sprite.name === '' &&
    sprite.notes === ''
  );
}

/* ---------------------------------------------------------------------- */
/* v1 migration                                                           */
/* ---------------------------------------------------------------------- */

/** A v1 id was the slot number: 1..2000. */
function isLegacyId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n >= 1 && n <= MAX_ENTRIES;
}

/**
 * Carries one numbered v1 slot onto a v2 id.
 *
 * If the player typed a name the catalog recognises, the record lands on that
 * catalog entry — someone who had filled in "Gold Water Sprite" keeps that tick
 * rather than starting over. Anything else becomes a custom entry, so a list
 * of private shorthand ("the little blue one") survives the upgrade instead of
 * being thrown away for not matching.
 */
function migrateEntry(raw, fallbackId) {
  const slot = Math.floor(Number(raw.id ?? fallbackId));
  const name = clampString(raw.name, MAX_NAME_LEN);

  const matched = idForName(name);
  if (matched) return { id: matched, name: '' };

  // An unnamed slot the player still marked: under v1 the number WAS the
  // identity, so it becomes the label rather than an unreadable blank row.
  return { id: `${CUSTOM_PREFIX}.${slot}`, name: name || `Slot ${slot}` };
}

/* ---------------------------------------------------------------------- */
/* Document normalisation                                                 */
/* ---------------------------------------------------------------------- */

function putSprite(doc, sprite) {
  const existing = doc.sprites[sprite.id];
  // Two v1 slots can carry the same name and so migrate onto one entry; the
  // more recent edit is the one the player meant.
  if (existing && existing.updatedAt > sprite.updatedAt) return;
  doc.sprites[sprite.id] = sprite;
}

/**
 * Coerce arbitrary parsed JSON (a file import, a request body, an old
 * localStorage blob) into a valid document. Never throws.
 */
export function normalizeDoc(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== 'object') return doc;

  doc.unreleased = raw.unreleased === true;
  doc.unreleasedAt = clampTimestamp(raw.unreleasedAt);

  const source = raw.sprites;
  const entries = Array.isArray(source)
    ? source.map((value, i) => [i + 1, value])
    : source && typeof source === 'object'
      ? Object.entries(source)
      : [];

  let count = 0;

  for (const [key, value] of entries) {
    if (count >= MAX_ENTRIES) break;
    if (!value || typeof value !== 'object') continue;

    const rawId = value.id ?? key;

    if (isLegacyId(rawId)) {
      // An untouched v1 slot carried no information, and turning all 111 of
      // them into custom entries would bury the catalog under empty rows.
      // The numeric id would fail id validation, so probe under a stand-in.
      const probe = normalizeSprite({ ...value, id: 'probe' }, 'probe');
      if (!probe || isBlankSprite(probe)) continue;

      const { id, name } = migrateEntry(value, key);
      const sprite = normalizeSprite({ ...value, id, name }, id);
      if (sprite) {
        putSprite(doc, sprite);
        count += 1;
      }
      continue;
    }

    const sprite = normalizeSprite(value, key);
    if (sprite) {
      putSprite(doc, sprite);
      count += 1;
    }
  }

  return doc;
}

/**
 * Merge two documents with per-entry last-write-wins.
 *
 * Merging per entry rather than per document is what makes two devices safe:
 * marking Gold Water owned on a phone and Grim maxed on a PC keeps both edits,
 * whereas whole-document LWW would silently drop one of them.
 *
 * Ties resolve to `a`, so callers should pass the local document as `a` to keep
 * the device's own most recent intent.
 */
export function mergeDocs(a, b) {
  const left = normalizeDoc(a);
  const right = normalizeDoc(b);
  const merged = emptyDoc();

  if (right.unreleasedAt > left.unreleasedAt) {
    merged.unreleased = right.unreleased;
    merged.unreleasedAt = right.unreleasedAt;
  } else {
    merged.unreleased = left.unreleased;
    merged.unreleasedAt = left.unreleasedAt;
  }

  const ids = new Set([...Object.keys(left.sprites), ...Object.keys(right.sprites)]);

  for (const id of ids) {
    const l = left.sprites[id];
    const r = right.sprites[id];
    if (!l) {
      merged.sprites[id] = r;
    } else if (!r) {
      merged.sprites[id] = l;
    } else {
      merged.sprites[id] = r.updatedAt > l.updatedAt ? r : l;
    }
  }

  return merged;
}

/**
 * Drop untouched records so exports and sync payloads stay small.
 *
 * Custom entries are the exception: a blank one is a DELETION, not an untouched
 * slot, and it has to survive into the payload. Strip it and the server would
 * still be holding the old copy, which the next merge would hand straight back
 * — the entry you just deleted reappears on every device.
 */
export function compactDoc(doc) {
  const out = emptyDoc();
  out.unreleased = doc.unreleased;
  out.unreleasedAt = doc.unreleasedAt;
  for (const sprite of Object.values(doc.sprites)) {
    if (!isBlankSprite(sprite) || isCustomId(sprite.id)) out.sprites[sprite.id] = sprite;
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Counting                                                               */
/* ---------------------------------------------------------------------- */

function customIndex(id) {
  const n = Number(id.slice(CUSTOM_PREFIX.length + 1));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Custom entries the player added, in the order they were added. Blank ones
 * are deletion tombstones (see `compactDoc`) and are not entries any more.
 */
export function customIds(doc) {
  return Object.keys(doc.sprites)
    .filter((id) => isCustomId(id) && !isBlankSprite(doc.sprites[id]))
    .sort((a, b) => customIndex(a) - customIndex(b));
}

/**
 * Counts tombstones too. Reusing a deleted entry's id would resurrect its
 * tombstone on the next merge and delete the new entry instead.
 */
export function nextCustomId(doc) {
  const highest = Object.keys(doc.sprites)
    .filter(isCustomId)
    .reduce((max, id) => Math.max(max, customIndex(id)), 0);
  return `${CUSTOM_PREFIX}.${highest + 1}`;
}

/**
 * Every id this device is currently tracking: the catalog entries in scope,
 * plus the player's own additions.
 *
 * Ids that are neither — an entry from a catalog newer than this build — are
 * deliberately left out. They are still stored and synced; they just are not
 * counted, because a total that moves without any visible rows is worse than a
 * total that is briefly a few short.
 */
export function activeIds(doc) {
  return [...entriesFor(doc.unreleased).map((entry) => entry.id), ...customIds(doc)];
}

export function countsFor(doc) {
  const ids = activeIds(doc);
  const scope = new Set(ids);

  let owned = 0;
  let maxed = 0;
  let hunting = 0;

  for (const sprite of Object.values(doc.sprites)) {
    if (!scope.has(sprite.id)) continue;
    if (sprite.status === 'owned') owned += 1;
    else if (sprite.status === 'maxed') maxed += 1;
    if (sprite.hunting && sprite.status === 'needed') hunting += 1;
  }

  const total = ids.length;
  const collected = owned + maxed;

  return {
    total,
    owned,
    maxed,
    collected,
    needed: total - collected,
    hunting,
    percent: total > 0 ? Math.round((collected / total) * 100) : 0,
  };
}

/**
 * Progress for one base sprite's group heading, e.g. "2 / 6".
 *
 * `maxed` is tracked separately from `collected` because the heading shows the
 * two differently: mastering even one of a sprite's variants is worth seeing
 * from the top of the group.
 */
export function groupCounts(doc, entries) {
  let collected = 0;
  let maxed = 0;

  for (const entry of entries) {
    const status = doc.sprites[entry.id]?.status;
    if (status === 'maxed') maxed += 1;
    if (status === 'owned' || status === 'maxed') collected += 1;
  }

  return { collected, maxed, total: entries.length };
}

/**
 * How far into a sprite you are, as one rung on a ladder:
 *
 *   none      nothing collected yet
 *   partial   some of the variants
 *   complete  every variant, none of them mastered — or only some
 *   mastered  every variant, all of them mastered
 *
 * Each rung is strictly better than the one below it, so the heading built on
 * this can only ever move forwards as a sprite fills in. That is the whole
 * reason it is one value and not a set of independent flags: two flags produce
 * combinations that have to be ranked *somewhere*, and doing it in CSS means
 * ranking them by source order, silently.
 *
 * Mastering SOME variants is deliberately not a rung. It is not progress
 * towards holding the set — you can master your only one of seven — so it is
 * shown as a separate mark rather than folded in here.
 */
export function groupTier({ collected, maxed, total }) {
  if (total <= 0 || collected <= 0) return 'none';
  if (collected < total) return 'partial';
  return maxed === total ? 'mastered' : 'complete';
}

/** Catalog metadata for an id, or null for custom and unknown entries. */
export function catalogEntry(id) {
  return ENTRY_BY_ID.get(id) || null;
}

/* ---------------------------------------------------------------------- */
/* Vault codes                                                            */
/* ---------------------------------------------------------------------- */

/** Crockford-ish base32: no I, L, O, U — unambiguous when read off a screen. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 16;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function isValidCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

/** Accepts user-typed codes with dashes/spaces and common lookalike glyphs. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/I|L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

/** Grouped for display only — never send the pretty form to the server. */
export function formatCode(code) {
  return (code.match(/.{1,4}/g) || []).join('-');
}

export function generateCode(randomBytes) {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}
