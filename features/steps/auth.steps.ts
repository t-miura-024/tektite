/**
 * 認証シナリオ（features/auth.feature）のステップ定義。
 *
 * GitHub 認可ページのモック方法:
 * この Playwright / Chromium では、ナビゲーションのリダイレクト先リクエスト
 * （302 のホップ）を page.route で補足できない。そのため認可ページ
 * （github.com/login/oauth/authorize）の route モックは、直前の
 * `/api/auth/login` リクエストを補足して実現する:
 *   1. route.fetch() で実際の Pages Function を実行させ（state 生成 + 署名 Cookie）、
 *   2. 返ってきた 302 の Location を「認可承認後のコールバック URL」に書き換える。
 * これは認可エンドポイントを route ハンドラでモックすることと等価である。
 *
 * サーバー側 fetch（トークン交換 / ユーザー取得）は playwright.config.ts の
 * webServer が起動するモックサーバーが処理する（features/auth.feature 参照）。
 */

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Given, When, Then } = createBdd();

const LOGIN_BUTTON = 'GitHub でログイン';
/** モックサーバー（features/support/mock-github-server.mjs）が受け付ける認可コード */
const MOCK_AUTH_CODE = 'e2e-test-code';

Given('GitHub OAuth のモックが有効である', async ({ page }) => {
  // /api/auth/login の 302 を書き換え、GitHub 認可ページへの遷移を
  // 「認可承認 → コールバックへ code + state を持って戻る」に置き換える。
  // （末尾 ** は return_to 等のクエリ付きリクエストにもマッチさせるため）
  await page.route('**/api/auth/login**', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()['location'];
    if (response.status() !== 302 || !location) {
      await route.fulfill({ response });
      return;
    }
    const authorizeUrl = new URL(location);
    const state = authorizeUrl.searchParams.get('state') ?? '';
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri') ?? '';
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        location: `${redirectUri}?code=${MOCK_AUTH_CODE}&state=${encodeURIComponent(state)}`,
      },
    });
  });

  // 安全網: 何らかの経路で認可ページへ直接遷移した場合も実 GitHub に到達させない
  await page.route('https://github.com/login/oauth/authorize**', async (route) => {
    const url = new URL(route.request().url());
    const state = url.searchParams.get('state') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const location = `${redirectUri}?code=${MOCK_AUTH_CODE}&state=${encodeURIComponent(state)}`;
    await route.fulfill({ status: 302, headers: { location } });
  });
});

Given('ユーザーはログイン画面にいる', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: LOGIN_BUTTON })).toBeVisible();
});

When('ユーザーが未ログインでディープリンク {string} を開く', async ({ page }, path: string) => {
  await page.goto(path);
});

Then('ログイン画面が表示される', async ({ page }) => {
  await expect(page.getByRole('link', { name: LOGIN_BUTTON })).toBeVisible();
});

When('ユーザーがログインボタン {string} を押す', async ({ page }, label: string) => {
  await page.getByRole('link', { name: label }).click();
});

Then('ユーザー {string} のセッションが確立する', async ({ page }, login: string) => {
  // ログイン済み表示が出ること = セッション Cookie が復号され /api/auth/me が成功した証
  await expect(page.getByText(`${login} でログイン中`)).toBeVisible();
});

When('ユーザーがログアウトする', async ({ page }) => {
  await page.getByRole('button', { name: 'ログアウト' }).click();
});

Then('ログイン画面が再び表示される', async ({ page }) => {
  await expect(page.getByRole('link', { name: LOGIN_BUTTON })).toBeVisible();
  // Cookie 削除によりセッション検証が 401 に戻ることを API レベルでも確認する
  const me = await page.request.get('/api/auth/me');
  expect(me.status()).toBe(401);
});

When('ユーザーが不正な state でコールバック URL にアクセスする', async ({ page }) => {
  await page.goto('/api/auth/callback?code=e2e-test-code&state=invalid-state');
});

Then('認証エラーのトーストが表示される', async ({ page }) => {
  await expect(page.getByRole('alert')).toContainText('state が一致しませんでした');
});
