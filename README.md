# raspi-openclaw-ops

Raspberry Pi 上で動く OpenClaw/Clawdbot の **運用(ops)** 用リポジトリ。

直近のゴールは、同一ネットワーク上の PC/スマホから、Clawdbot の状態を **ブラウザで見やすく確認**できるようにすることです。

## What it provides (v0)

- `GET /` : 人間向け HTML ステータスページ
- `GET /health.json` : 監視・通知向けの軽量 JSON
- `GET /status.json` : 詳細 JSON

現在の実装は以下を収集します：
- ホスト情報 (uptime / load / memory / CPU温度 / ディスク使用率 / IP)
- （任意）systemd サービス状態（`CLAWDBOT_SERVICE` を設定した場合）

## Quick start (dev)

```bash
npm install
npm run dev
# open http://<raspi-ip>:8080/
```

## Run (prod)

### Option A: systemd (recommended)

See:
- `docs/SETUP_SYSTEMD.md`
- `docs/DEPLOY.md`
- `docs/OPERATIONS.md`
- `docs/TROUBLESHOOTING.md`

### Option B: manual

```bash
npm ci --include=dev
npm run build
npm start
```

## Configuration

- `PORT` (default: 8080)
- `HOST` (default: 0.0.0.0)
- `CLAWDBOT_SERVICE` (optional)
- `CLAWDBOT_PROCESS_PATTERNS` (optional, comma-separated)

> `CLAWDBOT_SERVICE` を設定すると systemd unit の `is-active` を表示し、inactive の場合は Health を `DEGRADED` にします。
> systemd 管理していない場合は `CLAWDBOT_PROCESS_PATTERNS` を設定して `pgrep -f` でプロセス存在チェックします。
>
> 例（process check / `clawdbot` と `clawdbot-gateway` を監視）:
>
> ```bash
> CLAWDBOT_PROCESS_PATTERNS=clawdbot-gateway,clawdbot npm run dev
> ```

## Security note

LAN 内でも状況により情報が漏れるので、将来的に
- IP 制限
- トークン認証
- リバプロ(Nginx) + BasicAuth

などを入れる想定です。
