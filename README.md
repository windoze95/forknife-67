# forknife 67

A sprite tracker for Fortnite.

In game there is no way to tell whether a sprite is already in your inventory —
unless it's **maxed**, in which case it wears a crown. Everything you own below
max level looks exactly like something you've never picked up. So you extract
duplicates, or skip ones you actually needed.

This is the missing list. One tap per sprite, works offline, syncs between your
phone and your PC.

![The grid on mobile](docs/screenshot-mobile.png)

## What it does

- **61 current-season sprites and variants, plus the 117-entry Runners collection**, named and pictured, grouped by base sprite,
  with each sprite's power, rarity and where it spawns
- **Three states**, cycled with a single tap:
  - **Needed** — not in your collection
  - **Owned** — extracted but not mastered, *invisible to you in game*
  - **Maxed ♛** — mastered, so it wears a crown
- **Hunting list** — flag the ones you're actively looking for; a sprite drops
  off the list automatically the moment you mark it found
- **Search** by name, by what a sprite does, or by where it spawns; **filter**
  by any state
- **Chest odds and summon cost** on every entry, so "hunt it or buy it with
  dust" is an answerable question
- **Undo** on every change, because a mis-tap happens
- **Installable** — add it to your home screen and it opens full screen, offline;
  iPhone gets the Share-sheet steps, since Safari never fires an install prompt
- **Optional cloud sync** — one vault code, no account, no email
- Follows your device's dark or light setting until you pick one yourself;
  compact grid mode

## Why "Owned" matters most

"Maxed" you can already see in game. The state this app exists for is **Owned** —
extracted, not mastered, therefore indistinguishable in game from one you've
never found. Mark a sprite the moment you extract it and the guessing stops.

## Where the sprite data comes from

`public/lib/catalog.js` contains **61 released Override entries across 16 families**,
plus **117 released Runners entries across 25 families** and the unreleased Gem
Punk. Verified against [Fortnite.GG's current-season roster](https://fortnite.gg/sprites)
on **10 September 2026, v42.10**, including that day's 14 Loot Hacker variants.
Crown's Loot Hacker was already available; Mega Man has only its base form.

The app opens on **C7 S4 · Override**. Use the **Season** selector to view
**C7 S3 · Runners** or **All seasons**. As explained in
[Epic's Override announcement](https://www.fortnite.com/news/fortnite-override-break-the-rules-change-the-game),
the previous collection lives on in Sprite Garden. Existing IDs, notes, ownership,
mastery and cloud sync records stay intact. The selector only changes what is
shown and counted; it never deletes progress. Custom entries remain available
in every view.

Names, rarity, abilities and artwork follow the game-file mirror. Search also
accepts alternate spellings such as Grim Reaper, Lootin' Llama, Cheat Master
X-Ray and Loot Hacker Bush. Override detail pages currently show placeholder
zeroes for costs and chest odds: the app shows unknown values instead of
borrowing Runners' summon costs or claiming free summons.

### Keeping it current

The previous daily job checked only an outdated IGN page. A matching old page,
an empty parse, or unavailable sources could all produce a green run. The new
`.github/workflows/catalog-drift.yml` checks two kinds of evidence:

- The current game build from [Fortnite-API](https://fortnite-api.com/v2/aes),
  independently of any checklist. A new patch requires catalog review.
- The [current-season roster](https://spritechecklist.org/sprites/) and every
  family's variant table, including upcoming rows. Names with digits, hyphens,
  and multiword variant labels are preserved. Declared family/release counts
  must reconcile, and all current catalog entries must be covered.

A missing, blocked, empty or partially parsed source fails the job and updates
one `catalog-drift` issue. A new patch, season, name or release also requires
review. Reports are saved as workflow artifacts and in the run summary; repeat
runs update the issue instead of adding daily comments. Run locally with:

```bash
node tools/check-catalog-drift.js
node tools/check-catalog-drift.js --json
```

Both formats exit **0** when checked, **1** when review is needed, or **2** when
coverage is incomplete. Same-patch hotfix detection still depends on community
updates, so verification older than **14 days** also requires review. The
checker never publishes source data automatically or changes release states
based on a lagging checklist.

To update: verify the live roster, edit the catalog and artwork mapping, run
`node tools/fetch-sprite-art.js`, refresh the verified patch/date and pinned
counts, bump the app/service-worker version, and run unit, Worker and browser
checks. Regression fixtures preserve the actual 10 September index and variant
table markup, including the source's lagging "Upcoming" labels for Loot Hackers.

Artwork is Epic's, mirrored by Fortnite.GG and committed under `public/sprites/`.
All **179** images are resized to 96px and total about **372 KB**. The catalog
and artwork ship with the app so they do not depend on live third-party fetches.

## Running it locally

Node 22+. The app itself has no runtime dependencies.

```bash
npm start           # http://localhost:8080 — plain Node, nothing to install
npm test            # unit, catalog, drift + API tests
npm run icons       # regenerate the PWA icons
```

To run the thing production actually runs:

```bash
npm install         # wrangler, the only devDependency
npm run dev:worker  # the Worker + Durable Object under workerd
npm run test:worker # 21 contract tests against a real `wrangler dev`
```

Browser end-to-end tests (43 checks, needs Chromium):

```bash
npm install --no-save playwright
npx playwright install chromium
node test/browser-smoke.mjs
```

`BASE_URL` points that suite at anything already running, which is how the
Worker gets the same 43 checks rather than a second suite that only rhymes
with them:

```bash
npm run dev:worker &
BASE_URL=http://127.0.0.1:8787 node test/browser-smoke.mjs
```

All of it runs in CI on every push.

## Deploying

It runs on **Cloudflare Workers**, on the free plan:

```bash
npm run deploy
```

Static files are served straight from the edge without spending a Worker
invocation; only `/api/*` runs the script. Once `CLOUDFLARE_API_TOKEN` is set as
a repository secret, merges to `main` deploy themselves via
`.github/workflows/deploy.yml` — tests first.

There is no server to patch, no certificate to renew, and no bill. The free
plan allows 100,000 Worker requests and 100,000 Durable Object requests per
day; a personal tracker uses a rounding error of that.

To host it yourself instead, `server/server.js` is a complete standalone
server — `npm start` behind any reverse proxy, no Cloudflare involved.

## How it's built

No framework, no build step, no database.

```
public/
  index.html          app shell
  styles.css          all styling
  app.js              all behaviour
  lib/vault.js        data model + merge logic — shared by all three runtimes
  lib/catalog.js      every sprite, variant and stat, read from the game files
  sprites/            Epic artwork, one 96px webp per entry id
  sw.js               offline service worker
  _headers            security + cache headers for the edge-served assets
src/
  worker.js           the deployed sync API
  vault-object.js     one Durable Object per vault
server/server.js      the same API on plain Node, for local and LAN use
tools/                icon generation, artwork fetch, catalog drift check
test/                 unit, catalog, drift, API, Worker and browser tests
```

`public/lib/vault.js` is imported by the browser, the Worker and the Node
server, so none of them can disagree about what a merge means. The two server
implementations are thin adapters over it, and both are held to the same
externally visible contract by their test suites.

### Data model

An entry is `{id, name, status, hunting, notes, updatedAt}`, keyed by a catalog
id: `water`, `water.gold`, `custom.3`. Ids come from the sprite's key rather
than its position in the list, which is what lets the catalog grow with the
game without disturbing anything already recorded. Untouched entries aren't
stored at all, so a fresh install syncs a few hundred bytes.

The vault validates the *shape* of an id, not membership of the catalog. A
phone that hasn't picked up the latest deploy stores and syncs an entry it has
never heard of untouched, rather than deleting progress made on a device that
has.

Everything is kept in `localStorage` first — the app is fully functional with
the server switched off. Sync is strictly additive.

### Sync

Enter the same **vault code** on two devices and they converge. Merging is
per-entry last-write-wins on `updatedAt`, so marking Gold Water on your phone
and Grim on your PC keeps both edits — whole-document last-write-wins would
silently drop one. `public/lib/vault.js` is imported by both the browser and
the server, so the two can't disagree about what a merge means.

Server-side, a vault is one Durable Object addressed by `sha256(code)` — so the
code itself is never stored or logged — holding the document in SQLite. There is
exactly one single-threaded instance per vault, which is what stops two devices
syncing at the same instant from clobbering each other. (The Node server builds
the same guarantee by hand, with a promise-chain lock and atomic file writes.)

**A vault code is a password.** Anyone who has it can read and change your list.

## Licence

MIT
