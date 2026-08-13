import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: ['features/**/*.feature'],
  steps: ['features/steps/**/*.ts'],
  language: 'ja',
});

const APP_PORT = 4173;
const MOCK_GITHUB_PORT = 4174;
const MOCK_GITHUB_URL = `http://127.0.0.1:${MOCK_GITHUB_PORT}`;

/**
 * E2E 専用のテストフィクスチャ値。実在する資格情報ではなく、
 * OAuth の各エンドポイントはすべてモック（route ハンドラ / モックサーバー）に
 * 差し替えられるため、この値が外部に送信されることはない。
 * wrangler dev の --var は .dev.vars より優先される（PAT モードも無効化する）。
 */
const e2eAuthBindings = [
  '--var GITHUB_CLIENT_ID:e2e-client-id',
  '--var GITHUB_CLIENT_SECRET:e2e-client-secret',
  '--var SESSION_SECRET:e2e-session-secret-0123456789abcdef',
  `--var OAUTH_REDIRECT_URI:http://localhost:${APP_PORT}/api/auth/callback`,
  `--var GITHUB_TOKEN_URL:${MOCK_GITHUB_URL}/login/oauth/access_token`,
  `--var GITHUB_API_BASE_URL:${MOCK_GITHUB_URL}`,
  '--var TEKTITE_PAT_AUTH:false',
].join(' ');

export default defineConfig({
  testDir,
  // save.feature のシナリオはモックサーバー（features/support/mock-github-server.mjs）の
  // 保存状態を共有・変更するため、ファイル内は定義順に直列実行する。
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Worker のサーバー側 fetch（トークン交換 / ユーザー取得）のモック。
      // ブラウザ外のリクエストは route ハンドラで捕捉できないため専用サーバーを立てる。
      command: 'node features/support/mock-github-server.mjs',
      url: `${MOCK_GITHUB_URL}/__health`,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_GITHUB_PORT: String(MOCK_GITHUB_PORT) },
    },
    {
      // vite preview の代わりに wrangler dev を使い、Workers（/api/**）が実動する
      // 状態で E2E を実行する。--var は .dev.vars より優先されるため、
      // ローカルの秘密情報設定に左右されない。前提として pnpm build 済みの dist が必要。
      command: `pnpm exec wrangler dev --port ${APP_PORT} ${e2eAuthBindings}`,
      url: `http://localhost:${APP_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
