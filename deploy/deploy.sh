#!/usr/bin/env bash
#
# One-command deploy: DigitalOcean droplet + Cloudflare DNS + TLS.
#
# Idempotent — re-running reuses the existing droplet and DNS records and just
# ships the current code.
#
# Required environment:
#   DO_TOKEN        DigitalOcean API token, read+write
#   CF_API_TOKEN    Cloudflare token with Zone:Read + DNS:Edit on the zone
#   ACME_EMAIL      email for Let's Encrypt expiry notices
#
# Optional:
#   DOMAIN          default forknife67.com
#   REGION          default nyc3
#   SIZE            default s-1vcpu-512mb-10gb (the cheapest droplet, $4/mo)
#   SSH_KEY         path to a private key; a deploy key is generated if unset
#
# Prerequisite done in the Namecheap UI (no scriptable API without an
# allowlisted IP and account balance): point the domain at Cloudflare's
# nameservers. See DEPLOY.md.

set -euo pipefail

DOMAIN="${DOMAIN:-forknife67.com}"
REGION="${REGION:-nyc3}"
SIZE="${SIZE:-s-1vcpu-512mb-10gb}"
IMAGE="${IMAGE:-ubuntu-24-04-x64}"
DROPLET_NAME="${DROPLET_NAME:-forknife67}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/forknife67_deploy}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DO_API="https://api.digitalocean.com/v2"
CF_API="https://api.cloudflare.com/client/v4"

log()  { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Read a dotted path out of JSON on stdin, without requiring jq.
# Prints nothing (rather than failing) when the path is absent, so callers can
# use `[ -z "$x" ]` to mean "not there".
jget() {
  python3 -c '
import sys, json

try:
    node = json.load(sys.stdin)
except Exception:
    sys.exit(0)

for key in sys.argv[1].split("."):
    if not key:
        continue
    try:
        node = node[int(key)] if key.lstrip("-").isdigit() else node[key]
    except (KeyError, IndexError, TypeError):
        sys.exit(0)

if node is not None:
    print(node)
' "$1"
}

# APP_ONLY=1 ships code to an existing droplet and nothing else — no droplet
# creation, no DNS changes, no certificate work. This is what CI runs on every
# merge to main: a redeploy has no business rewriting DNS or touching TLS.
APP_ONLY="${APP_ONLY:-0}"

required_vars="DO_TOKEN"
[ "$APP_ONLY" = "1" ] || required_vars="$required_vars CF_API_TOKEN ACME_EMAIL"

for var in $required_vars; do
  [ -n "${!var:-}" ] || die "$var is not set. See the header of this script."
done
command -v python3 >/dev/null || die "python3 is required"
command -v ssh     >/dev/null || die "ssh is required"

do_api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$DO_API$path" \
      -H "Authorization: Bearer $DO_TOKEN" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "$DO_API$path" -H "Authorization: Bearer $DO_TOKEN"
  fi
}

cf_api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$CF_API$path" \
      -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "$CF_API$path" -H "Authorization: Bearer $CF_API_TOKEN"
  fi
}

# ---------------------------------------------------------------------------
log "Checking credentials"

acct="$(do_api GET /account)"
echo "$acct" | grep -q '"account"' || die "DigitalOcean token rejected: $acct"
info "DigitalOcean: $(echo "$acct" | jget "account.email")"

if [ "$APP_ONLY" = "1" ]; then
  info "APP_ONLY — skipping Cloudflare, DNS and TLS steps"
else
  cf_ok="$(cf_api GET /user/tokens/verify | jget "success")"
  [ "$cf_ok" = "True" ] || die "Cloudflare token rejected"
  info "Cloudflare: token valid"

  # -------------------------------------------------------------------------
  log "Confirming $SIZE is still the cheapest droplet"

  cheapest="$(do_api GET '/sizes?per_page=200' | python3 -c '
import sys, json
sizes = [s for s in json.load(sys.stdin).get("sizes", []) if s.get("available")]
sizes.sort(key=lambda s: s["price_monthly"])
if sizes:
    print(sizes[0]["slug"], "$" + str(sizes[0]["price_monthly"]) + "/mo")
')"
  info "cheapest available: $cheapest"
  info "using:             $SIZE"
  case "$cheapest" in
    "$SIZE "*) ;;
    *) info "NOTE: $SIZE is not the cheapest right now — override with SIZE=..." ;;
  esac
fi

# ---------------------------------------------------------------------------
log "Ensuring an SSH deploy key exists"

if [ ! -f "$SSH_KEY" ]; then
  # Generating a fresh key in APP_ONLY mode would be useless: the public key is
  # only injected into a droplet at creation time, so a new key cannot log in.
  [ "$APP_ONLY" = "1" ] && die "APP_ONLY needs an existing key at $SSH_KEY (set SSH_KEY, or supply it from CI secrets)"

  mkdir -p "$(dirname "$SSH_KEY")"
  ssh-keygen -t ed25519 -N '' -C "forknife67-deploy" -f "$SSH_KEY" >/dev/null
  info "generated $SSH_KEY"
else
  info "reusing $SSH_KEY"
fi

pubkey="$(cat "$SSH_KEY.pub")"
fingerprint="$(ssh-keygen -lf "$SSH_KEY.pub" -E md5 | awk '{print $2}' | sed 's/^MD5://')"

if ! do_api GET /account/keys | grep -q "$fingerprint"; then
  do_api POST /account/keys "$(python3 -c '
import json,sys
print(json.dumps({"name": "forknife67-deploy", "public_key": sys.argv[1]}))' "$pubkey")" >/dev/null
  info "uploaded key to DigitalOcean"
fi

# ---------------------------------------------------------------------------
log "Ensuring the droplet exists"

existing="$(do_api GET "/droplets?tag_name=forknife67")"
droplet_id="$(echo "$existing" | jget "droplets.0.id")"

if [ -z "$droplet_id" ] && [ "$APP_ONLY" = "1" ]; then
  die "no droplet tagged 'forknife67' — run a full deploy first (without APP_ONLY)"
fi

if [ -z "$droplet_id" ]; then
  info "creating $DROPLET_NAME ($SIZE, $REGION)…"
  payload="$(python3 -c '
import json, sys
print(json.dumps({
    "name": sys.argv[1], "region": sys.argv[2], "size": sys.argv[3], "image": sys.argv[4],
    "ssh_keys": [sys.argv[5]], "tags": ["forknife67"], "monitoring": True,
    "user_data": open(sys.argv[6]).read(),
}))' "$DROPLET_NAME" "$REGION" "$SIZE" "$IMAGE" "$fingerprint" "$REPO_ROOT/deploy/cloud-init.yaml")"

  created="$(do_api POST /droplets "$payload")"
  droplet_id="$(echo "$created" | jget "droplet.id")"
  [ -n "$droplet_id" ] || die "droplet creation failed: $created"
  info "droplet id $droplet_id"
else
  info "reusing droplet id $droplet_id"
fi

log "Waiting for a public IP"
ip=""
for _ in $(seq 1 60); do
  ip="$(do_api GET "/droplets/$droplet_id" | python3 -c '
import sys, json
d = json.load(sys.stdin)["droplet"]["networks"]["v4"]
print(next((n["ip_address"] for n in d if n["type"] == "public"), ""))
' 2>/dev/null || true)"
  [ -n "$ip" ] && break
  sleep 5
done
[ -n "$ip" ] || die "droplet never got a public IP"
info "IP: $ip"

# ---------------------------------------------------------------------------
if [ "$APP_ONLY" != "1" ]; then

log "Pointing $DOMAIN at $ip in Cloudflare"

zone_id="$(cf_api GET "/zones?name=$DOMAIN" | jget "result.0.id")"
[ -n "$zone_id" ] || die "zone $DOMAIN not found in this Cloudflare account — add the site first (DEPLOY.md step 1)"
info "zone $zone_id"

upsert_record() {
  local name="$1"
  local rec_id
  rec_id="$(cf_api GET "/zones/$zone_id/dns_records?type=A&name=$name" | jget "result.0.id")"
  local body
  body="$(python3 -c '
import json, sys
print(json.dumps({"type": "A", "name": sys.argv[1], "content": sys.argv[2],
                  "ttl": 1, "proxied": True}))' "$name" "$ip")"

  if [ -n "$rec_id" ]; then
    cf_api PUT "/zones/$zone_id/dns_records/$rec_id" "$body" >/dev/null
    info "updated A $name -> $ip (proxied)"
  else
    cf_api POST "/zones/$zone_id/dns_records" "$body" >/dev/null
    info "created A $name -> $ip (proxied)"
  fi
}

upsert_record "$DOMAIN"
upsert_record "www.$DOMAIN"

log "Setting TLS mode to Full (strict) and forcing HTTPS"
# Full (strict) is the only mode that actually verifies the origin certificate;
# "Flexible" would leave Cloudflare->droplet traffic in plaintext.
cf_api PATCH "/zones/$zone_id/settings/ssl" '{"value":"strict"}' >/dev/null && info "SSL mode: Full (strict)"
cf_api PATCH "/zones/$zone_id/settings/always_use_https" '{"value":"on"}' >/dev/null && info "Always Use HTTPS: on"
cf_api PATCH "/zones/$zone_id/settings/min_tls_version" '{"value":"1.2"}' >/dev/null && info "Min TLS: 1.2"
cf_api PATCH "/zones/$zone_id/settings/automatic_https_rewrites" '{"value":"on"}' >/dev/null || true
cf_api PATCH "/zones/$zone_id/settings/brotli" '{"value":"on"}' >/dev/null || true

fi  # end of DNS/TLS provisioning

# ---------------------------------------------------------------------------
log "Waiting for SSH"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts_forknife" -o ConnectTimeout=10)
for _ in $(seq 1 60); do
  ssh "${SSH_OPTS[@]}" "root@$ip" true 2>/dev/null && break
  sleep 5
done
ssh "${SSH_OPTS[@]}" "root@$ip" true 2>/dev/null || die "could not SSH to $ip"
info "connected"

if [ "$APP_ONLY" != "1" ]; then
  log "Waiting for first-boot provisioning to finish"
  ssh "${SSH_OPTS[@]}" "root@$ip" 'cloud-init status --wait >/dev/null 2>&1 || true; test -f /var/lib/cloud/forknife-ready' \
    || die "cloud-init did not complete — check /var/log/cloud-init-output.log on the droplet"
  info "provisioned"
fi

# ---------------------------------------------------------------------------
log "Shipping the app"

ssh "${SSH_OPTS[@]}" "root@$ip" 'mkdir -p /opt/forknife67/app'
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude 'deploy' --exclude 'test' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$REPO_ROOT/" "root@$ip:/opt/forknife67/app/"

ssh "${SSH_OPTS[@]}" "root@$ip" 'chown -R root:root /opt/forknife67/app && systemctl restart forknife67'
sleep 2
ssh "${SSH_OPTS[@]}" "root@$ip" 'systemctl is-active --quiet forknife67' \
  || die "service failed to start — run: ssh root@$ip journalctl -u forknife67 -n 50"
info "forknife67.service is running"

# ---------------------------------------------------------------------------
if [ "$APP_ONLY" != "1" ]; then

log "Issuing the TLS certificate (DNS-01 via Cloudflare)"

# DNS-01 rather than HTTP-01: it works regardless of proxy state and does not
# depend on the A record having propagated yet.
# The token is a local variable, so this heredoc must expand on THIS machine
# and be piped over — a quoted delimiter would ship the literal string.
# The file is created 0600 before anything is written into it.
# shellcheck disable=SC2087
ssh "${SSH_OPTS[@]}" "root@$ip" "install -m 600 /dev/null /root/.cloudflare.ini && cat > /root/.cloudflare.ini" <<EOF
dns_cloudflare_api_token = $CF_API_TOKEN
EOF

ssh "${SSH_OPTS[@]}" "root@$ip" "
  set -e
  if [ ! -d /etc/letsencrypt/live/$DOMAIN ]; then
    certbot certonly --non-interactive --agree-tos --email '$ACME_EMAIL' \
      --dns-cloudflare --dns-cloudflare-credentials /root/.cloudflare.ini \
      --dns-cloudflare-propagation-seconds 30 \
      -d '$DOMAIN' -d 'www.$DOMAIN'
  else
    echo 'certificate already present'
  fi
"
info "certificate in place"

log "Installing the TLS nginx config"
sed "s/__DOMAIN__/$DOMAIN/g" "$REPO_ROOT/deploy/nginx-tls.conf.template" \
  | ssh "${SSH_OPTS[@]}" "root@$ip" 'cat > /etc/nginx/sites-available/forknife67'

ssh "${SSH_OPTS[@]}" "root@$ip" '
  set -e
  test -f /etc/letsencrypt/options-ssl-nginx.conf || curl -fsSL -o /etc/letsencrypt/options-ssl-nginx.conf https://raw.githubusercontent.com/certbot/certbot/main/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf
  test -f /etc/letsencrypt/ssl-dhparams.pem || openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
  nginx -t && systemctl reload nginx
'
info "nginx reloaded with TLS"

fi  # end of TLS provisioning

# ---------------------------------------------------------------------------
log "Verifying"

sleep 3
origin_health="$(curl -sS --max-time 20 --resolve "$DOMAIN:443:$ip" "https://$DOMAIN/api/health" || true)"
echo "$origin_health" | grep -q '"ok":true' \
  && info "origin  https://$DOMAIN/api/health  OK" \
  || info "origin health check inconclusive: $origin_health"

edge_health="$(curl -sS --max-time 20 "https://$DOMAIN/api/health" || true)"
if echo "$edge_health" | grep -q '"ok":true'; then
  info "edge    https://$DOMAIN/api/health  OK"
else
  info "edge not answering yet — DNS may still be propagating. Response: $edge_health"
fi

cat <<EOF

  Droplet   $DROPLET_NAME  $ip
  App       https://$DOMAIN
  SSH       ssh -i $SSH_KEY root@$ip
  Logs      ssh -i $SSH_KEY root@$ip journalctl -u forknife67 -f
  Redeploy  DOMAIN=$DOMAIN ./deploy/deploy.sh          (full)
            DOMAIN=$DOMAIN APP_ONLY=1 ./deploy/deploy.sh  (code only)

EOF
