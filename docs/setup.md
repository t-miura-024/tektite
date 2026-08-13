# tektite セットアップガイド

デプロイ先（Cloudflare Workers + Static Assets / R2 / KV）と認証（GitHub OAuth App）の初期設定手順を 1 箇所に集約する。
ローカル開発だけなら「7. ローカル開発」の節だけで動く（E2E は資格情報なしで実行可能）。

## 前提

- Node.js（`.node-version` 参照）と pnpm（`package.json` の `packageManager` 参照）
- Cloudflare アカウント（無料枠で可）
- GitHub アカウント（OAuth App を作成できる権限）

---

## 1. Cloudflare Workers のデプロイ準備（R2 バケット / KV namespace）

Workers は `wrangler deploy` で Worker 自体が自動的に作成されるため、Pages のようなプロジェクト作成は不要。ただし、`wrangler.jsonc` が参照する R2 バケットと KV namespace は初回デプロイ前に作成する（GitHub Actions のデプロイワークフローは自動で作成するが、手動デプロイでは先に必要）。

**手順:**

1. リポジトリのルートで以下を実行する（初回は `wrangler login` がブラウザを開き、Cloudflare に認証される。キーチェーンに保存される）:

   ```sh
   pnpm exec wrangler r2 bucket create tektite-vaults
   ```

2. KV namespace を作成し、出力された **id** を控える:

   ```sh
   pnpm exec wrangler kv namespace create tektite-tokens
   # 出力例: {"id":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","title":"tektite-tokens"}
   ```

3. 手順 2 の id はデプロイ時に `TEKTITE_KV_NAMESPACE_ID` 環境変数として渡す。`wrangler.jsonc` は `${TEKTITE_KV_NAMESPACE_ID}` プレースホルダのままでよく、`pnpm deploy` が展開して `.wrangler.deploy.jsonc`（gitignore 済み）を生成する（wrangler 4.x は `wrangler.jsonc` のバインディング id での環境変数補間に対応しないため、展開スクリプト `scripts/expand-config.mjs` で行う）:

   ```sh
   TEKTITE_KV_NAMESPACE_ID=<手順 2 の id> pnpm deploy
   ```

   CI デプロイ（`.github/workflows/deploy.yml`）は KV namespace を冪等作成して id を自動解決するため、環境変数の設定は不要（詳しくは「8. デプロイ」参照）。

**確認方法:**

```sh
pnpm exec wrangler r2 bucket list
pnpm exec wrangler kv namespace list
```

それぞれ `tektite-vaults` と `tektite-tokens` が表示されていれば OK。

---

## 2. Cloudflare API トークンの作成

**手順:**

1. ブラウザで **https://dash.cloudflare.com/profile/api-tokens** を開く
2. **Create Token** → テンプレートの **「Edit Cloudflare Workers」** をクリック
3. 権限（Permissions）が以下を含むことを確認:
   - **Account → Cloudflare Workers Scripts → Edit**（テンプレートの既定）
   - **Account → Workers R2 Storage → Edit**（R2 バケット作成・デプロイ用）
   - **Account → Workers KV Storage → Edit**（KV namespace 作成用）
4. **Account Resources** でご自身のアカウント（All accounts でも可）を選択
5. **Zone Resources は変更しない**（「Include → Any zone」のまま）。Workers のデプロイはアカウントレベルで完結するため、ゾーン権限は不要
6. **Continue to summary → Create Token**
7. 表示されたトークンを**コピーして保存**する（一度しか表示されない）

**確認方法:** トークン文字列（`xxxx...` の長い英数字）が手元に保存されていれば OK。

---

## 3. Cloudflare アカウント ID の確認

**手順:**

1. **https://dash.cloudflare.com** を開く
2. ダッシュボードに表示されている **アカウント ID**（32 文字の英数字）を控える
   - または URL の `https://dash.cloudflare.com/<ここがアカウント ID>` の部分

**確認方法:** 32 文字の英数字が手元にあれば OK。

---

## 4. GitHub リポジトリ secrets の設定（デプロイ用）

**手順:**

1. ブラウザで **https://github.com/<owner>/<repo>/settings/secrets/actions** を開く
2. **New repository secret** をクリックし、以下 2 つを設定する:

   | Secret 名               | 内容                           |
   | ----------------------- | ------------------------------ |
   | `CLOUDFLARE_API_TOKEN`  | 手順 2 で作成した API トークン |
   | `CLOUDFLARE_ACCOUNT_ID` | 手順 3 で確認したアカウント ID |

3. それぞれ **Add secret** をクリック

**補足:** 未設定の間は `.github/workflows/deploy.yml` がデプロイステップをスキップし、notice を残して正常終了する（CI 自体は失敗しない）。

**確認方法:**

```sh
gh secret list
```

`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が表示されていれば OK。

---

## 5. GitHub OAuth App の作成

**手順:**

1. ブラウザで **https://github.com/settings/developers** を開く
2. **OAuth Apps** → **New OAuth App** をクリック
3. 以下を入力する:

   | 項目                       | 値                                                        |
   | -------------------------- | --------------------------------------------------------- |
   | Application name           | 任意（例: `tektite`）                                     |
   | Homepage URL               | `https://tektite.<account>.workers.dev`                   |
   | Authorization callback URL | `https://tektite.<account>.workers.dev/api/auth/callback` |

4. **Register application** をクリック
5. 作成後の画面で:
   - **Client ID** を控える
   - **Generate a new client secret** をクリックして発行し、**Client secret** を控える（この画面でしか発行できない）

**注意（redirect URI の制限）:** GitHub OAuth App はワイルドカードの redirect URI を登録できない。Workers のプレビュー環境（コミットごとに変わる URL）ごとに callback URL が変わるため、プレビュー環境でもログインを検証したい場合は**プレビュー環境ごとに別の OAuth App を作成**し、環境変数を切り替えること。個人利用では**本番（`tektite.<account>.workers.dev`）専用**にするのが簡単。

**確認方法:** Client ID と Client secret の両方が手元にあれば OK。

---

## 6. Cloudflare Workers の環境変数設定（認証用）

Workers が読む環境変数（`src/api/_lib/env.ts` が参照。`src/api/env.d.ts` 対応表）:

| キー                   | 内容                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | 手順 5 で控えた Client ID                                                                   |
| `OAUTH_REDIRECT_URI`   | `https://tektite.<account>.workers.dev/api/auth/callback`（手順 5 で登録した callback URL） |
| `GITHUB_CLIENT_SECRET` | 手順 5 で発行した Client secret                                                             |
| `SESSION_SECRET`       | 暗号化 Cookie の鍵（下記で生成）                                                            |

R2（`VAULT_BUCKET` = `tektite-vaults`）と KV（`TOKEN_KV` = `tektite-tokens`）はバインディングとして `wrangler.jsonc` に定義済み（手順 1）。KV にはログイン時に GitHub OAuth のトークンペアが AES-GCM 暗号化で保存され、**定時同期（Cron）がユーザー Cookie なしで GitHub へアクセスする**ために使われる（`SESSION_SECRET` が暗号化鍵を兼ねるため、変更すると保存済みトークンは復号できなくなる）。

**手順:**

1. `SESSION_SECRET` 用の乱数を生成する:

   ```sh
   openssl rand -hex 32
   ```

2. ブラウザで **https://dash.cloudflare.com** → **Workers & Pages** → **tektite** → **Settings** → **Variables and Secrets** を開く
3. プロジェクトが wrangler 管理（`wrangler.jsonc`）の場合、ダッシュボードには「シークレットのみ管理できます」と表示される。**その場合は 4 つすべてをシークレットとして設定してよい**（実装は vars / secrets を区別せず `env.X` で読むため、どちらでも動作する）
4. **Secrets タブ** → **Add secret** で以下 4 つを追加する:

   | キー                   | 値                                                        |
   | ---------------------- | --------------------------------------------------------- |
   | `GITHUB_CLIENT_ID`     | 手順 5 の Client ID                                       |
   | `OAUTH_REDIRECT_URI`   | `https://tektite.<account>.workers.dev/api/auth/callback` |
   | `GITHUB_CLIENT_SECRET` | 手順 5 の Client secret                                   |
   | `SESSION_SECRET`       | 手順 1 で生成した乱数                                     |

5. **Save** をクリック

**補足:**

- vars として設定したい場合は、`wrangler.jsonc` の `"vars"` フィールドに書く方法もある（プレビュー環境と本番で `OAUTH_REDIRECT_URI` / `GITHUB_CLIENT_ID` を切り替える場合は、ダッシュボードの environment 別設定が扱いやすい）
- 設定が不足していてもアプリは壊れない: 未ログイン表示になり、ログイン押下時に `auth_not_configured` エラー（HTTP 500）として表面化する

**確認方法:**

```sh
# デプロイ後に login エンドポイントが GitHub へリダイレクトすれば認証設定は成功
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://tektite.<account>.workers.dev/api/auth/login
# 例: 302 -> https://github.com/login/oauth/authorize?client_id=...
```

---

## 7. ローカル開発

**手順:**

```sh
cp .dev.vars.example .dev.vars
# .dev.vars にローカル開発用の値を書く（gitignore 済み）
pnpm install
pnpm dev          # Vite 開発サーバー（API も HonoX が処理）
```

`pnpm dev` は Vite 開発サーバー（http://localhost:5173）を起動し、フロント（index.html + React）と API（`/api/*`）の両方を 1 プロセスで処理する（HonoX の `honox()` プラグイン + Cloudflare adapter が `wrangler.jsonc` のバインディングを注入）。ブラウザからは 5173 だけで完結する。

`wrangler dev` 単体で起動する場合（E2E と同じ 4173 を使いたい場合など）:

```sh
pnpm build
pnpm exec wrangler dev --port 4173
```

`wrangler dev` は `wrangler.jsonc` の `main`（`dist/index.js`）と `assets`（`dist/`）を読み、KV / R2 / Static Assets をローカルシミュレーションする。KV namespace の `id` はローカルでは検証されない（プレースホルダのままでもローカルシミュレーションに使われる）。

OAuth モードで実ログインを検証する場合、`.dev.vars` の `OAUTH_REDIRECT_URI` は `http://localhost:5173/api/auth/callback` を使い、この URL を OAuth App の callback として登録する（GitHub OAuth App は localhost の callback も登録可能）。PAT モードでは不要。

### PAT モード（OAuth App なしで実 GitHub を操作する）

OAuth App の作成・登録をせずに実 GitHub で動作確認したい場合は、**PAT モード**（ローカル開発専用）を使う。`TEKTITE_PAT_AUTH=true`（完全一致）かつ `GITHUB_PERSONAL_TOKEN` が空でない時のみ有効で、有効中はセッション Cookie を一切読まず PAT が常に使われる（PAT 優先）。OAuth の 4 変数（`GITHUB_CLIENT_ID` など）は未設定のままでよい。

**PAT のスコープ要件:**

- classic PAT: `repo` スコープを付与する（Vault 候補は push 権限のあるリポジトリのみ表示され、保存は Git のコミットを伴うため）
- fine-grained PAT: Repository access で Vault にしたいリポジトリを選択し、**Contents: Read and write** と **Metadata: Read** を付与する

**手順:**

1. `.dev.vars` に以下を追記する（`<PAT>` は GitHub で発行した個人アクセストークン）:

   ```sh
   TEKTITE_PAT_AUTH=true
   GITHUB_PERSONAL_TOKEN=<PAT>
   ```

2. 起動する:

   ```sh
   pnpm dev
   ```

   PAT モードは `TEKTITE_PAT_AUTH=true`（完全一致）かつ `GITHUB_PERSONAL_TOKEN` が空でない時のみ有効。有効中はセッション Cookie を一切読まず PAT が常に使われる（PAT 優先）。

**手動スモークテスト（完了条件 1 の確認手順）:**

1. ブラウザで http://localhost:4173 を開く。OAuth 未設定（セッション Cookie がなく、OAuth 4 変数も未設定）でもログイン済みとして **Vault 選択**画面が表示されることを確認する
2. Vault として使うリポジトリを選択し、ノート一覧・閲覧（本文の読み込み）ができることを確認する
3. ノートを編集して保存（Cmd+S）し、ヘッダーの**同期ボタン**で明示同期を実行する。GitHub 上で変更（コミット）が反映されることを確認する

保存は R2 への反映が先で、GitHub への push は**同期時（定時 Cron / 明示ボタン）のみ**に行われる（M4 / M5）。スモークテストには**専用のテストリポジトリ**を使うのが安全。

### 定時同期（Cron）のローカル確認

`wrangler.jsonc` の `triggers.crons`（`0 * * * *` = 1 時間おき）で定義された定時同期は、`wrangler dev` の Cron テスト用 UI（http://localhost:4173/__scheduled?cron=0+*+*+*+* に GET）から手動でトリガーできる（`wrangler dev` は 10 分ごとに自動で Cron も発火する）。

```sh
pnpm build
pnpm exec wrangler dev --port 4173
# 別ターミナルで:
curl "http://localhost:4173/__scheduled?cron=0+*+*+*+*"
```

定時同期は保持中の全 Vault（R2 に同期済みメタがある Vault）を対象に、KV に保存された OAuth トークン（`TOKEN_KV`。ログイン時に自動保存）でプル + プッシュを実行する。トークンが無い環境（PAT モード等）では失敗が Vault 単位で記録され、UI に「同期失敗」として表示される（失敗は次回の定時同期で自動リトライ）。

E2E（`pnpm test:e2e`）は資格情報不要: OAuth の各エンドポイントはモック（`features/support/mock-github-server.mjs` + Playwright route）に差し替えられる。初回実行時のみ Playwright のブラウザをインストールする:

```sh
pnpm exec playwright install chromium
```

E2E は `features/**/*.feature`（受け入れ基準の Gherkin）を playwright-bdd で生成して実行する。モックサーバーと `wrangler dev`（`--var` でテスト用の OAuth 値を注入し、`.dev.vars` の PAT モードも無効化。`wrangler dev` は `--binding` をサポートしないため `--var` 形式を使う）を自動起動するため、`.dev.vars` の設定が無くても動く（前提: 事前に `pnpm build` で `dist/` を生成しておく）。

---

## 8. デプロイと動作確認

### デプロイの実行

- **自動デプロイ**: `main` への push で `.github/workflows/deploy.yml` が実行され、R2 バケット / KV namespace を冪等に作成し、KV namespace の id を自動解決した上で `pnpm deploy` により Cloudflare Workers へ自動デプロイされる
- **手動デプロイ**: secrets 設定後に push をせずに再実行したい場合:

  ```sh
  gh workflow run deploy.yml --repo <owner>/<repo> --ref main
  ```

  実行状況の確認:

  ```sh
  gh run list --workflow deploy.yml --limit 1
  ```

- **ローカルからの手動デプロイ**: 手順 1 で作成した KV namespace の id を `TEKTITE_KV_NAMESPACE_ID` 環境変数で渡す（`pnpm deploy` が展開して `.wrangler.deploy.jsonc` を生成する）:

  ```sh
  pnpm build
  TEKTITE_KV_NAMESPACE_ID=<手順 2 の id> pnpm deploy
  ```

- デプロイの実行ログからデプロイ URL が確認できる:

  ```sh
  gh run view <run-id> --log | grep "pages.dev"
  # 例: https://tektite.<account>.workers.dev にデプロイされた旨が出力される
  ```

### 動作確認（推奨チェックリスト）

1. **本番 URL が 200 を返す**:

   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" https://tektite.<account>.workers.dev
   # 200
   ```

2. **ヘルスチェックが OK**:

   ```sh
   curl -s https://tektite.<account>.workers.dev/api/health
   # {"status":"ok","service":"tektite"}
   ```

3. **OAuth ログインが GitHub へリダイレクトする**:

   ```sh
   curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://tektite.<account>.workers.dev/api/auth/login
   # 302 -> https://github.com/login/oauth/authorize?client_id=...
   ```

4. **ブラウザでログイン → Vault 選択 → ノート編集 → 保存** まで一通り動作することを確認する
5. **同期機能**: Vault 画面ヘッダーの**同期ボタン**で明示同期が実行され、別端末（GitHub 上）での変更が取り込まれること（プル）と、ローカルの保存内容が GitHub へ反映されること（プッシュ）を確認する。画面右上に**最終同期時刻**が表示され、定時同期が失敗した Vault では「同期失敗」マークが表示される
6. **Cron（定時同期）**: `wrangler dev` の Cron テスト UI（`http://localhost:4173/__scheduled?cron=0+*+*+*+*`）から定時同期を発火し、ログ（`scheduled sync: ...`）と GitHub への反映を確認する

デプロイ先 URL は Cloudflare Workers が発行する `https://tektite.<account>.workers.dev`（Worker 名は `wrangler.jsonc` の `name`。カスタムドメイン未設定のため OAuth App の `OAUTH_REDIRECT_URI` を Workers の URL に合わせること）。

---

## 9. CI と検収

GitHub Actions が push / PR で以下を実行する:

- `.github/workflows/ci.yml`: `pnpm lint` + `pnpm format:check` + `pnpm typecheck` + `pnpm test`（ユニット）+ `pnpm build` + `pnpm test:e2e`（Gherkin 全シナリオ）。E2E は `pnpm exec playwright install --with-deps chromium` でブラウザを導入してから実行する。対象ブランチは `main` と `tektite-wt-*`、および全 PR
- `.github/workflows/deploy.yml`: 手順 8 参照（手順 4 のシークレットが未設定の間はデプロイをスキップして正常終了する）

ローカルの検収手順（CI と同じチェック）:

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e
```

CI の実行状況は GitHub の **Actions** タブ、または `gh run list` で確認できる。
