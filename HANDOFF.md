# Handoff — what's live and what's left

The app is **deployed and working**:

**<https://forknife67.julian-dice.workers.dev>**

It runs on Cloudflare Workers on the free plan. There is no droplet, no server
to patch, no certificate to renew and no monthly bill.

---

## State of play

| | |
| --- | --- |
| App built and tested | ✅ 39 unit/API + 20 Worker + 24 browser tests |
| Deployed | ✅ Worker + Durable Object, verified live |
| TLS | ✅ automatic, nothing to renew |
| CI (test on every push) | ✅ |
| Auto-deploy on merge to `main` | ✅ written, **inactive until you add one secret** |
| `forknife67.com` | ❌ still on Namecheap's nameservers |
| Custom domain on the Worker | ❌ blocked on the above |

**Cost: $0/mo** — the free plan allows 100,000 Worker requests and 100,000
Durable Object requests per day. A personal tracker uses a rounding error of it.

### Why it isn't on forknife67.com yet

Both steps need a browser session I can't open for you: adding the zone to
Cloudflare, and repointing the nameservers at Namecheap. Signing in is yours to
do — everything after it is scripted.

---

## 1. Point the domain at Cloudflare

1. Sign in at <https://dash.cloudflare.com> → **Add a site** → `forknife67.com`
   → **Free** plan
2. Skip the DNS "quick scan"; the custom domain below creates what it needs
3. It shows two nameservers, e.g. `dana.ns.cloudflare.com` and
   `rob.ns.cloudflare.com`. **Copy both — yours will be different.**
4. Namecheap → **Domain List** → `forknife67.com` → **Manage** →
   **Nameservers** → *Custom DNS* → paste both → green checkmark

Usually active within 5–30 minutes.

## 2. Attach it to the Worker

Once the zone shows **Active** in Cloudflare:

```bash
npx wrangler deploy    # after uncommenting the `routes` block in wrangler.jsonc
```

Or, without touching the config: Cloudflare dashboard → **Workers & Pages** →
`forknife67` → **Settings** → **Domains & Routes** → **Add** → *Custom domain*,
once for `forknife67.com` and once for `www.forknife67.com`. The DNS record and
certificate are created for you.

## 3. Check it worked

```bash
curl https://forknife67.com/api/health     # {"ok":true,"runtime":"workers"}
curl -I https://forknife67.com             # 200, HTTPS
```

Then on your phone: open it, **Add to Home Screen**, turn on airplane mode and
confirm it still opens and still records taps.

To test sync: **Menu → Create new vault** on your phone, then enter that code in
**Menu → Cloud sync** on your PC. Both should converge.

> A vault code is a password. Anyone who has it can read and change your list.

---

## 4. Turn on auto-deploy (optional)

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | `b2b9862e133f3e805a257d44e4cef752` |

Merges to `main` then run the tests and deploy. Until the secret exists the
deploy job skips cleanly, so merging is safe now.

---

## Living with it

```bash
npm run deploy                      # ship a change
npx wrangler tail                   # live logs
npx wrangler deployments list       # what's out there
npx wrangler rollback               # undo the last deploy
```

**Backups.** Every device holds a full copy, and **Menu → Backup → Export file**
writes a JSON file you can re-import anywhere. Server-side state is one Durable
Object per vault; SQLite-backed objects support point-in-time recovery.

**Things you may want to change**

- **Sprite names.** Slots are numbered 1–111; there's no authoritative name list
  baked in, deliberately. Rename individually, or paste a full list in
  **Menu → Names**.
- **The total.** **Menu → Total to find** when Epic adds more. Existing marks
  are kept, and the change syncs across devices.

`deploy/` still holds the original DigitalOcean droplet path, driving
`server/server.js` instead of the Worker. It is unused — kept only if you ever
want the app on your own box. Deleting `deploy/` and the shellcheck job in
`.github/workflows/ci.yml` would cost nothing.

How the app is built is in [`README.md`](README.md).
