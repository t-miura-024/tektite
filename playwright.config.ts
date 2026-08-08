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
 */
const e2eAuthBindings = [
  '--binding GITHUB_CLIENT_ID=e2e-client-id',
  '--binding GITHUB_CLIENT_SECRET=e2e-client-secret',
  '--binding SESSION_SECRET=e2e-session-secret-0123456789abcdef',
  `--binding OAUTH_REDIRECT_URI=http://localhost:${APP_PORT}/api/auth/callback`,
  `--binding GITHUB_TOKEN_URL=${MOCK_GITHUB_URL}/login/oauth/access_token`,
  `--binding GITHUB_API_BASE_URL=${MOCK_GITHUB_URL}`,
].join(' ');

export default defineConfig({
  testDir,
  fullyParallel: true,
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
      // Pages Functions のサーバー側 fetch（トークン交換 / ユーザー取得）のモック。
      // ブラウザ外のリクエストは route ハンドラで捕捉できないため専用サーバーを立てる。
      command: 'node features/support/mock-github-server.mjs',
      url: `${MOCK_GITHUB_URL}/__health`,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_GITHUB_PORT: String(MOCK_GITHUB_PORT) },
    },
    {
      // vite preview の代わりに wrangler pages dev を使い、
      // Pages Functions（/api/auth/**）が実動する状態で E2E を実行する。
      // --binding は .dev.vars より優先されるため、ローカルの秘密情報設定に左右されない。
      command: `pnpm exec wrangler pages dev dist --port ${APP_PORT} ${e2eAuthBindings}`,
      url: `http://localhost:${APP_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
