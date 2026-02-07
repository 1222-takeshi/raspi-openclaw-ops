# raspi-clawdbot-ops

Raspberry Pi 上で動く Clawdbot の **運用(ops)** 用リポジトリ。

直近のゴールは、同一ネットワーク上の PC/スマホから、Clawdbot の状態を **ブラウザで見やすく確認**できるようにすることです。

## What it provides (v0)

- `GET /` : 人間向け HTML ステータスページ
- `GET /health.json` : 監視・通知向けの軽量 JSON
- `GET /status.json` : 詳細 JSON

現在の実装は以下を収集します：
- ホスト情報 (uptime / load / memory / IP)
- systemd サービス状態 (`CLAWDBOT_SERVICE` で指定)

## Quick start (dev)

```bash
npm install
npm run dev
# open http://<raspi-ip>:8080/
```

## Run (prod)

```bash
npm ci
npm run build
npm start
```

## Configuration

- `PORT` (default: 8080)
- `HOST` (default: 0.0.0.0)
- `CLAWDBOT_SERVICE` (default: `clawdbot-gateway`)

> `CLAWDBOT_SERVICE` は、raspi 側の systemd unit 名に合わせてください。

## Security note

LAN 内でも状況により情報が漏れるので、将来的に
- IP 制限
- トークン認証
- リバプロ(Nginx) + BasicAuth

などを入れる想定です。
