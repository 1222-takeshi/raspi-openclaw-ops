# リリース手順

このリポジトリでは GitHub Releases を使って運用上のバージョンを管理します。

## 方針
- バージョニング: SemVer（例: v0.2.0）
- PR は Issue に紐づける（`Closes #...`）
- リリースノートは日本語

## 手順（例: v0.2.0）

1) `CHANGELOG.md` を更新
- vX.Y.Z のセクションを追加

2) `package.json` の version を更新

3) PR 作成 → レビュー → マージ

4) タグ&リリース作成（gh）

```bash
# main が最新であることを確認

gh release create vX.Y.Z \
  --repo 1222-takeshi/raspi-openclaw-ops \
  --title "vX.Y.Z" \
  --notes-file /tmp/release_notes.md
```

## リリースノート
- 基本は `CHANGELOG.md` の vX.Y.Z の内容を貼り付けます。
