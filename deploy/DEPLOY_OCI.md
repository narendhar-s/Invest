# Deploying on Oracle Cloud (OCI) — single VM + Docker Compose

This runs the whole stack (Postgres + Go server + both SPAs) on one Always-Free
Arm VM, behind Caddy with automatic HTTPS, reachable from anywhere at your domain.

Things only **you** can do (I can't, and shouldn't, do these for you): create the
OCI account, generate/enter any credentials, and change cloud security settings.
Everything below tells you exactly what to click and run.

---

## 0. What you'll end up with

```
Internet ──HTTPS──> Caddy (:443) ──> app (:8080) ──> Postgres
                     (auto TLS)        Go server + both SPAs
```

App URLs once live: `https://YOUR_DOMAIN/` (Invest) and `https://YOUR_DOMAIN/naren/challenge`.

---

## 1. Create the VM (OCI console)

1. Sign in to the OCI console → **Compute → Instances → Create instance**.
2. Image & shape: **Canonical Ubuntu 22.04**, shape **VM.Standard.A1.Flex**
   (Ampere/Arm — Always-Free eligible). 2–4 OCPU / 12–24 GB RAM is plenty.
3. Add your **SSH public key** (so you can log in).
4. Networking: let it create a VCN + public subnet, and **assign a public IPv4**.
5. Create. Note the **public IP**.

## 2. Open the firewall (two layers)

OCI blocks inbound traffic by default in **two** places — both must allow 80/443.

1. **Security List / NSG** (console → your VCN → Security Lists): add **Ingress**
   rules, source `0.0.0.0/0`, TCP ports **80** and **443**.
2. **OS firewall** (on the VM, Ubuntu uses iptables by default on OCI images):
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

## 3. Point your domain at the VM

Create a DNS **A record**: `trade.example.com → <VM public IP>`. (Caddy needs this
resolvable before it can issue a certificate.) If you don't have a domain yet,
you can test over plain HTTP by IP first, but HTTPS needs a real hostname.

## 4. Install Docker on the VM

```bash
ssh ubuntu@<VM public IP>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu      # log out/in afterward so `docker` works without sudo
```

## 5. Get the code and set secrets

```bash
git clone <your repo url> invest && cd invest

# Edit the two config files on the VM (kept off the image, mounted at runtime):
#  - config.yaml          → Invest-side settings, server port 8080
#  - config.naren.yaml    → Kite api_key/secret, live_trading_enabled,
#                           and the telegram: block (see §7)
nano config.naren.yaml

# The daily Zerodha token file must exist for the bind-mount:
touch kite_token.json
```

## 6. Launch

```bash
export DOMAIN=trade.example.com
export POSTGRES_PASSWORD='pick-a-strong-password'
docker compose -f docker-compose.oci.yml up -d --build
```

First build takes a few minutes (it compiles both SPAs + the Go binary). Then:

```bash
docker compose -f docker-compose.oci.yml ps        # all healthy?
docker compose -f docker-compose.oci.yml logs -f app
```

Visit `https://trade.example.com/naren/challenge`. Caddy fetches the TLS cert
automatically on first request.

## 7. Connect Zerodha and (optionally) Telegram

- **Zerodha login** is still per-day. Open `https://trade.example.com/api/v1/zerodha/callback`
  flow via the app's Kite login, or set `zerodha_user_id/password/totp_secret`
  under `kite:` in `config.naren.yaml` for the 8:30 AM auto-login.
- **Telegram** (see §8 below): fill the `telegram:` block, then
  `docker compose -f docker-compose.oci.yml restart app`.

## 8. Updating

```bash
git pull
docker compose -f docker-compose.oci.yml up -d --build
```

## 9. Backups (do this)

The only stateful piece is Postgres:
```bash
docker exec stockwise_postgres pg_dump -U stockwise stockwise_db > backup_$(date +%F).sql
```

---

## Security notes

- `config.yaml` / `config.naren.yaml` hold real API keys — keep the repo private
  and the VM locked down (key-only SSH, no password login).
- `live_trading_enabled: true` allows REAL orders. Leave it `false` until you
  explicitly want live trading; the per-challenge toggle and (for Telegram) the
  `/confirm` step are additional gates.
- Restrict the Telegram bot to your own numeric chat id in `allowed_chat_ids`.
