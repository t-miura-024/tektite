# src/domain — ドメイン層

tektite の核心概念を置く層。**純 TypeScript・フレームワーク非依存**。

## 置くもの

- Vault / Note / Attachment / WikiLink / Tag / Frontmatter などの型・値オブジェクト
- パス解決（最短パス一致）、リンク張り替え、検索索引などのドメインロジック
- ドメインエラーの定義

## 置かないもの

- React コンポーネント・フック（→ `src/ui`）
- GitHub API / Cloudflare / ブラウザ API への依存（→ `src/infra`）
- ユースケースの進行制御（→ `src/application`）

## 依存規則

```
ui → application → domain
infra → application（ポート実装）/ domain
```

domain はどの層にも依存しない。`react` / `@cloudflare/*` / `wrangler` の import は
`.oxlintrc.json` の `no-restricted-imports` により CI で禁止されている。

用語の定義はリポジトリルートの [CONTEXT.md](../../CONTEXT.md) を正とする。
