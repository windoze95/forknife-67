/**
 * Tells you when Fortnite has moved and the catalog hasn't.
 *
 *   node tools/check-catalog-drift.js          # report, exit 1 if drifted
 *   node tools/check-catalog-drift.js --json   # machine-readable, exit 0
 *
 * Runs daily from .github/workflows/catalog-drift.yml, which files an issue
 * when this exits non-zero.
 *
 * WHY IT ONLY DETECTS, AND DOES NOT UPDATE
 * ----------------------------------------
 * The obvious version writes new sprites straight into the catalog, or into a
 * database the app reads at runtime. Both are worse:
 *
 *   - The catalog ships with the app, so it works with no signal. That is the
 *     entire point of a tracker you use mid-match on mobile data. Moving it to
 *     a database trades that away for the ability to skip a deploy.
 *   - A scraper that writes to production has no reviewer. When the source page
 *     changes shape — or a wiki edit is simply wrong — the app starts stating
 *     wrong drop rates to someone who has no way to notice.
 *
 * So this opens an issue and a human confirms. The number of sprites Epic ships
 * in a season is small; the cost of quietly publishing a wrong one is not.
 *
 * WHY THE PARSING IS DUMB ON PURPOSE
 * ----------------------------------
 * It could ask a model to read the page. It doesn't. Detection has exactly one
 * job — "is there a name here that the catalog has never heard of?" — and a
 * name index answers that exactly, the same way every run, with no key and no
 * spend. A model would add a way for the answer to be confidently wrong, which
 * is the failure this whole file exists to prevent.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * Drop rates, dust costs, exact in-game strings and artwork all come from the
 * game files via fortnite.gg, which refuses plain fetches AND headless
 * browsers (403 both ways — tested). Enriching a newly spotted sprite needs a
 * real browser or a scraping service such as Firecrawl. That is a hand step
 * today, and the issue this files says so.
 */

import { ALL_ENTRIES, SPRITES, VARIANTS, idForName } from '../public/lib/catalog.js';

/** Sources that answer a plain fetch. fortnite.gg does not, so it is not here. */
export const SOURCES = [
  {
    name: 'IGN sprite checklist',
    url: 'https://www.ign.com/wikis/fortnite/Sprites_Checklist_and_Guide_-_All_Variants,_Abilities,_and_Mastery_Rewards_List',
  },
];

/**
 * Block tags become newlines, not spaces. Flattening the whole page to one
 * line lets a heading run into the next table cell, and "Mastered" + "Gold Air"
 * in adjacent cells reads as a sprite called "Mastered Gold Air".
 */
export function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|br|section|article|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
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

const normalize = (word) => word.toLowerCase().replace(/[^a-z']/g, '');

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
    for (const match of chunk.matchAll(/([A-Z][A-Za-z'.]*(?: [A-Z][A-Za-z'.]*){0,3}) Sprites?\b/g)) {
      const name = match[1].trim();
      const words = name.split(' ');
      if (words.every((word) => STOPWORDS.has(normalize(word)))) continue;
      if (words.every((word) => VARIANT_LABELS.has(normalize(word)))) continue;
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

  return [...intro[0].matchAll(/\b(\d{2,4})\b/g)]
    .map((match) => Number(match[1]))
    .filter((n) => n >= 50 && n <= 2000);
}

/**
 * Compares what a page says against what the catalog holds.
 *
 * A name is "unknown" only if it resolves to nothing, so the patch-note
 * spellings already in `aliases` — Lootin' Llama, Grim Reaper — do not trip it.
 */
export function findDrift(names, totals) {
  const unknown = names.filter((name) => !resolves(name)).sort();

  const live = ALL_ENTRIES.filter((entry) => entry.state === 'live').length;
  const withVaulted = ALL_ENTRIES.filter((entry) => entry.state !== 'datamined').length;

  // A published total we cannot account for means something shipped, or got
  // vaulted, since the catalog was last checked.
  const known = new Set([live, withVaulted, ALL_ENTRIES.length, SPRITES.length]);
  const unexplainedTotals = [...new Set(totals)].filter((n) => !known.has(n)).sort((a, b) => a - b);

  return {
    drifted: unknown.length > 0 || unexplainedTotals.length > 0,
    unknown,
    unexplainedTotals,
    ours: { live, withVaulted, all: ALL_ENTRIES.length, sprites: SPRITES.length },
  };
}

/* ---------------------------------------------------------------------- */

async function main() {
  const json = process.argv.includes('--json');
  const reports = [];

  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        reports.push({ source: source.name, error: `HTTP ${res.status}` });
        continue;
      }

      const text = stripHtml(await res.text());
      reports.push({
        source: source.name,
        url: source.url,
        ...findDrift(extractSpriteNames(text), extractTotals(text)),
      });
    } catch (err) {
      reports.push({ source: source.name, error: err.message });
    }
  }

  if (json) {
    console.log(JSON.stringify({ reports }, null, 2));
    return;
  }

  let drifted = false;

  for (const report of reports) {
    console.log(`\n${report.source}`);

    if (report.error) {
      // A source being down is not drift, and must not raise a false alarm.
      console.log(`  could not check: ${report.error}`);
      continue;
    }

    console.log(
      `  we hold ${report.ours.live} obtainable, ${report.ours.withVaulted} including vaulted, ` +
        `${report.ours.all} in total across ${report.ours.sprites} sprites`,
    );

    if (report.unknown.length) {
      drifted = true;
      console.log(`  NAMES WE DO NOT KNOW: ${report.unknown.join(', ')}`);
    }

    if (report.unexplainedTotals.length) {
      drifted = true;
      console.log(`  TOTALS WE CANNOT ACCOUNT FOR: ${report.unexplainedTotals.join(', ')}`);
    }

    if (!report.unknown.length && !report.unexplainedTotals.length) {
      console.log('  no drift');
    }
  }

  if (drifted) {
    console.log(
      '\nThe catalog is behind. Update public/lib/catalog.js from the game files' +
        ' (fortnite.gg needs a real browser), run tools/fetch-sprite-art.js, and' +
        ' move the pinned counts in test/catalog.test.js.',
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
