# トラブルシューティング

## 画面が変わらない / 最新が反映されない

1) どのバージョンが動いているか確認
- 画面上部の build 情報
- `/status.json` の `build`

2) systemd 再起動
```bash
sudo systemctl restart raspi-openclaw-ops
sudo systemctl status raspi-openclaw-ops --no-pager -l
```

3) デプロイ対象が main / tag か確認
```bash
cd ~/src/raspi-openclaw-ops
git status -sb
git describe --tags --always
```

## EADDRINUSE: address already in use

8080 を別プロセスが使っています。

```bash
sudo ss -ltnp | grep :8080
sudo lsof -i :8080
```

systemd 側を止める/ポート変更（`PORT=...`）で回避。

## 401 Unauthorized になる

トークン認証が有効です。

- URLに `?token=...`
- もしくは Header: `Authorization: Bearer ...`

systemd の envfile が更新されているか確認：
```bash
sudo systemctl show raspi-openclaw-ops -p EnvironmentFile
sudo systemctl cat raspi-openclaw-ops
```

## SQLite のエラー（DBディレクトリ/権限）

- デフォルト: `/opt/raspi-openclaw-ops/data/metrics.db`
- ディレクトリ権限を確認

```bash
ls -ld /opt/raspi-openclaw-ops /opt/raspi-openclaw-ops/data
ls -l /opt/raspi-openclaw-ops/data
```

## dmesg が読めない

環境によっては権限で読めません。
- `DMESG_SCAN_ENABLED=0` で無効化できます。
