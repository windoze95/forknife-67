# Deploying forknife 67 to forknife67.com

End state: the app on the cheapest DigitalOcean droplet ($4/mo), behind
Cloudflare, with HTTPS on `forknife67.com` and `www.` redirecting to it.

`deploy.sh` does everything except the two steps that genuinely require a
human in a browser (steps 1 and 2). It is idempotent — run it again any time to
ship new code.

---

## What you need

| Thing | Where to get it | Notes |
| --- | --- | --- |
| `DO_TOKEN` | DigitalOcean → API → **Generate New Token** | needs **read + write** |
| `CF_API_TOKEN` | Cloudflare → My Profile → API Tokens → **Create Token** | see permissions below |
| `ACME_EMAIL` | your email | Let's Encrypt expiry notices only |

The Cloudflare token needs, scoped to the `forknife67.com` zone:

- **Zone → Zone → Read**
- **Zone → DNS → Edit**
- **Zone → Zone Settings → Edit** (so the script can set TLS mode)

The same token is copied to the droplet for the DNS-01 certificate challenge,
which is why it should be zone-scoped rather than an account-wide key.

---

## Step 1 — Add the domain to Cloudflare (browser)

1. Cloudflare dashboard → **Add a site** → `forknife67.com` → **Free** plan.
2. Cloudflare shows two nameservers, e.g. `dana.ns.cloudflare.com` and
   `rob.ns.cloudflare.com`. **Copy both** — yours will differ.
3. Skip the "quick scan" import; the script creates the records it needs.

## Step 2 — Repoint the nameservers at Namecheap (browser)

Namecheap's API needs an allowlisted IP, a 20+ domain portfolio *or* $50
balance, so this one is a manual step.

1. Namecheap → **Domain List** → `forknife67.com` → **Manage**
2. **Nameservers** → change *Namecheap BasicDNS* to **Custom DNS**
3. Paste the two Cloudflare nameservers from step 1, then click the green
   checkmark to save.

Propagation is usually 5–30 minutes. Cloudflare emails you and the zone flips
to **Active**. You can start step 3 before it finishes — the script uses a
DNS-01 challenge through Cloudflare's API, so it does not wait on propagation.

## Step 3 — Run the deploy

```bash
export DO_TOKEN=dop_v1_...
export CF_API_TOKEN=...
export ACME_EMAIL=you@example.com

./deploy/deploy.sh
```

Roughly 4–6 minutes on a cold droplet, ~30 seconds on a redeploy. It will:

1. verify both tokens, and print the cheapest droplet size currently offered
   so you can confirm the default is still it
2. create an SSH deploy key (`~/.ssh/forknife67_deploy`) and register it
3. create the droplet, tagged `forknife67`, from `cloud-init.yaml`
4. wait for first-boot provisioning (Node 22, nginx, certbot, ufw, systemd)
5. point `forknife67.com` and `www.forknife67.com` at the droplet IP, proxied
6. set TLS to **Full (strict)**, force HTTPS, set min TLS 1.2
7. rsync the app and start `forknife67.service`
8. issue a Let's Encrypt cert via DNS-01 and install the TLS nginx config
9. curl the health endpoint at the origin *and* through the Cloudflare edge

---

## Why these choices

**Full (strict), not Flexible.** Flexible would encrypt browser→Cloudflare and
leave Cloudflare→droplet in plaintext. Strict means a real certificate on the
origin and Cloudflare verifying it.

**DNS-01, not HTTP-01.** HTTP-01 has to reach the droplet on port 80 through
the proxy, which fails while DNS is still propagating. DNS-01 uses the
Cloudflare API directly and works immediately.

**One canonical hostname.** `www` 301s to the apex. The app keeps its data in
`localStorage`, which is per-origin — if the app were reachable on two
hostnames, visiting the other one would look exactly like data loss.

**No database.** Sprite data lives in the browser. The server only stores
optional sync vaults as JSON files under `/var/lib/forknife67`, written
atomically.

---

## Operating it

```bash
IP=$(ssh-keygen -F forknife67.com >/dev/null; dig +short forknife67.com | head -1)

ssh -i ~/.ssh/forknife67_deploy root@$IP journalctl -u forknife67 -f   # logs
ssh -i ~/.ssh/forknife67_deploy root@$IP systemctl restart forknife67  # restart
./deploy/deploy.sh                                                     # redeploy
```

Note that `dig forknife67.com` returns a *Cloudflare* IP once proxying is on.
The real droplet IP is printed at the end of every deploy, and is in the
DigitalOcean control panel.

### Certificate renewal

certbot installs a systemd timer on the droplet and renews automatically. To
check: `certbot certificates` and `systemctl list-timers | grep certbot`.

### Backups

The only server state is `/var/lib/forknife67`:

```bash
ssh -i ~/.ssh/forknife67_deploy root@$IP tar czf - /var/lib/forknife67 > vaults-backup.tar.gz
```

Each device also has its own full copy, and **Menu → Backup → Export file**
writes a JSON file you can re-import anywhere.

### Tearing it down

```bash
curl -X DELETE -H "Authorization: Bearer $DO_TOKEN" \
  "https://api.digitalocean.com/v2/droplets?tag_name=forknife67"
```

---

## Cost

| Item | Monthly |
| --- | --- |
| Droplet `s-1vcpu-512mb-10gb` | $4.00 |
| Cloudflare Free | $0.00 |
| Let's Encrypt | $0.00 |
| Domain (Namecheap `.com`, amortised) | ~$1.20 |

The script prints DigitalOcean's current cheapest size at the start of every
run and warns if `s-1vcpu-512mb-10gb` is no longer it.

Optional but recommended: DigitalOcean → **Billing → Alerts**, set one at $10
so a mistake cannot run up a bill quietly.

---

## Troubleshooting

**`zone forknife67.com not found`** — step 1 is not done, or the token is
scoped to a different account.

**`cloud-init did not complete`** — first boot is still installing. Wait a
minute and re-run; if it persists:
`ssh root@$IP tail -50 /var/log/cloud-init-output.log`

**Cert issuance fails** — the token is missing **DNS → Edit**, or the zone is
not yet Active in Cloudflare. Check with:
`ssh root@$IP certbot certificates`

**Edge health check inconclusive but origin OK** — the app is up and DNS has
not propagated yet. Give it a few minutes; the origin check is the one that
tells you the deploy worked.

**Cloudflare 521/522** — nginx or the Node service is down on the origin:
`ssh root@$IP systemctl status forknife67 nginx`
