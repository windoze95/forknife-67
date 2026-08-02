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

- **111 sprites** in a tappable grid (change the total in Menu when Epic adds more)
- **Three states**, cycled with a single tap:
  - **Needed** — not in your inventory
  - **Owned** — you have it, no crown in game, *invisible to you in game*
  - **Maxed ♛** — crowned in game
- **Hunting list** — flag the ones you're actively looking for; a sprite drops
  off the list automatically the moment you mark it found
- **Search** by number, name or note; **filter** by any state
- **Names and notes** per sprite, or paste a whole list to label all 111 at once
- **Undo** on every change, because a mis-tap on a 4-column grid happens
- **Works offline** — installable as a PWA, data lives on the device
- **Optional cloud sync** — one vault code, no account, no email
- Dark and light themes, compact grid mode

## Why "Owned" matters most

"Maxed" you can already see in game. The state this app exists for is **Owned** —
have it, not maxed, therefore indistinguishable in game from one you've never
found. Mark a sprite the moment you extract it and the guessing stops.

## Sprite names

Slots are numbered 1–111 out of the box, because there's no authoritative name
list baked in. Rename any sprite individually (long-press a tile), or paste a
whole list in **Menu → Names** to label all of them at once.

## Running it locally

Node 22+. The app itself has no runtime dependencies.

```bash
npm start           # http://localhost:8080 — plain Node, nothing to install
npm test            # 39 unit + API tests
npm run icons       # regenerate the PWA icons
```

To run the thing production actually runs:

```bash
npm install         # wrangler, the only devDependency
npm run dev:worker  # the Worker + Durable Object under workerd
npm run test:worker # 20 contract tests against a real `wrangler dev`
```

Browser end-to-end tests (24 checks, needs Chromium):

```bash
npm install --no-save playwright
npx playwright install chromium
node test/browser-smoke.mjs
```

`BASE_URL` points that suite at anything already running, which is how the
Worker gets the same 24 checks rather than a second suite that only rhymes
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

<details>
<summary>Self-hosting on a droplet instead</summary>

`deploy/` still holds the original DigitalOcean path — one script for a $4/mo
droplet with nginx, Let's Encrypt and Cloudflare DNS, driving `server/server.js`
rather than the Worker. See [`deploy/DEPLOY.md`](deploy/DEPLOY.md). It is kept
for anyone who wants the app on their own box; the Worker is what's deployed.

</details>

## How it's built

No framework, no build step, no database.

```
public/
  index.html          app shell
  styles.css          all styling
  app.js              all behaviour
  lib/vault.js        data model + merge logic — shared by all three runtimes
  sw.js               offline service worker
  _headers            security + cache headers for the edge-served assets
src/
  worker.js           the deployed sync API
  vault-object.js     one Durable Object per vault
server/server.js      the same API on plain Node, for local and LAN use
deploy/               optional droplet path (nginx, TLS, DNS)
test/                 unit, API, Worker and browser tests
```

`public/lib/vault.js` is imported by the browser, the Worker and the Node
server, so none of them can disagree about what a merge means. The two server
implementations are thin adapters over it, and both are held to the same
externally visible contract by their test suites.

### Data model

A sprite is `{id, name, status, hunting, notes, updatedAt}`. Untouched sprites
aren't stored at all, so a fresh install syncs a few hundred bytes.

Everything is kept in `localStorage` first — the app is fully functional with
the server switched off. Sync is strictly additive.

### Sync

Enter the same **vault code** on two devices and they converge. Merging is
per-sprite last-write-wins on `updatedAt`, so marking #14 on your phone and #92
on your PC keeps both edits — whole-document last-write-wins would silently
drop one. `public/lib/vault.js` is imported by both the browser and the server,
so the two can't disagree about what a merge means.

Server-side, a vault is one Durable Object addressed by `sha256(code)` — so the
code itself is never stored or logged — holding the document in SQLite. There is
exactly one single-threaded instance per vault, which is what stops two devices
syncing at the same instant from clobbering each other. (The Node server builds
the same guarantee by hand, with a promise-chain lock and atomic file writes.)

**A vault code is a password.** Anyone who has it can read and change your list.

## Licence

MIT
