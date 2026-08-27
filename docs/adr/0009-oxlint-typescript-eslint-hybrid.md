# oxlint + typescript-eslint 併用によるLinter構成

oxlint単独では型情報を要する厳密ルール（`no-floating-promises` / `no-explicit-any` / `explicit-function-return-type` / `consistent-type-definitions` 等）をカバーできない。高速な構文ベース検査はoxlint、型情報依存の高度ルールはtypescript-eslintが担うハイブリッド構成を採用する。`pnpm lint` とCIで両方を直列実行し、いずれも `--deny-warnings` / `--max-warnings 0` で必須ゲートとする。代替案としてoxlint単独（カバー不足）、Biome移行（移行コスト大・既存投資の破棄）を検討したが却下した。
