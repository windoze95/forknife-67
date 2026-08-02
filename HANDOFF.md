# Handoff — running the rest locally

Everything is on GitHub. Nothing is deployed. This is the linear list of what
to do from your own machine.

- **Branch:** `claude/fortnite-sprite-tracker-occ8em`
- **PR:** [#1](https://github.com/windoze95/forknife-67/pull/1) — draft, all CI checks green
- **Head commit:** `dff68ad`

---

## State of play

| | |
| --- | --- |
| App built and tested | ✅ 38 unit/API + 24 browser tests, all green in CI |
| Pushed to GitHub | ✅ 5 commits, working tree clean |
| CI (test on every push) | ✅ running and green |
| Auto-deploy workflow | ✅ written, **inactive until you add secrets** |
| DigitalOcean droplet | ❌ does not exist |
| Cloudflare zone / DNS | ❌ not set up |
| `forknife67.com` | ❌ still on Namecheap's nameservers, untouched |
| TLS certificate | ❌ not issued |

Nothing has been created on any account. No charges have been incurred.

**Why the deploy didn't happen:** the session that built this ran in an
ephemeral cloud container with no DigitalOcean or Cloudflare credentials and no
browser to authenticate one. Everything that *could* be done without those
credentials was done, including dry-running every data-handling step of
`deploy.sh` against sample API payloads and booting the exact file layout the
droplet will run.

---

## 0. Get the code

```bash
git clone https://github.com/windoze95/forknife-67.git
cd forknife-67
git checkout claude/fortnite-sprite-tracker-occ8em
```

Needs **Node 22+**. There are no dependencies to install.

---

## 1. Try it locally first (2 minutes)

Confirm you like the app before spending $4/mo on a droplet.

```bash
npm start          # http://localhost:8080
npm test           # 38 unit + API tests
```

Open it, tap some tiles, check the flow makes sense. Things to try:

- Tap a tile: **Needed → Owned → Maxed ♛ → Needed**
- Tap the small circle in a tile's corner to flag it as *hunting*; mark that
  sprite found and watch it drop off the hunting list by itself
- Long-press a tile for names and notes
- **Menu → Names** to paste a whole list of sprite names at once
- **Menu → Total to find** if the count is not 111 any more

Optional browser suite (downloads Chromium, ~100 MB):

```bash
npm install --no-save playwright
npx playwright install chromium
node test/browser-smoke.mjs
```

**If you decide not to deploy, you can stop here.** The app is fully usable
locally, and on your phone over your LAN at `http://<your-ip>:8080`. The server
is only needed for cross-device sync.

---

## 2. Create the two API tokens

**DigitalOcean** → API → Tokens → **Generate New Token**
- Scopes: **read + write**
- Copy it now; it is shown once

**Cloudflare** → My Profile → API Tokens → **Create Token** → *Create Custom Token*
- **Zone → Zone → Read**
- **Zone → DNS → Edit**
- **Zone → Zone Settings → Edit**
- Zone Resources: **Include → Specific zone → forknife67.com**

Zone-scoped, not account-wide: this token gets copied to the droplet so certbot
can answer the DNS-01 challenge.

---

## 3. Add the domain to Cloudflare (browser)

1. Cloudflare dashboard → **Add a site** → `forknife67.com` → **Free** plan
2. It shows you two nameservers, e.g. `dana.ns.cloudflare.com` and
   `rob.ns.cloudflare.com`. **Copy both — yours will be different.**
3. Skip the DNS "quick scan" import; the script creates what it needs

---

## 4. Repoint the nameservers at Namecheap (browser)

This one can't be scripted — Namecheap's API needs an allowlisted IP plus either
a $50 balance or 20+ domains.

1. Namecheap → **Domain List** → `forknife67.com` → **Manage**
2. **Nameservers** → change *Namecheap BasicDNS* to **Custom DNS**
3. Paste the two Cloudflare nameservers from step 3
4. Click the green checkmark to save

Usually active within 5–30 minutes. You do **not** have to wait before step 5 —
the deploy uses a DNS-01 challenge through Cloudflare's API, so it doesn't
depend on propagation.

---

## 5. Deploy

```bash
export DO_TOKEN=dop_v1_...
export CF_API_TOKEN=...
export ACME_EMAIL=you@example.com

./deploy/deploy.sh
```

4–6 minutes on a cold droplet. It will:

1. verify both tokens, and print DigitalOcean's cheapest current droplet size so
   you can confirm the default (`s-1vcpu-512mb-10gb`, $4/mo) is still it
2. generate an SSH deploy key at `~/.ssh/forknife67_deploy` and register it
3. create the droplet, tagged `forknife67`
4. wait for first boot (Node 22, nginx, certbot, ufw, systemd, unattended-upgrades)
5. point `forknife67.com` and `www.` at it, proxied
6. set TLS to **Full (strict)**, force HTTPS, min TLS 1.2
7. rsync the app and start the service
8. issue a Let's Encrypt cert via DNS-01, install the TLS nginx config
9. health-check both the origin directly and through the Cloudflare edge

It's idempotent — safe to re-run at any point if something goes wrong partway.

### If it fails partway

| Message | Cause | Fix |
| --- | --- | --- |
| `zone forknife67.com not found` | step 3 not done, or token is on a different account | finish step 3 |
| `cloud-init did not complete` | first boot still installing | wait a minute, re-run; else `ssh root@$IP tail -50 /var/log/cloud-init-output.log` |
| cert issuance fails | token missing **DNS → Edit**, or zone not Active yet | fix the token, re-run |
| `edge not answering yet` | DNS still propagating | not an error — the origin check is what matters |
| Cloudflare 521/522 | origin down | `ssh root@$IP systemctl status forknife67 nginx` |

---

## 6. Check it worked

```bash
curl https://forknife67.com/api/health          # {"ok":true,...}
curl -I https://forknife67.com                  # 200, HTTPS
curl -I https://www.forknife67.com              # 301 -> apex
```

Then on your phone: open `https://forknife67.com`, **Add to Home Screen**, turn
on airplane mode and confirm it still opens and still records taps.

To test sync: **Menu → Create new vault** on your phone, then enter that code in
**Menu → Cloud sync** on your PC. Both should converge.

> A vault code is a password. Anyone who has it can read and change your list.

---

## 7. Turn on auto-deploy (optional)

Once the droplet exists, merges to `main` can deploy themselves.

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `DO_TOKEN` | same DigitalOcean token |
| `DEPLOY_SSH_KEY` | `cat ~/.ssh/forknife67_deploy` — the **private** key, whole file including BEGIN/END lines |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan <droplet-ip>` — recommended, pins the host key |
| `CF_API_TOKEN` | only needed for manual `full` runs |
| `ACME_EMAIL` | only needed for manual `full` runs |

Pushes to `main` then ship code only (rsync + restart) after the tests pass.
DNS and TLS are deliberately left alone; to reconcile those, use
**Actions → Deploy → Run workflow → mode: full**.

Until those secrets exist the deploy job skips cleanly, so merging is safe now.

---

## 8. Merge the PR

PR #1 is a **draft**. Mark it ready and merge when you're happy. Everything
above works from the branch, so there's no rush.

---

## Living with it

```bash
IP=<droplet ip>                                    # printed by every deploy
ssh -i ~/.ssh/forknife67_deploy root@$IP journalctl -u forknife67 -f   # logs
ssh -i ~/.ssh/forknife67_deploy root@$IP systemctl restart forknife67  # restart
DO_TOKEN=... APP_ONLY=1 ./deploy/deploy.sh                             # ship code only
```

`dig forknife67.com` returns a *Cloudflare* IP once proxying is on — the real
droplet IP is printed at the end of each deploy and in the DO panel.

**Backups.** Server state is only `/var/lib/forknife67`:

```bash
ssh -i ~/.ssh/forknife67_deploy root@$IP tar czf - /var/lib/forknife67 > vaults-backup.tar.gz
```

Every device also holds a full copy, and **Menu → Backup → Export file** writes
a JSON file you can re-import anywhere.

**Cost:** $4.00/mo droplet + $0 Cloudflare + $0 Let's Encrypt + ~$1.20/mo
amortised domain. Worth setting a billing alert at $10 in DigitalOcean so a
mistake can't run up a bill quietly.

**Tear down:**

```bash
curl -X DELETE -H "Authorization: Bearer $DO_TOKEN" \
  "https://api.digitalocean.com/v2/droplets?tag_name=forknife67"
```

---

## Things you may want to change

- **Sprite names.** Slots are numbered 1–111; there's no authoritative name list
  baked in, deliberately. Rename individually, or paste a full list in
  **Menu → Names**.
- **The total.** **Menu → Total to find** when Epic adds more. Existing marks
  are kept, and the change syncs across devices.
- **Region.** Defaults to `nyc3`. `REGION=sfo3 ./deploy/deploy.sh` if you're
  closer to the west coast.

Deeper detail on any of the deploy machinery is in
[`deploy/DEPLOY.md`](deploy/DEPLOY.md); how the app is built is in
[`README.md`](README.md).
