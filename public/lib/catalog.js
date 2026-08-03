/**
 * The sprite catalog — every collectible in Fortnite: Runners.
 *
 * Imported by the browser app AND the Node server, so keep it dependency free
 * and side-effect free, exactly like vault.js.
 *
 * WHERE THIS CAME FROM, and how to update it
 * ------------------------------------------
 * Names, rarities, power text, level scaling, locations, summon costs and drop
 * rates are all read out of the game files, mirrored by fortnite.gg. Epic's
 * patch notes were used as a second source for anything ambiguous.
 *
 * The two disagree on four names. The game files win here because that is what
 * the player actually sees on the sprite, but the patch-note spelling is kept
 * in `aliases` so searching either one finds it:
 *
 *     game file          Epic's patch notes
 *     Llama Sprite       Lootin' Llama Sprite     (v41.30)
 *     Peely Sprite       Peeky Peely Sprite       (v41.30)
 *     Grim Sprite        Grim Reaper Sprite       (v41.10)
 *     Burnt Peanut       TheBurntPeanut Sprite
 *
 * Fan checklists get this wrong in both directions, and they disagree with each
 * other on the totals (91 / 109 / 111 are all in circulation) and on what the
 * variants do. Trust the game files.
 *
 * Epic ships new sprites and variants with roughly every patch, so this file
 * goes stale on a schedule. Two things keep that from being a problem:
 *
 *   1. Entry ids are derived from `key`, never from position, so adding a
 *      sprite anywhere in this list cannot disturb anyone's saved progress.
 *   2. The app lets you add your own entry, so a sprite that ships before this
 *      file is updated is still trackable that day.
 */

/** The patch this catalog was verified against. Shown in the app. */
export const CATALOG_PATCH = 'v41.30';
export const CATALOG_VERIFIED = '2026-08-02';

export const RARITIES = ['rare', 'epic', 'legendary', 'mythic'];

export const RARITY_LABEL = {
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
  mythic: 'Mythic',
};

/**
 * Display order for variants, so the same variant sits in the same place in
 * every group and the grid can be scanned down a column.
 */
export const VARIANT_ORDER = ['gold', 'gummy', 'galaxy', 'holofoil', 'cube', 'quack', 'gem'];

/**
 * What each variant adds on top of the base sprite's power, verbatim from the
 * game files. Cube and Quack are pure cosmetics — their in-game description is
 * identical to the base sprite's, with nothing added.
 */
export const VARIANTS = {
  base: { label: 'Base', perk: '' },
  gold: { label: 'Gold', perk: 'Gain 3x bonus XP from eliminations' },
  gummy: { label: 'Gummy', perk: 'Gain 20% more Sprite Dust upon Extraction' },
  galaxy: { label: 'Galaxy', perk: 'Gain 30% more Ammo whenever picked up in the world' },
  holofoil: {
    label: 'Holofoil',
    perk: '5% chance for your squad to find rare Sprite Variants from looting chests',
  },
  cube: { label: 'Cube', perk: '' },
  quack: { label: 'Quack', perk: '' },
  gem: { label: 'Gem', perk: 'Take 30% less Fall damage' },
};

/**
 * Sprite Dust to summon a variant, which depends only on the base sprite's
 * rarity. Base sprites are priced individually and carry their own `dust`.
 */
export const VARIANT_DUST = { rare: 2700, epic: 4000, legendary: 6750, mythic: 10000 };

/**
 * `drop` is the chance of pulling that entry from a single Sprite Chest.
 * A 0 means it does not come out of chests at all — those are the ones you
 * summon with dust, or earn from Mastery (every Quack variant works this way).
 *
 * `released: false` marks an entry that is in the files but not yet obtainable.
 * Those are hidden unless you turn them on in the menu.
 */
export const SPRITES = [
  /* ------------------------------- Rare -------------------------------- */
  {
    key: 'water',
    name: 'Water Sprite',
    rarity: 'rare',
    power: 'Replenish shields while standing in water!',
    scaling: '2 → 3 → 4 → 5 → 6 Shield per tick',
    where: 'Spotted near rivers and beaches',
    dust: 100,
    drop: 0,
    variants: [
      { v: 'gold', drop: 0.53 },
      { v: 'gummy', drop: 0.53 },
      { v: 'galaxy', drop: 0.43 },
      { v: 'holofoil', drop: 0.53 },
      { v: 'quack', drop: 0 },
      { v: 'gem', drop: 0.37, released: false },
    ],
  },
  {
    key: 'earth',
    name: 'Earth Sprite',
    rarity: 'rare',
    power: 'You have a chance to find additional rare items when opening chests.',
    scaling: '10% → 12.5% → 15% → 17.5% → 20% chance',
    where: 'Found wandering around forests and wooded regions',
    dust: 100,
    drop: 0,
    variants: [
      { v: 'gold', drop: 0.53 },
      { v: 'gummy', drop: 0.53 },
      { v: 'galaxy', drop: 0.43 },
      { v: 'cube', drop: 0.21 },
      { v: 'quack', drop: 0 },
      { v: 'gem', drop: 0.37, released: false },
    ],
  },
  {
    key: 'fire',
    name: 'Fire Sprite',
    rarity: 'rare',
    power: 'Creates a fiery burst when you deal enough damage to an enemy!',
    scaling: '150 → 125 → 100 → 75 → 50 damage to trigger',
    where: 'Located near urban areas',
    dust: 100,
    drop: 0,
    variants: [
      { v: 'gold', drop: 0.53 },
      { v: 'gummy', drop: 0.53 },
      { v: 'galaxy', drop: 0.43 },
      { v: 'holofoil', drop: 0.53 },
      { v: 'cube', drop: 0.21 },
      { v: 'quack', drop: 0 },
    ],
  },
  {
    key: 'fishy',
    name: 'Fishy Sprite',
    rarity: 'rare',
    power: 'Swim speed greatly increased. Taking damage also briefly increases movement speed.',
    scaling: '25% → 50% → 100% → 150% → 200% swim speed (and 10% → 50% movement speed)',
    where: 'Spotted near high and mountainous areas',
    dust: 1800,
    drop: 0,
    variants: [
      { v: 'gold', drop: 0.64 },
      { v: 'gummy', drop: 0.53 },
      { v: 'galaxy', drop: 0.43 },
      { v: 'cube', drop: 0.21 },
    ],
  },
  {
    key: 'air',
    name: 'Air Sprite',
    rarity: 'rare',
    power: 'Increases sprinting speed and jump height. Also nullifies fall damage.',
    scaling: 'Jump height increases',
    where: 'Spotted near high and mountainous areas',
    dust: 1800,
    drop: 0,
    variants: [
      { v: 'gold', drop: 0.53 },
      { v: 'gummy', drop: 0.53 },
      { v: 'galaxy', drop: 0.43 },
      { v: 'holofoil', drop: 0.53 },
    ],
  },

  /* ------------------------------- Epic -------------------------------- */
  {
    key: 'duck',
    name: 'Duck Sprite',
    rarity: 'epic',
    power: 'Emoting or Jamming replenishes shields.',
    scaling: '2 → 3 → 4 → 6 → 8 Shield per tick',
    where: 'Found in the vault of a certain business mogul',
    dust: 2700,
    drop: 6.48,
    variants: [
      { v: 'gold', drop: 0.62 },
      { v: 'gummy', drop: 0.37 },
      { v: 'galaxy', drop: 0.25 },
      { v: 'gem', drop: 0.1, released: false },
    ],
  },
  {
    key: 'ghost',
    name: 'Ghost Sprite',
    rarity: 'epic',
    power: 'Grants cloak for a duration upon reloading.',
    scaling: '3 → 3.5 → 4 → 4.5 → 5 seconds',
    where: 'Found in the world at nighttime',
    dust: 2700,
    drop: 5.25,
    variants: [
      { v: 'gold', drop: 0.62 },
      { v: 'gummy', drop: 0.37 },
      { v: 'galaxy', drop: 0.25 },
      { v: 'holofoil', drop: 1.23 },
    ],
  },
  {
    key: 'demon',
    name: 'Demon Sprite',
    rarity: 'epic',
    power: 'Siphon some health and shields when you eliminate an opponent.',
    scaling: '10 → 15 → 20 → 25 → 30 healing per elimination',
    where: 'Found rarely in Sprite Chests',
    dust: 2700,
    drop: 6.48,
    variants: [
      { v: 'gold', drop: 0.62 },
      { v: 'gummy', drop: 0.37 },
      { v: 'galaxy', drop: 0.25 },
      { v: 'gem', drop: 0.1, released: false },
    ],
  },
  {
    key: 'king',
    name: 'King Sprite',
    rarity: 'epic',
    power: 'Your Pickaxe deals more damage.',
    scaling: '30 → 40 → 60 → 80 → 120 bonus damage',
    where: 'Found rarely in Sprite Chests',
    dust: 2700,
    drop: 5.25,
    variants: [
      { v: 'gold', drop: 0.62 },
      { v: 'gummy', drop: 0.37 },
      { v: 'galaxy', drop: 0.25 },
      { v: 'holofoil', drop: 1.23 },
    ],
  },
  {
    key: 'striker',
    name: 'Striker Sprite',
    rarity: 'epic',
    power: 'Gain the Overdrive effect when you Mantle, Hurdle, or Wall Scramble.',
    scaling: '6 → 7 → 8 → 9 → 10 seconds of Overdrive',
    where: 'Spotted near high and mountainous areas',
    dust: 2700,
    drop: 5.25,
    variants: [
      { v: 'gold', drop: 0.62 },
      { v: 'gummy', drop: 0.37 },
      { v: 'galaxy', drop: 0.25 },
      { v: 'holofoil', drop: 1.23 },
    ],
  },
  {
    key: 'aura',
    name: 'Aura Sprite',
    rarity: 'epic',
    power: 'Gain a Shock Rock charge when you deal enough damage to enemies!',
    scaling: '175 → 150 → 125 → 100 → 75 damage to trigger',
    where: 'Spotted near high and mountainous areas',
    dust: 2700,
    drop: 6.48,
    variants: [
      { v: 'gold', drop: 0.62 },
      { v: 'gummy', drop: 0.37 },
      { v: 'galaxy', drop: 0.25 },
      { v: 'gem', drop: 0.08, released: false },
    ],
  },

  /* ----------------------------- Legendary ----------------------------- */
  {
    key: 'dream',
    name: 'Dream Sprite',
    rarity: 'legendary',
    power: 'Grants a random item at each level, exploding with legendary loot at Max Level.',
    scaling: 'Loot value increases',
    where: 'Sometimes found sleeping in the storage crates',
    dust: 4500,
    drop: 4.45,
    variants: [
      { v: 'gold', drop: 0.43 },
      { v: 'gummy', drop: 0.26 },
      { v: 'galaxy', drop: 0.17 },
      { v: 'cube', drop: 0.04 },
    ],
  },
  {
    key: 'punk',
    name: 'Punk Sprite',
    rarity: 'legendary',
    power: 'Possibly nothing... or infinitely something',
    scaling: '',
    where: 'Found rarely in Sprite Chests',
    dust: 4500,
    drop: 4.45,
    variants: [
      { v: 'gold', drop: 0.43 },
      { v: 'gummy', drop: 0.26 },
      { v: 'galaxy', drop: 0.17 },
      { v: 'cube', drop: 0.04 },
      { v: 'gem', drop: 0, released: false },
    ],
  },
  {
    key: 'boss',
    name: 'Boss Sprite',
    rarity: 'legendary',
    power: 'Grants an increase to your max HP and Shield.',
    scaling: '5 → 10 → 15 → 20 → 25 HP and Shield',
    where: 'Claimed from defeating a powerful adversary',
    dust: 4500,
    drop: 4.45,
    variants: [
      { v: 'gold', drop: 0.43 },
      { v: 'gummy', drop: 0.26 },
      { v: 'galaxy', drop: 0.17 },
      { v: 'cube', drop: 0.04 },
    ],
  },
  {
    key: 'seven',
    name: 'Seven Sprite',
    rarity: 'legendary',
    power: 'Enemy player foot trails are visible in the world for your Squad.',
    scaling: '10 → 15 → 20 → 25 → 30 second foot trails',
    where: 'Spotted near high and mountainous areas',
    dust: 4500,
    drop: 3.63,
    variants: [
      { v: 'gold', drop: 0.43 },
      { v: 'gummy', drop: 0.26 },
      { v: 'galaxy', drop: 0.17 },
      { v: 'holofoil', drop: 0.85 },
    ],
  },
  {
    key: 'llama',
    name: 'Llama Sprite',
    aliases: ["Lootin' Llama Sprite"],
    rarity: 'legendary',
    power: 'Opening ammo boxes has a chance to grant a weapon upgrade.',
    scaling: '5% → 10% → 15% → 17% → 20% chance',
    where: 'Found in Relic Chests',
    dust: 4500,
    drop: 4.45,
    variants: [
      { v: 'gold', drop: 0.43 },
      { v: 'gummy', drop: 0.26 },
      { v: 'galaxy', drop: 0.17 },
      { v: 'gem', drop: 0 },
    ],
  },
  {
    key: 'peely',
    name: 'Peely Sprite',
    aliases: ['Peeky Peely Sprite'],
    rarity: 'legendary',
    power: 'Emits a ping for players with rare sprites nearby, but marks you on the map.',
    scaling: '40m → 50m → 60m → 70m → 80m ping radius',
    where: 'Spotted near high and mountainous areas',
    dust: 4500,
    drop: 4.62,
    variants: [
      { v: 'gold', drop: 0.43 },
      { v: 'gummy', drop: 0.26 },
      { v: 'galaxy', drop: 0.17 },
      { v: 'holofoil', drop: 0.85 },
    ],
  },

  /* ------------------------------ Mythic ------------------------------- */
  {
    key: 'zeropoint',
    name: 'Zero Point Sprite',
    rarity: 'mythic',
    power:
      'Spawn a Shield Bubble Jr. when you use a healing item on yourself (excluding splashes and grenades).',
    scaling: '6 → 7 → 8 → 9 → 10 seconds',
    where: 'Found rarely in Sprite Chests',
    dust: 6750,
    drop: 0,
    variants: [
      { v: 'gold', drop: 0.00014 },
      { v: 'gummy', drop: 0.000085 },
      { v: 'galaxy', drop: 0.000056 },
      { v: 'holofoil', drop: 0.00028 },
      { v: 'cube', drop: 0.000014 },
      { v: 'quack', drop: 0 },
      { v: 'gem', drop: 0.00001, released: false },
    ],
  },
  {
    key: 'grim',
    name: 'Grim Sprite',
    aliases: ['Grim Reaper Sprite'],
    rarity: 'mythic',
    power: 'Players who attack you are marked for a duration.',
    scaling: '3 → 3.5 → 4 → 4.5 → 5 seconds',
    where: 'Found rarely in Sprite Chests',
    dust: 6750,
    drop: 0.15,
    variants: [
      { v: 'gold', drop: 0.01 },
      { v: 'gummy', drop: 0.01 },
      { v: 'galaxy', drop: 0.01 },
      { v: 'holofoil', drop: 0 },
      { v: 'cube', drop: 0 },
      { v: 'gem', drop: 0.00099, released: false },
    ],
  },
  {
    key: 'batman',
    name: 'Batman Sprite',
    rarity: 'mythic',
    power: 'Grants the ability to launch in the air and deploy the Bat Cape!',
    scaling: '',
    where: 'Found rarely in Sprite Chests',
    dust: 6750,
    drop: 1.44,
    variants: [
      { v: 'gold', drop: 0.17 },
      { v: 'gummy', drop: 0.1 },
      { v: 'galaxy', drop: 0.07 },
      { v: 'holofoil', drop: 0.34 },
      { v: 'cube', drop: 0.02 },
    ],
  },
  {
    key: 'burntpeanut',
    name: 'Burnt Peanut',
    aliases: ['TheBurntPeanut Sprite', 'Burnt Peanut Sprite'],
    rarity: 'mythic',
    power: 'Goop! When eliminating players, you may find more loot. Sometimes mythic!',
    scaling: '20% → 30% → 40% → 50% → 60% chance, plus a 10% Mythic chance at Max Level',
    where: 'Found in Relic Chests',
    dust: 6750,
    drop: 2.14,
    variants: [],
  },
  {
    key: 'vinijr',
    name: 'Vini Jr. Sprite',
    rarity: 'mythic',
    power:
      'Sprinting for a short time makes your slide destructive. Slidekicking enemies increases rate of fire and reload speed.',
    scaling: '40 → 45 → 50 → 55 → 60 slide damage (and 10% → 50% fire rate)',
    where: 'Found in Relic Chests',
    dust: 6750,
    drop: 2.14,
    variants: [],
  },
  {
    key: 'pollo',
    name: 'Pollo Sprite',
    rarity: 'mythic',
    power:
      'Upon earning an elimination, slowly replenish shield for you and nearby squad members for a duration.',
    scaling: '6 → 7 → 8 → 9 → 10 seconds',
    where: '',
    dust: 6750,
    drop: 2.14,
    variants: [],
  },
  {
    key: 'johnwick',
    name: 'John Wick Sprite',
    rarity: 'mythic',
    power: 'Knocking players reveals others nearby.',
    scaling: '3 → 3.5 → 4 → 4.5 → 5 second mark',
    where: 'Found rarely in Sprite Chests',
    dust: 6750,
    drop: 0,
    variants: [],
  },
  {
    key: 'ironmouse',
    name: 'Ironmouse Sprite',
    rarity: 'mythic',
    released: false,
    power: 'Regenerate health over time when low. While regenerating, gain Cloak and low gravity!',
    scaling: '60 → 70 → 80 → 90 → 100 Health',
    where: 'Found in Relic Chests',
    dust: 6750,
    drop: 2.14,
    variants: [],
  },
];

/* ---------------------------------------------------------------------- */
/* Derived views                                                          */
/* ---------------------------------------------------------------------- */

/** Prefix used for entries the player added by hand. */
export const CUSTOM_PREFIX = 'custom';

/**
 * Ids are `<key>` for a base sprite and `<key>.<variant>` for a variant. They
 * are derived from the sprite's key and never from its position, so reordering
 * this file or inserting a new sprite leaves saved progress untouched.
 */
export function entryId(spriteKey, variant) {
  return variant && variant !== 'base' ? `${spriteKey}.${variant}` : spriteKey;
}

function buildEntry(sprite, variant, drop, released) {
  const meta = VARIANTS[variant];
  return {
    id: entryId(sprite.key, variant),
    spriteKey: sprite.key,
    sprite: sprite.name,
    variant,
    variantLabel: meta.label,
    // "Gold Water Sprite" — the name the game shows, which is what a player
    // types into the search box.
    name: variant === 'base' ? sprite.name : `${meta.label} ${sprite.name}`,
    rarity: sprite.rarity,
    power: sprite.power,
    perk: meta.perk,
    scaling: sprite.scaling,
    where: sprite.where,
    dust: variant === 'base' ? sprite.dust : VARIANT_DUST[sprite.rarity],
    drop,
    released,
  };
}

function orderedVariants(sprite) {
  const byName = new Map(sprite.variants.map((v) => [v.v, v]));
  return VARIANT_ORDER.filter((v) => byName.has(v)).map((v) => byName.get(v));
}

/** Every entry in the catalog, released or not, in display order. */
export const ALL_ENTRIES = SPRITES.flatMap((sprite) => {
  const baseReleased = sprite.released !== false;
  return [
    buildEntry(sprite, 'base', sprite.drop, baseReleased),
    ...orderedVariants(sprite).map((v) =>
      buildEntry(sprite, v.v, v.drop, baseReleased && v.released !== false),
    ),
  ];
});

export const ENTRY_BY_ID = new Map(ALL_ENTRIES.map((entry) => [entry.id, entry]));

export const SPRITE_BY_KEY = new Map(SPRITES.map((sprite) => [sprite.key, sprite]));

/** Entries that are actually obtainable right now. */
export const RELEASED_ENTRIES = ALL_ENTRIES.filter((entry) => entry.released);

export function entriesFor(includeUnreleased = false) {
  return includeUnreleased ? ALL_ENTRIES : RELEASED_ENTRIES;
}

export function isCustomId(id) {
  return typeof id === 'string' && id.startsWith(`${CUSTOM_PREFIX}.`);
}

/**
 * Entries grouped by base sprite, which is how the grid is laid out: one
 * heading per sprite, then its variants.
 */
export function groupsFor(includeUnreleased = false) {
  const groups = [];

  for (const sprite of SPRITES) {
    if (sprite.released === false && !includeUnreleased) continue;

    const entries = entriesFor(includeUnreleased).filter((entry) => entry.spriteKey === sprite.key);
    if (entries.length) groups.push({ sprite, entries });
  }

  return groups;
}

/**
 * Everything a search should match on: the displayed name, the patch-note
 * spelling, the sprite's power and where it is found. Lower-cased once at
 * module load rather than on every keystroke.
 */
const SEARCH_TEXT = new Map(
  ALL_ENTRIES.map((entry) => {
    const sprite = SPRITE_BY_KEY.get(entry.spriteKey);
    const aliases = (sprite.aliases || []).map((alias) =>
      entry.variant === 'base' ? alias : `${entry.variantLabel} ${alias}`,
    );
    return [
      entry.id,
      [entry.name, ...aliases, entry.rarity, entry.variantLabel, entry.power, entry.where]
        .join(' ')
        .toLowerCase(),
    ];
  }),
);

export function searchTextFor(id) {
  return SEARCH_TEXT.get(id) || '';
}

/** Squashes a name to a comparable key: "Gold Water Sprite" -> "goldwatersprite". */
export function nameKey(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/**
 * Every spelling of every entry, mapped to its id. Used to migrate the old
 * hand-typed names onto real catalog entries, so an upgrade keeps a list the
 * player already filled in rather than resetting it.
 *
 * Both "Gold Water Sprite" and "Gold Water" resolve, because people drop the
 * suffix when typing.
 */
export const NAME_INDEX = (() => {
  const index = new Map();

  const add = (name, id) => {
    const key = nameKey(name);
    if (!key || index.has(key)) return;
    index.set(key, id);
    if (key.endsWith('sprite')) {
      const bare = key.slice(0, -'sprite'.length);
      if (bare && !index.has(bare)) index.set(bare, id);
    }
  };

  for (const entry of ALL_ENTRIES) {
    add(entry.name, entry.id);

    const sprite = SPRITE_BY_KEY.get(entry.spriteKey);
    for (const alias of sprite.aliases || []) {
      add(entry.variant === 'base' ? alias : `${entry.variantLabel} ${alias}`, entry.id);
    }
  }

  return index;
})();

export function idForName(name) {
  return NAME_INDEX.get(nameKey(name)) || '';
}

/** Formats a drop chance for display; these span five orders of magnitude. */
export function formatDrop(drop) {
  if (!drop) return '—';
  if (drop >= 1) return `${drop}%`;
  if (drop >= 0.01) return `${drop}%`;
  // Zero Point's variants sit around 0.00001%; "1 in 7,000,000" is readable,
  // a string of leading zeroes is not.
  return `1 in ${Math.round(100 / drop).toLocaleString('en-US')}`;
}
