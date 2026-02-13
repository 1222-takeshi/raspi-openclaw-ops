# 運用（Operations）

## 日常チェック

- サービス状態

```bash
systemctl status raspi-openclaw-ops
journalctl -u raspi-openclaw-ops -n 100 --no-pager
```

- ヘルス確認

```bash
curl -i "http://127.0.0.1:8080/health.json?token=YOUR_TOKEN"
```

## 設定（config/.env.local）

ローカル設定は `config/.env.local` にまとめます（gitignore）。

主な項目：
- `STATUS_TOKEN`：トークン認証
- `CLAWDBOT_PROCESS_PATTERNS`：監視対象プロセス
- `METRICS_DB_PATH`：SQLite保存先
- `METRICS_RAW_RETENTION_HOURS` / `METRICS_1M_RETENTION_DAYS`：保持期間
- `CPU_TEMP_WARN_C` / `DISK_USED_WARN_PCT` / `INODE_USED_WARN_PCT`：しきい値
- `DMESG_SCAN_ENABLED` / `DMESG_MAX_LINES`：dmesgスキャン

## データ（SQLite）

- デフォルト: `/opt/raspi-openclaw-ops/data/metrics.db`
- raw（高頻度）と 1m（ロールアップ）を保持し、一定間隔で prune します。

## バージョン確認

画面上部と `/status.json` に build 情報（version/ref/sha/time）が出ます。
「反映されてない？」と思ったらここを見るのが最速です。
