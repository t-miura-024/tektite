# tektite セットアップガイド

デプロイ先（Cloudflare Pages）と認証（GitHub OAuth App）の初期設定手順を 1 箇所に集約する。
ローカル開発だけなら「ローカル開発」の節だけで動く（E2E は資格情報なしで実行可能）。

## 前提

- Node.js（`.node-version` 参照）と pnpm（`package.json` の `packageManager` 参照）
- Cloudflare アカウント（無料枠で可）
- GitHub アカウント（OAuth App を作成できる権限）

## 1. Cloudflare Pages プロジェクトの作成

```sh
pnpm exec wrangler pages project create tektite
```

- 初回は `wrangler login` で Cloudflare に認証する（ブラウザが開き、キーチェーンに保存される）。
- すでにプロジェクトがある場合はスキップしてよい。

## 2. GitHub リポジトリ secrets（デプロイ用）

GitHub リポジトリの Settings → Secrets and variables → Actions に以下を設定する。

| Secret 名               | 内容                                                    |
| ----------------------- | ------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API トークン（Pages へのデプロイ権限が必要） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID（ダッシュボード右側に表示）    |

未設定の場合、`.github/workflows/deploy.yml` はデプロイステップをスキップし、notice を残して正常終了する（CI 自体は失敗しない）。設定後に push すると自動デプロイされる。

## 3. GitHub OAuth App の作成

GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**:

| 項目                       | 値                                            |
| -------------------------- | --------------------------------------------- |
| Application name           | 任意（例: `tektite`）                         |
| Homepage URL               | `https://tektite.pages.dev`                   |
| Authorization callback URL | `https://tektite.pages.dev/api/auth/callback` |

作成後、client ID を控える。client secret はこの画面でしか発行できないため、発行して控える。

**注意（redirect URI の制限）**: GitHub OAuth App はワイルドカードの redirect URI を登録できない。Cloudflare Pages のプレビュー環境（`https://<hash>.<project>.pages.dev`）ごとに callback URL が変わるため、プレビュー環境でもログインを検証したい場合は**プレビュー環境ごとに別の OAuth App を作成**し、環境変数を切り替えること。個人利用では**本番（`tektite.pages.dev`）専用**にするのが簡単。

## 4. Cloudflare の環境変数（vars / secrets）

Pages Functions が読む環境変数（`functions/env.d.ts` 対応表）:

| キー                   | 種別   | 内容                                                                           |
| ---------------------- | ------ | ------------------------------------------------------------------------------ |
| `GITHUB_CLIENT_ID`     | vars   | OAuth App の client ID                                                         |
| `OAUTH_REDIRECT_URI`   | vars   | 3 で登録した callback URL（例: `https://tektite.pages.dev/api/auth/callback`） |
| `GITHUB_CLIENT_SECRET` | secret | OAuth App の client secret                                                     |
| `SESSION_SECRET`       | secret | 暗号化 Cookie の鍵（下記で生成）                                               |

`SESSION_SECRET` は十分な長さの乱数を使う:

```sh
openssl rand -hex 32
```

設定方法（本番環境の例）:

```sh
# secrets（値は対話入力で渡され、ログに残らない）
pnpm exec wrangler pages secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler pages secret put SESSION_SECRET
```

vars は `wrangler.jsonc` の `"vars"` フィールドに書く方法と、Cloudflare ダッシュボード（Pages → Settings → Environment variables）で設定する方法がある。プレビュー環境と本番で `OAUTH_REDIRECT_URI` / `GITHUB_CLIENT_ID` を切り替える場合は、ダッシュボードの environment 別設定が扱いやすい。

設定が不足していてもアプリは壊れない: 未ログイン表示になり、ログイン押下時に `auth_not_configured` エラー（HTTP 500）として表面化する。

## 5. ローカル開発

```sh
cp .dev.vars.example .dev.vars
# .dev.vars にローカル開発用の値を書く（gitignore 済み）
pnpm install
pnpm dev          # アセットのみの開発サーバー（Functions は動かない）
```

Pages Functions を含めてローカルで動かす場合:

```sh
pnpm build
pnpm exec wrangler pages dev dist
```

`.dev.vars` の `OAUTH_REDIRECT_URI` は `http://localhost:4173/api/auth/callback` を使う。この URL を OAuth App の callback として登録すればローカルでも実ログインを検証できる（GitHub OAuth App は localhost の callback も登録可能）。

E2E（`pnpm test:e2e`）は資格情報不要: OAuth の各エンドポイントはモック（`features/support/mock-github-server.mjs` + Playwright route）に差し替えられる。
