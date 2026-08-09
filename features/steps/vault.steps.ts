/**
 * Vault 選択とファイルツリー表示（features/vault.feature）のステップ定義。
 *
 * GitHub API のモックは features/support/mock-github-server.mjs が担う
 * （Pages Functions のサーバー側 fetch は route ハンドラで捕捉できないため）。
 * ログイン手順は auth.feature のステップ（GitHub OAuth のモックが有効である 等）を再利用する。
 */

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Given, When, Then } = createBdd();

Given('Vault 一覧が表示される', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Vault を開く' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'octocat/notes' })).toBeVisible();
});

Given('リポジトリ {string} は Vault 一覧に表示されない', async ({ page }, fullName: string) => {
  await expect(page.getByRole('link', { name: fullName })).toHaveCount(0);
});

When('ユーザーが Vault {string} を開く', async ({ page }, fullName: string) => {
  await page.getByRole('link', { name: fullName }).click();
});

Then('ファイルツリーにファイル {string} が表示される', async ({ page }, name: string) => {
  await expect(page.getByRole('link', { name })).toBeVisible();
});

Then('ファイルツリーにディレクトリ {string} が表示される', async ({ page }, name: string) => {
  await expect(page.getByRole('button', { name })).toBeVisible();
});

Then('ファイルツリーに隠れディレクトリ {string} は表示されない', async ({ page }, name: string) => {
  await expect(page.getByText(name)).toHaveCount(0);
});

When('ユーザーがディレクトリ {string} を展開する', async ({ page }, name: string) => {
  await page.getByRole('button', { name }).click();
});

When('ユーザーがファイル {string} を開く', async ({ page }, name: string) => {
  await page.getByRole('link', { name }).click();
});

Then('ノートペインにノート {string} が表示される', async ({ page }, notePath: string) => {
  await expect(page.getByTestId('note-path')).toHaveText(notePath);
});

When('ユーザーがページをリロードする', async ({ page }) => {
  await page.reload();
});

Then('表示中の URL は {string} である', async ({ page }, path: string) => {
  expect(new URL(page.url()).pathname).toBe(path);
});

Then('ファイルツリーでファイル {string} が選択されている', async ({ page }, name: string) => {
  await expect(page.getByRole('link', { name })).toHaveAttribute('aria-current', 'location');
});
