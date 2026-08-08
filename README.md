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
pnpm dev            # 開発サーバー
pnpm build          # typecheck + プロダクションビルド
pnpm test           # Vitest ユニットテスト
pnpm test:e2e       # playwright-bdd（要: pnpm build と playwright install chromium）
pnpm lint           # oxlint
pnpm format         # oxfmt で整形
pnpm format:check   # 整形チェック（CI と同じ）
```

E2E を初めて実行する場合は `pnpm exec playwright install chromium` が必要。

## レイヤリング（実用的ヘキサゴナル）

```
src/domain       純 TS・フレームワーク非依存（React / Cloudflare は import 禁止）
src/application  ユースケース + ポート定義
src/infra        GitHub API / ストレージのアダプタ（Functions プロキシ経由）
src/ui           React
functions/       Cloudflare Pages Functions
```

依存の向き: `ui → application → domain`、`infra → application / domain`。
