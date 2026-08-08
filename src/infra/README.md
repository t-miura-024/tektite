# src/infra — インフラ層

`src/application` が定義するポートの具体実装（アダプタ）を置く層。

## 置くもの

- `infra/github/` — GitHub API クライアント。**すべて Pages Functions プロキシ（`/api/**`）経由**で呼び出し、`api.github.com` をブラウザから直接呼ばない
- `infra/auth/` — セッション（暗号化 Cookie）の読み書き
- ストレージアダプタ（localStorage の Draft 退避など）

## 依存規則

- `src/domain` / `src/application`（ポート型）には依存してよい
- React コンポーネントは置かない（→ `src/ui`）
