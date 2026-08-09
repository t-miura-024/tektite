# src/infra — インフラ層

`src/application` が定義するポート（Effect Service）の具体実装（アダプタ）を置く層。
実装は Effect の Layer（例: `SessionGatewayLive`）として提供し、`src/composition.ts`
が組み立てる。UI 層はこの層を直接 import しない（oxlint で機械的に検査される）。

## 置くもの

- `infra/github/` — GitHub API クライアント。**すべて Pages Functions プロキシ（`/api/**`）経由**で呼び出し、`api.github.com` をブラウザから直接呼ばない
- `infra/auth/` — セッション（暗号化 Cookie）の読み書き。うち純 TS ユーティリティ
  （cookies / session-crypto / oauth-state / base64url）は Pages Functions 側も再利用する
- ストレージアダプタ（localStorage の Draft 退避など）

## 依存規則

- `src/domain` / `src/application`（ポート型）には依存してよい
- React コンポーネントは置かない（→ `src/ui`）
