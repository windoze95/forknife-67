/**
 * Downloads the sprite artwork and shrinks it to tile size.
 *
 *   node tools/fetch-sprite-art.js          # only what is missing
 *   node tools/fetch-sprite-art.js --force  # re-fetch everything
 *
 * Output is committed to public/sprites/<entry id>.webp, so nobody needs this
 * tool to build or run the app — same arrangement as tools/make-icons.js.
 *
 * The art is Epic's, re-hosted by fortnite.gg. Fan projects may use Epic's
 * assets non-commercially under the Fan Content Policy, which is what this is.
 *
 * Requires `cwebp` (brew install webp). The source images are 512x512 and
 * ~27 KB each; the tiles render at ~34 CSS px, so shipping the originals would
 * be 3.2 MB to draw thumbnails. Resized to 96px the whole set is ~310 KB, which
 * a service worker can cache without anyone noticing.
 *
 * ART maps a catalog entry id to Epic's texture name. Epic's internal names
 * have no relationship to the display names — the Batman Sprite is
 * `FossilMeal`, Vini Jr. is `CokeParmesan`, Ironmouse is `PedicureAntacid` —
 * so this cannot be derived and has to be recorded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ALL_ENTRIES } from '../public/lib/catalog.js';

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'sprites');
const TMP_DIR = path.join(ROOT, '.art-cache');

const BASE = 'https://fortnite.gg/img/x/sprites/icons/T_Icon_';
const SIZE = 96;
const QUALITY = 82;
const CONCURRENCY = 6;

const ART = {
  water: 'BR_Creature_Sprite_Water_Unvault_Ch7S3_ui_L',
  'water.gold': 'BR_Creature_Sprite_Water_Gold_ui_L',
  'water.gummy': 'BR_Creature_Sprite_Water_Candy_ui_L',
  'water.galaxy': 'BR_Creature_Sprite_Water_Galaxy_ui_L',
  'water.holofoil': 'BR_Creature_Sprite_Water_Holofoil_ui_L',
  'water.quack': 'BR_Creature_Sprite_Water_Quack_ui_L',
  'water.gem': 'BR_Creature_Sprite_Water_Gem_ui_L',

  earth: 'BR_Creature_Sprite_Earth_Ch7S3_UI_L',
  'earth.gold': 'BR_Creature_Sprite_Earth_Gold_ui_L',
  'earth.gummy': 'BR_Creature_Sprite_Earth_Candy_ui_L',
  'earth.galaxy': 'BR_Creature_Sprite_Earth_Galaxy_ui_L',
  'earth.cube': 'BR_Creature_Sprite_Earth_Cube_ui_L',
  'earth.quack': 'BR_Creature_Sprite_Earth_Quack_ui_L',
  'earth.gem': 'BR_Creature_Sprite_Earth_Gem_ui_L',

  fire: 'BR_Creature_Sprite_Fire_Unvault_Ch7S3_ui_L',
  'fire.gold': 'BR_Creature_Sprite_Fire_Gold_ui_L',
  'fire.gummy': 'BR_Creature_Sprite_Fire_Candy_ui_L',
  'fire.galaxy': 'BR_Creature_Sprite_Fire_Galaxy_ui_L',
  'fire.holofoil': 'BR_Creature_Sprite_Fire_Holofoil_ui_L',
  'fire.cube': 'BR_Creature_Sprite_Fire_Cube_ui_L',
  'fire.quack': 'BR_Creature_Sprite_Fire_Quack_ui_L',

  fishy: 'BR_Creature_Sprite_Fishy_ui_L',
  'fishy.gold': 'BR_Creature_Sprite_Fishy_Gold_ui_L',
  'fishy.gummy': 'BR_Creature_Sprite_Fishy_Candy_ui_L',
  'fishy.galaxy': 'BR_Creature_Sprite_Fishy_Galaxy_ui_L',
  'fishy.cube': 'BR_Creature_Sprite_Fishy_Cube_L',

  air: 'BR_Air_Default_L',
  'air.gold': 'BR_Air_Gold_L',
  'air.gummy': 'BR_Air_Candy_L',
  'air.galaxy': 'BR_Air_Galaxy_L',
  'air.holofoil': 'BR_Air_Holo_L',

  duck: 'BR_Duck_Default_L',
  'duck.gold': 'BR_Duck_Gold_L',
  'duck.gummy': 'BR_Duck_Candy_L',
  'duck.galaxy': 'BR_Duck_Galaxy_L',
  'duck.gem': 'BR_Duck_Gem_L',

  ghost: 'BR_Creature_Sprite_Ghost_Unvault_L',
  'ghost.gold': 'BR_Creature_Sprite_Ghost_Gold_L',
  'ghost.gummy': 'BR_Creature_Sprite_Ghost_Candy_L',
  'ghost.galaxy': 'BR_Creature_Sprite_Ghost_Galaxy_L',
  'ghost.holofoil': 'BR_Creature_Sprite_Ghost_Holo_L',

  demon: 'BR_RedDemon_Default_L',
  'demon.gold': 'BR_RedDemon_Gold_L',
  'demon.gummy': 'BR_RedDemon_Candy_L',
  'demon.galaxy': 'BR_RedDemon_Galaxy_L',
  'demon.gem': 'BR_RedDemon_Gem_L',

  king: 'BR_Creature_Sprite_King_ui_L',
  'king.gold': 'BR_Creature_Sprite_King_Gold_ui_L',
  'king.gummy': 'BR_Creature_Sprite_King_Candy_ui_L',
  'king.galaxy': 'BR_Creature_Sprite_King_Galaxy_ui_L',
  'king.holofoil': 'BR_Creature_Sprite_King_Holofoil_ui_L',

  striker: 'BR_Creature_Sprite_Soccer_ui_L',
  'striker.gold': 'BR_Creature_Sprite_Soccer_Gold_L',
  'striker.gummy': 'BR_Creature_Sprite_Soccer_Candy_L',
  'striker.galaxy': 'BR_Creature_Sprite_Soccer_Galaxy_L',
  'striker.holofoil': 'BR_Creature_Sprite_Soccer_Holofoil_L',

  aura: 'BR_Creature_Sprite_Drifter_ui_L',
  'aura.gold': 'BR_Creature_Sprite_Drifter_Gold_ui_L',
  'aura.gummy': 'BR_Creature_Sprite_Drifter_Candy_ui_L',
  'aura.galaxy': 'BR_Creature_Sprite_Drifter_Galaxy_ui_L',
  'aura.gem': 'BR_Creature_Sprite_Drifter_Gem_ui_L',

  dream: 'BR_Creature_Sprite_Sleepy_ui_L',
  'dream.gold': 'BR_Creature_Sprite_Sleepy_Gold_ui_L',
  'dream.gummy': 'BR_Creature_Sprite_Sleepy_Candy_ui_L',
  'dream.galaxy': 'BR_Creature_Sprite_Sleepy_Galaxy_ui_L',
  'dream.cube': 'BR_Creature_Sprite_Sleepy_Cube_ui_L',

  punk: 'BR_Creature_Sprite_Punk_ui_L',
  'punk.gold': 'BR_Creature_Sprite_Punk_Gold_ui_L',
  'punk.gummy': 'BR_Creature_Sprite_Punk_Candy_ui_L',
  'punk.galaxy': 'BR_Creature_Sprite_Punk_Galaxy_ui_L',
  'punk.cube': 'BR_Creature_Sprite_Punk_Cube_ui_L',
  'punk.gem': 'BR_Creature_Sprite_Punk_Gem_ui_L',

  boss: 'BR_Creature_Sprite_Boss_ui_L',
  'boss.gold': 'BR_Creature_Sprite_Boss_Gold_ui_L',
  'boss.gummy': 'BR_Creature_Sprite_Boss_Candy_ui_L',
  'boss.galaxy': 'BR_Creature_Sprite_Boss_Galaxy_ui_L',
  'boss.cube': 'BR_Creature_Sprite_Boss_Cube_ui_L',

  seven: 'BR_Creature_Sprite_Seven_ui_L',
  'seven.gold': 'BR_Creature_Sprite_Seven_Gold_ui_L',
  'seven.gummy': 'BR_Creature_Sprite_Seven_Candy_ui_L',
  'seven.galaxy': 'BR_Creature_Sprite_Seven_Galaxy_ui_L',
  'seven.holofoil': 'BR_Creature_Sprite_Seven_Holofoil_ui_L',

  llama: 'BR_Creature_Sprite_Llama_ui_L',
  'llama.gold': 'BR_Creature_Sprite_Llama_Gold_ui_L',
  'llama.gummy': 'BR_Creature_Sprite_Llama_Candy_ui_L',
  'llama.galaxy': 'BR_Creature_Sprite_Llama_Galaxy_ui_L',
  'llama.gem': 'BR_Creature_Sprite_Llama_Gem_ui_L',

  peely: 'BR_Creature_Sprite_Peely_ui_L',
  'peely.gold': 'BR_Creature_Sprite_Peely_Gold_ui_L',
  'peely.gummy': 'BR_Creature_Sprite_Peely_Candy_ui_L',
  'peely.galaxy': 'BR_Creature_Sprite_Peely_Galaxy_ui_L',
  'peely.holofoil': 'BR_Creature_Sprite_Peely_Holofoil_ui_L',

  zeropoint: 'BR_Creature_Sprite_ZeroPoint_ui_L',
  'zeropoint.gold': 'BR_Creature_Sprite_ZeroPoint_Gold_ui_L',
  'zeropoint.gummy': 'BR_Creature_Sprite_ZeroPoint_Candy_ui_L',
  'zeropoint.galaxy': 'BR_Creature_Sprite_ZeroPoint_Galaxy_ui_L',
  'zeropoint.holofoil': 'BR_Creature_Sprite_ZeroPoint_Holofoil_ui_L',
  'zeropoint.cube': 'BR_Creature_Sprite_ZeroPoint_Cube_ui_L',
  'zeropoint.quack': 'BR_Creature_Sprite_ZeroPoint_Quack_ui_L',
  'zeropoint.gem': 'BR_Creature_Sprite_ZeroPoint_Gem_ui_L',

  grim: 'BR_GrimReaper_Default_L',
  'grim.gold': 'BR_GrimReaper_Gold_L',
  'grim.gummy': 'BR_GrimReaper_Candy_L',
  'grim.galaxy': 'BR_GrimReaper_Galaxy_L',
  'grim.holofoil': 'BR_GrimReaper_Holofoil_L',
  'grim.cube': 'BR_GrimReaper_Cube_L',
  'grim.gem': 'BR_GrimReaper_Gem_L',

  batman: 'BR_FossilMeal_Default_L',
  'batman.gold': 'BR_FossilMeal_Gold_L',
  'batman.gummy': 'BR_FossilMeal_Candy_L',
  'batman.galaxy': 'BR_FossilMeal_Galaxy_L',
  'batman.holofoil': 'BR_FossilMeal_Holofoil_L',
  'batman.cube': 'BR_FossilMeal_Cube_L',

  burntpeanut: 'BR_Creature_Sprite_BurntPeanut_ui_L',
  vinijr: 'BR_CokeParmesan_Default_L',
  pollo: 'BR_CompanyStargazer_Default_L',
  johnwick: 'Reload_FillerGrunt_icon_L',
  ironmouse: 'BR_PedicureAntacid_L',
};

/* ---------------------------------------------------------------------- */

const force = process.argv.includes('--force');

// A catalog entry with no artwork would render a broken tile, and an ART key
// with no entry is a name that changed under us. Both are worth stopping for.
const missing = ALL_ENTRIES.filter((entry) => !ART[entry.id]).map((entry) => entry.id);
const orphaned = Object.keys(ART).filter((id) => !ALL_ENTRIES.some((entry) => entry.id === id));

if (missing.length) throw new Error(`no artwork mapped for: ${missing.join(', ')}`);
if (orphaned.length) throw new Error(`artwork mapped to unknown entries: ${orphaned.join(', ')}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

async function fetchOne(id) {
  const out = path.join(OUT_DIR, `${id}.webp`);
  if (!force && fs.existsSync(out)) return 'skipped';

  const source = path.join(TMP_DIR, `${ART[id]}.webp`);

  if (force || !fs.existsSync(source)) {
    const res = await fetch(`${BASE}${ART[id]}.webp`, {
      headers: {
        // Plain fetches are refused; this is the same request a browser makes.
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        referer: 'https://fortnite.gg/sprites',
      },
    });
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status} for ${ART[id]}`);
    fs.writeFileSync(source, Buffer.from(await res.arrayBuffer()));
  }

  await run('cwebp', ['-quiet', '-resize', String(SIZE), String(SIZE), '-q', String(QUALITY), source, '-o', out]);
  return 'written';
}

const ids = ALL_ENTRIES.map((entry) => entry.id);
const counts = { written: 0, skipped: 0 };

for (let i = 0; i < ids.length; i += CONCURRENCY) {
  const batch = ids.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map(fetchOne));
  for (const result of results) counts[result] += 1;
}

const bytes = fs
  .readdirSync(OUT_DIR)
  .reduce((total, file) => total + fs.statSync(path.join(OUT_DIR, file)).size, 0);

console.log(
  `${counts.written} written, ${counts.skipped} already present — ` +
    `${fs.readdirSync(OUT_DIR).length} files, ${(bytes / 1024).toFixed(0)} KB total`,
);
