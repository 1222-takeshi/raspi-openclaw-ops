# デプロイ手順

このプロジェクトは `scripts/install-systemd.sh` を用いて `/opt/raspi-openclaw-ops` へデプロイし、systemd で常駐させます。

## 前提
- raspi に Node.js (>=22)
- systemd

## 初回セットアップ

```bash
# 作業ディレクトリ（git管理）
mkdir -p ~/src
cd ~/src
git clone https://github.com/1222-takeshi/raspi-openclaw-ops.git
cd raspi-openclaw-ops

# ローカル設定（gitignore）
cp -n config/.env.example config/.env.local
nano config/.env.local

# デプロイ
./scripts/install-systemd.sh
```

## リリース（タグ）を指定してデプロイ

```bash
cd ~/src/raspi-openclaw-ops
git fetch --tags
git checkout v0.2.0
./scripts/install-systemd.sh
```

## 更新（main）

```bash
cd ~/src/raspi-openclaw-ops
git checkout main
git pull
./scripts/install-systemd.sh
```

## ロールバック

```bash
cd ~/src/raspi-openclaw-ops
git fetch --tags
git checkout v0.2.0   # 戻したいタグ
./scripts/install-systemd.sh
```

## 確認

```bash
systemctl status raspi-openclaw-ops
journalctl -u raspi-openclaw-ops -f

# token を使う場合
curl -i "http://127.0.0.1:8080/health.json?token=YOUR_TOKEN"
```
