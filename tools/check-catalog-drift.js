/**
 * Read-only catalog watchdog. Exit 0 = checked, 1 = needs review, 2 = unable
 * to check. --json changes the format, never the exit status.
 * Checks the live game build independently of the current-season roster.
 * Rejects empty/partial sources and requires verification every 14 days to
 * bound the blind spot when a same-patch hotfix and community updates lag.
 * No downloaded code is executed; the shipped catalog is never edited.
 */
import { pathToFileURL } from 'node:url';
import { parseRosterIndex, parseVariantTable, parseBuild } from './catalog-sources.js';
import { ALL_ENTRIES, SPRITES, VARIANTS, SEASONS, CURRENT_SEASON, CATALOG_PATCH, CATALOG_VERIFIED, idForName } from '../public/lib/catalog.js';

export const MAX_VERIFICATION_AGE_DAYS = 14;
export const SOURCES = [
  { name: 'Fortnite-API live build', type: 'build', url: 'https://fortnite-api.com/v2/aes' },
  { name: 'Sprite Checklist current roster', type: 'roster', url: 'https://spritechecklist.org/sprites/' },
];

/**
 * Block tags become newlines, not spaces. Flattening the whole page to one
 * line lets a heading run into the next table cell, and "Mastered" + "Gold Air"
 * in adjacent cells reads as a sprite called "Mastered Gold Air".
 */
export function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|br|section|article|table|ul|ol|a)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

/**
 * Ordinary words that sit in front of "Sprite" in prose — "Find Sprites",
 * "Master Sprites", "Best Sprite". A candidate made entirely of these is a
 * sentence, not a name.
 */
const STOPWORDS = new Set(
  `a an and any all also about above are as at be been below best both but by can collect
   could each either even every extract few find first for free from get guide had has have
   here how in interactive is it its just last list checklist many map master mastered may
   might misc more most much must new next no not now obtain of on once one only or other our
   per rare epic legendary mythic base reward rewards same section sections see should some
   special still such table that the their then there these they this those to top total track
   two unlock use used using way ways we what when where which will with would you your
   fortnite sprite sprites`
    .split(/\s+/)
    .filter(Boolean),
);

const normalize = (word) => word.toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * Variant labels — Gem, Gold, Holofoil. On their own they name no entry: every
 * real one reads "<Variant> <Base> Sprite". A page announcing "8 Gem Sprites
 * were added!" is describing a batch, not a sprite called Gem, and treating it
 * as a name is a false alarm that repeats every day until the page changes.
 *
 * Kept out of STOPWORDS on purpose. Leading stopwords get peeled off a
 * candidate before matching, and peeling a variant label would let a genuinely
 * new "Holofoil Duck Sprite" resolve on the strength of "Duck" — the exact miss
 * `resolves` is written to avoid.
 */
const VARIANT_LABELS = new Set(Object.values(VARIANTS).map((v) => normalize(v.label)));

/** Every "<Something> Sprite" the page mentions, matched one sentence at a time. */
export function extractSpriteNames(text) {
  const found = new Set();

  // Split on newlines AND sentence ends, so a name cannot be assembled across
  // a full stop or a table cell boundary.
  for (const chunk of text.split(/[\n.!?]+/)) {
    for (const match of chunk.matchAll(/\b([A-Z0-9][A-Za-z0-9'’-]*(?: [A-Z0-9][A-Za-z0-9'’-]*){0,5}) Sprites?\b/g)) {
      const name = match[1].trim();
      if (!/[a-z]/i.test(name)) continue;
      const words = name.split(' ');
      if (words.every((word) => STOPWORDS.has(normalize(word)))) continue;
      if (VARIANT_LABELS.has(normalize(name))) continue;
      if (/^\d+ /.test(name) && VARIANT_LABELS.has(normalize(name.replace(/^\d+ /, '')))) continue;
      found.add(name);
    }
  }

  return [...found];
}

const isStopword = (word) => STOPWORDS.has(normalize(word));

/**
 * True when the candidate names something the catalog already holds.
 *
 * Pages put labels in front of the name — "Mastered Gold Air Sprite",
 * "Reward Quack Water Sprite" — so leading stopwords are dropped before
 * matching. Only stopwords, though. Peeling off arbitrary leading words would
 * let "Prismatic Water Sprite" resolve on the strength of "Water", and a new
 * VARIANT of a sprite we already know is exactly the change most likely to
 * happen mid-season and the one worst to miss.
 */
export function resolves(candidate) {
  const words = candidate.split(' ');

  for (let i = 0; i < words.length; i += 1) {
    if (idForName(words.slice(i).join(' '))) return true;
    if (!isStopword(words[i])) return false;
  }

  return false;
}

/**
 * The totals a page states about the collection as a whole.
 *
 * Deliberately narrow. These pages are full of other counts — "Master 60
 * Sprites", "500 Sprite Dust" — and treating those as collection totals is how
 * a drift check ends up firing every single day and getting muted.
 */
export function extractTotals(text) {
  // The sentence only, not a fixed window — the paragraph after it is where
  // "Master 60 Sprites" and "500 Sprite Dust" live.
  const intro = text.match(/there (?:are|is) currently[^.\n]*/i);
  if (!intro) return [];

  return [...intro[0].matchAll(/\b(\d{1,4})\b/g)]
    .map((match) => Number(match[1]))
    .filter((n) => n > 0 && n <= 2000);
}

/**
 * Compares what a page says against what the catalog holds.
 *
 * A name is "unknown" only if it resolves to nothing, so the patch-note
 * spellings already in `aliases` — Lootin' Llama, Grim Reaper — do not trip it.
 */
export function findDrift(names, totals = []) {
  const unknown = [...new Set(names.filter((name) => !resolves(name)))].sort();

  const live = ALL_ENTRIES.filter((entry) => entry.state === 'live').length;
  const withVaulted = ALL_ENTRIES.filter((entry) => entry.state !== 'datamined').length;

  // A published total we cannot account for means something shipped, or got
  // vaulted, since the catalog was last checked.
  const known = new Set([live, withVaulted, ALL_ENTRIES.length, SPRITES.length]);
  for (const season of Object.keys(SEASONS)) {
    const entries = ALL_ENTRIES.filter((e) => e.season === season);
    known.add(entries.length);
    known.add(entries.filter((e) => e.released).length);
    known.add(entries.filter((e) => e.state !== 'datamined').length);
    known.add(new Set(entries.map((e) => e.spriteKey)).size);
  }
  const unexplainedTotals = [...new Set(totals)].filter((n) => !known.has(n)).sort((a, b) => a - b);

  return {
    drifted: unknown.length > 0 || unexplainedTotals.length > 0,
    unknown,
    unexplainedTotals,
    ours: { live, withVaulted, all: ALL_ENTRIES.length, sprites: SPRITES.length },
  };
}

/* ---------------------------------------------------------------------- */

export async function checkCatalog({ fetchImpl = fetch, sources = SOURCES, now = new Date(),
  verified = CATALOG_VERIFIED, patch = CATALOG_PATCH } = {}) {
  const reports = [];
  const fetchText = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000),
      headers: { 'user-agent': 'forknife-67 catalog checker (github.com/windoze95/forknife-67)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
  };
  // Both sources are required. A build cannot prove a hotfix roster complete;
  // a frozen community roster cannot prove the game has not moved on.
  await Promise.all(sources.map(async (source) => {
    const report = { source: source.name, url: source.url, type: source.type };
    try {
      const body = await fetchText(source.url);
      if (source.type === 'build') {
        report.patch = parseBuild(body);
        report.drifted = report.patch !== patch;
      } else if (source.type === 'roster') {
        const index = parseRosterIndex(body, source.url);
        Object.assign(report, { season: index.season, families: index.families.length,
          publishedTotal: index.publishedTotal });
        const expectedSeason = SEASONS[CURRENT_SEASON].split(' · ')[0];
        if (index.season !== expectedSeason) {
          report.drifted = true;
          report.reason = `Source covers ${index.season}; catalog covers ${expectedSeason}`;
        } else {
          const rows = [];
          // Bound requests, and require every family to parse successfully.
          for (let i = 0; i < index.families.length; i += 4) {
            const batch = await Promise.all(index.families.slice(i, i + 4).map(async (family) => {
              const entries = parseVariantTable(await fetchText(family.url));
              if (!entries.some((e) => normalize(e.name) === normalize(family.name))) {
                throw new Error(`Variant table omits its base sprite: ${family.name}`);
              }
              return entries;
            }));
            rows.push(...batch.flat());
          }
          Object.assign(report, findDrift(rows.map((row) => row.name)));
          report.entriesRead = rows.length;
          const sourceReleased = rows.filter((row) => row.released).length;
          if (sourceReleased !== index.publishedTotal) {
            throw new Error(`Incomplete release coverage: tables contain ${sourceReleased}, index declares ${index.publishedTotal}`);
          }
          const ids = new Set(rows.map((row) => idForName(row.name)).filter(Boolean));
          const missing = ALL_ENTRIES.filter((e) => e.season === CURRENT_SEASON && e.released && !ids.has(e.id));
          if (missing.length) throw new Error(`Source lacks current entries: ${missing.map((e) => e.name).join(', ')}`);
          report.newlyReleased = rows.filter((row) => row.released)
            .filter((row) => ALL_ENTRIES.some((e) => e.id === idForName(row.name) && !e.released))
            .map((row) => row.name);
          report.drifted ||= report.newlyReleased.length > 0;
          report.pendingInSource = rows.filter((row) => !row.released && ids.has(idForName(row.name)))
            .filter((row) => ALL_ENTRIES.some((e) => e.id === idForName(row.name) && e.released)).length;
        }
      } else throw new Error(`Unknown source type: ${source.type}`);
    } catch (error) {
      report.error = error.message;
    }
    reports.push(report);
  }));
  reports.sort((a, b) => sources.findIndex((s) => s.url === a.url) - sources.findIndex((s) => s.url === b.url));
  const ageDays = Math.floor((now.getTime() - Date.parse(`${verified}T00:00:00Z`)) / 86400000);
  const reviewDue = !Number.isFinite(ageDays) || ageDays < 0 || ageDays > MAX_VERIFICATION_AGE_DAYS;
  const incomplete = !sources.some((s) => s.type === 'build') || !sources.some((s) => s.type === 'roster')
    || reports.some((r) => r.error);
  const drifted = reviewDue || reports.some((r) => r.drifted);
  const exitCode = incomplete ? 2 : drifted ? 1 : 0;
  return { status: exitCode === 2 ? 'incomplete' : exitCode === 1 ? 'review-needed' : 'checked',
    exitCode, catalogPatch: patch, verified, ageDays, reviewDue, reports };
}

export function formatReport(result) {
  const lines = [`Catalog ${result.catalogPatch}; verified ${result.verified}`, `Status: ${result.status}`];
  for (const report of result.reports) {
    lines.push(`\n${report.source}`, `  ${report.url}`);
    if (report.patch) lines.push(`  Live game: ${report.patch}`);
    if (report.entriesRead) lines.push(`  Read ${report.entriesRead} entries across ${report.families} families (${report.season})`);
    if (report.pendingInSource) lines.push(`  Source still marks ${report.pendingInSource} verified releases as upcoming; keeping the reviewed catalog states.`);
    if (report.error) lines.push(`  UNABLE TO VERIFY: ${report.error}`);
    if (report.reason) lines.push(`  ${report.reason}`);
    if (report.unknown?.length) lines.push(`  UNKNOWN NAMES: ${report.unknown.join(', ')}`);
    if (report.newlyReleased?.length) lines.push(`  NEWLY RELEASED: ${report.newlyReleased.join(', ')}`);
    if (report.drifted && report.patch) lines.push('  Game patch differs from the verified catalog.');
  }
  if (result.reviewDue) lines.push(`\nCatalog verification is overdue (maximum ${MAX_VERIFICATION_AGE_DAYS} days). Check same-patch hotfixes and refresh CATALOG_VERIFIED.`);
  if (result.exitCode) lines.push('\nReview the live roster, catalog, artwork and source coverage. This check never edits them.');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkCatalog();
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatReport(result));
  process.exitCode = result.exitCode;
}
