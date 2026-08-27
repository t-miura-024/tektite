# ファイル行数のts/tsx別閾値

ファイル行数制限を `ts 300行 / tsx 400行`（テスト `*.test.*` 除外）とし、tsxはJSXの冗長性を考慮して余裕を持たせる。現状 `ts 12件 / tsx 3件`（`VaultScreen.tsx:1102 / NotePane.tsx:1027 / FileTree.tsx:795` 等）が分割対象となる。`max-lines-per-function: 80` と併用する。代替案として一律300行（tsxの巨大3ファイル以外にも多数が対象となり過剰）、一律400行（抑止力が弱まる）を検討した。
