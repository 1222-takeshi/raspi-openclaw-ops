# Changelog

このプロジェクトの変更履歴。

## v0.2.0 (2026-02-08)

### 追加
- ステータスページ（HTML） + JSON エンドポイント（/health.json, /status.json）
- CPU 使用率（瞬間値 + avg10s）、CPU 温度、ディスク使用率、メモリ使用率の表示
- Summary / Metrics タブ切り替え + CPU usage グラフ（メモリ内履歴）
- トークン認証（STATUS_TOKEN）
- systemd インストール/デプロイ用スクリプト（.env.local 読み込み、EnvironmentFile 反映、restart/検証）
- TDD 方針の明文化（CLAUDE.md） + テスト基盤（Vitest）

### 変更
- 表示時刻を JST（Asia/Tokyo）に変更（TIME_ZONE で上書き可能）

### 注意
- 履歴グラフのデータはメモリ内のみ（再起動で消えます）
