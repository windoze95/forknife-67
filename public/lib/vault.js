/**
 * Shared vault model + merge logic.
 *
 * This module is imported by BOTH the browser app (as a static ES module) and
 * the Node server, so the two can never drift out of sync. Keep it dependency
 * free and side-effect free.
 */

export const SCHEMA_VERSION = 1;

/** Sprites currently findable in game. Bump via settings when Epic adds more. */
export const DEFAULT_TOTAL = 111;

/** Hard ceiling so a malicious/garbled payload cannot balloon storage. */
export const MAX_TOTAL = 2000;

export const MAX_NAME_LEN = 60;
export const MAX_NOTES_LEN = 500;

/**
 * Status order is also the tap-cycle order in the UI:
 *   needed -> owned -> maxed -> needed
 *
 * needed = not in my inventory yet (this is what I'm hunting)
 * owned  = I have it, but not extracted at max level (no crown in game)
 * maxed  = I have it at max level, so in game it wears a crown
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

export function clampTotal(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_TOTAL;
  return Math.min(MAX_TOTAL, Math.max(1, n));
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

export function emptyDoc(total = DEFAULT_TOTAL) {
  return {
    schema: SCHEMA_VERSION,
    total: clampTotal(total),
    totalUpdatedAt: 0,
    sprites: {},
  };
}

/**
 * A sprite record is only stored once the player has touched it. Untouched
 * slots are implicit "needed" and cost nothing, which keeps the sync payload
 * tiny on a fresh account.
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

  const id = Math.floor(Number(raw.id ?? fallbackId));
  if (!Number.isFinite(id) || id < 1 || id > MAX_TOTAL) return null;

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

/**
 * Coerce arbitrary parsed JSON (a file import, a request body, an old
 * localStorage blob) into a valid document. Never throws.
 */
export function normalizeDoc(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== 'object') return doc;

  if (raw.total !== undefined) doc.total = clampTotal(raw.total);
  doc.totalUpdatedAt = clampTimestamp(raw.totalUpdatedAt);

  const source = raw.sprites;
  if (Array.isArray(source)) {
    for (let i = 0; i < source.length; i += 1) {
      const sprite = normalizeSprite(source[i], i + 1);
      if (sprite) doc.sprites[sprite.id] = sprite;
    }
  } else if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      const sprite = normalizeSprite(value, key);
      if (sprite) doc.sprites[sprite.id] = sprite;
    }
  }

  return doc;
}

/**
 * Merge two documents with per-sprite last-write-wins.
 *
 * Merging per sprite rather than per document is what makes two devices safe:
 * marking #14 owned on a phone and #92 maxed on a PC keeps both edits, whereas
 * whole-document LWW would silently drop one of them.
 *
 * Ties resolve to `a`, so callers should pass the local document as `a` to keep
 * the device's own most recent intent.
 */
export function mergeDocs(a, b) {
  const left = normalizeDoc(a);
  const right = normalizeDoc(b);
  const merged = emptyDoc(left.total);

  if (right.totalUpdatedAt > left.totalUpdatedAt) {
    merged.total = right.total;
    merged.totalUpdatedAt = right.totalUpdatedAt;
  } else {
    merged.total = left.total;
    merged.totalUpdatedAt = left.totalUpdatedAt;
  }

  const ids = new Set([
    ...Object.keys(left.sprites),
    ...Object.keys(right.sprites),
  ]);

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

/** Drop untouched records so exports and sync payloads stay small. */
export function compactDoc(doc) {
  const out = emptyDoc(doc.total);
  out.totalUpdatedAt = doc.totalUpdatedAt;
  for (const sprite of Object.values(doc.sprites)) {
    if (!isBlankSprite(sprite)) out.sprites[sprite.id] = sprite;
  }
  return out;
}

export function countsFor(doc) {
  const total = doc.total;
  let owned = 0;
  let maxed = 0;
  let hunting = 0;

  for (const sprite of Object.values(doc.sprites)) {
    if (sprite.id > total) continue;
    if (sprite.status === 'owned') owned += 1;
    else if (sprite.status === 'maxed') maxed += 1;
    if (sprite.hunting && sprite.status === 'needed') hunting += 1;
  }

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
