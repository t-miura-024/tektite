# PR を挟まずデフォルトブランチへ直接コミットする

Web 上での編集は Vault リポジトリのデフォルトブランチへ直接コミットする。個人 Vault にとって PR フローは 1 ノートの編集ごとに摩擦を生むだけで、obsidian-git のように履歴がリポジトリの git log に自然に混ざることを重視した。

## Consequences

- 競合によるデータ損失は、Contents API の sha チェックによる楽観ロック + Conflict UI で防ぐ
- 複数ファイルの一括変更（リンク張り替え等）は Git Trees/Blobs API で 1 コミットに束ねる
