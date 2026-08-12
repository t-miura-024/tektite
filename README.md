# tektite

Web で完結する Obsidian ライク・マークダウンエディタ。GitHub リポジトリを Vault として閲覧/編集し、変更は再び GitHub へコミットする。

用語定義は [CONTEXT.md](./CONTEXT.md)、設計判断は [docs/adr/](./docs/adr/) を参照。

## 技術スタック

- フロントエンド: React + Vite + TypeScript（SPA）
- バックエンド: Cloudflare Pages + Pages Functions（`functions/`）
- ツールチェーン: pnpm / oxlint / oxfmt / Vitest / playwright-bdd / GitHub Actions

## 開発

```sh
pnpm install        # 依存インストール
pnpm dev            # 開発サーバー（Vite + Pages Functions を同時起動）
pnpm build          # typecheck + プロダクションビルド
pnpm test           # Vitest ユニットテスト
pnpm test:e2e       # playwright-bdd（要: pnpm build と playwright install chromium）
pnpm lint           # oxlint
pnpm format         # oxfmt で整形
pnpm format:check   # 整形チェック（CI と同じ）
```

E2E を初めて実行する場合は `pnpm exec playwright install chromium` が必要。

Cloudflare Pages / GitHub OAuth App のセットアップ手順は [docs/setup.md](./docs/setup.md) を参照。

## Git フック（lefthook）

コミット時は staged ファイルに lint（oxlint）と format（oxfmt、自動修正 + 再ステージ）が、
プッシュ時は unit テスト（vitest）が自動実行される。設定は [lefthook.yml](./lefthook.yml)。
`pnpm install` 時に自動でフックがインストールされる（CI 環境ではスキップ）。
フックをスキップする場合は `git commit --no-verify` / `git push --no-verify` を使う。

## レイヤリング（実用的ヘキサゴナル）

```
src/domain        純 TS・フレームワーク非依存（React / Cloudflare は import 禁止）
src/application   ユースケース + ポート定義（Effect Service / Tag）
src/infra         ポートの具体実装（Effect Layer。Functions プロキシ経由）
src/ui            React（infra は import せず、composition 経由でユースケースを実行）
src/composition.ts 組成ルート（Layer の組み立てと Effect プログラムの実行）
functions/        Cloudflare Pages Functions
```

依存の向き: `ui → application → domain`、`infra → application / domain`。
ポートと実装の接着は [Effect](https://effect.website) の Service / Layer で行い、
`ui` が `infra` を import しないことは oxlint（no-restricted-imports）で機械的に検査する。
