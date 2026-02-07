# Setup: run raspi-openclaw-ops with systemd

This project includes a sample unit file:
- `systemd/raspi-openclaw-ops.service`

## 1) Prepare directory

We assume you deploy to:
- `/opt/raspi-openclaw-ops`

Example:

```bash
sudo mkdir -p /opt/raspi-openclaw-ops
sudo chown -R $USER:$USER /opt/raspi-openclaw-ops
```

## 2) Install (recommended)

### Use install script

From your git working directory:

```bash
# optional: create a local config file
cp config/.env.example config/.env.local

# edit config/.env.local

# deploy + build + install systemd + (optional) create overrides
./scripts/install-systemd.sh
```

## 3) Manual (if needed)

```bash
cd /opt/raspi-openclaw-ops
npm ci --include=dev
npm run build

sudo cp systemd/raspi-openclaw-ops.service /etc/systemd/system/raspi-openclaw-ops.service
sudo systemctl daemon-reload
sudo systemctl enable --now raspi-openclaw-ops
```

Check status:

```bash
systemctl status raspi-openclaw-ops
journalctl -u raspi-openclaw-ops -f
```

## 4) Configure Clawdbot health check (optional)

### Option A: set via `config/.env.local` (recommended)

Edit `config/.env.local` and set:

```env
CLAWDBOT_PROCESS_PATTERNS=clawdbot-gateway,clawdbot
```

Then re-run:

```bash
./scripts/install-systemd.sh
```

You can also pass env vars inline:

```bash
CLAWDBOT_PROCESS_PATTERNS=clawdbot-gateway,clawdbot ./scripts/install-systemd.sh
```

### Option B: set a systemd drop-in manually

```bash
sudo systemctl edit raspi-openclaw-ops
```

Add:

```ini
[Service]
Environment=CLAWDBOT_PROCESS_PATTERNS=clawdbot-gateway,clawdbot
```

Reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart raspi-openclaw-ops
```

If Clawdbot is managed by systemd, you can instead set:

```ini
[Service]
Environment=CLAWDBOT_SERVICE=<unit-name>
```
