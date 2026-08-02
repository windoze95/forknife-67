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

Node 22+, no dependencies to install.

```bash
npm start           # http://localhost:8080
npm test            # 38 unit + API tests
npm run icons       # regenerate the PWA icons
```

Browser end-to-end tests (23 checks, needs Chromium):

```bash
npm install --no-save playwright
npx playwright install chromium
node test/browser-smoke.mjs
```

Both suites plus a shellcheck pass over `deploy/` run in CI on every push.

## Deploying

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md). One script puts it on the cheapest
DigitalOcean droplet behind Cloudflare with TLS:

```bash
DO_TOKEN=... CF_API_TOKEN=... ACME_EMAIL=... ./deploy/deploy.sh   # full
DO_TOKEN=... APP_ONLY=1 ./deploy/deploy.sh                        # code only
```

It's idempotent, so it doubles as the redeploy path. Once the repository
secrets are set, merges to `main` deploy automatically via
`.github/workflows/deploy.yml` — tests first, code-only by default, with a
manual `full` mode for infrastructure changes.

## How it's built

No framework, no build step, no database. The whole app is static files plus a
~350 line Node server, which is why it runs comfortably on a 512 MB droplet.

```
public/
  index.html          app shell
  styles.css          all styling
  app.js              all behaviour
  lib/vault.js        data model + merge logic (shared with the server)
  sw.js               offline service worker
server/server.js      static files + sync API
deploy/               droplet, nginx, TLS, DNS
test/                 unit, API and browser tests
```

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

Server-side, a vault is one JSON file named `sha256(code)`, written atomically,
with writes to the same vault serialised so simultaneous syncs can't clobber
each other. The code itself is never written to disk or logged.

**A vault code is a password.** Anyone who has it can read and change your list.

## Licence

MIT
