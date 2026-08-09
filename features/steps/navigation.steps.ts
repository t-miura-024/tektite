/**
 * 全文検索とクイックスイッチャー（features/navigation.feature）のステップ定義。
 *
 * ログイン・Vault 選択・ノート表示のステップは auth.feature / vault.feature の
 * 定義を再利用する。ここではパネルの開閉（Cmd+K / Cmd+O とボタン）、クエリ入力、
 * 結果の表示確認、キーボードでの確定を定義する。
 *
 * モバイル検証（完了条件 4）は page.setViewportSize で狭い表示に切り替えて行う
 * （playwright-bdd のテスト単位で viewport を変更できるため、専用プロジェクトは
 * 追加しない）。
 */

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Given, When, Then } = createBdd();

/** モバイル検証用の狭い viewport（iPhone 相当） */
const MOBILE_VIEWPORT = { width: 390, height: 844 };

Given('モバイル表示である', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
});

When('ユーザーが全文検索を開く', async ({ page }) => {
  await page.keyboard.press('Meta+k');
});

When('ユーザーがクイックスイッチャーを開く', async ({ page }) => {
  await page.keyboard.press('Meta+o');
});

Then('全文検索パネルが表示される', async ({ page }) => {
  await expect(page.getByTestId('search-panel')).toBeVisible();
});

Then('クイックスイッチャーが表示される', async ({ page }) => {
  await expect(page.getByTestId('quick-switcher')).toBeVisible();
});

When('ユーザーが検索欄に {string} と入力する', async ({ page }, query: string) => {
  await page.getByLabel('検索クエリ').fill(query);
});

When('ユーザーがクイックスイッチャーに {string} と入力する', async ({ page }, query: string) => {
  await page.getByLabel('ノート名クエリ').fill(query);
});

Then('検索結果にノート {string} が表示される', async ({ page }, notePath: string) => {
  await expect(page.getByTestId('search-result').filter({ hasText: notePath })).toBeVisible();
});

Then('検索結果にタグ {string} が表示される', async ({ page }, tag: string) => {
  await expect(page.getByTestId('search-result').getByText(tag)).toBeVisible();
});

Then(
  'クイックスイッチャーの結果にノート {string} が表示される',
  async ({ page }, notePath: string) => {
    await expect(
      page.getByTestId('quick-switch-result').filter({ hasText: notePath }),
    ).toBeVisible();
  },
);

Then(
  'クイックスイッチャーの結果にノート {string} は表示されない',
  async ({ page }, notePath: string) => {
    await expect(page.getByTestId('quick-switch-result').filter({ hasText: notePath })).toHaveCount(
      0,
    );
  },
);

When('ユーザーが検索結果の選択を確定する', async ({ page }) => {
  await page.keyboard.press('Enter');
});

When('ユーザーがクイックスイッチャーの選択を確定する', async ({ page }) => {
  await page.keyboard.press('Enter');
});

When('ユーザーが結果の次の候補を選ぶ', async ({ page }) => {
  await page.keyboard.press('ArrowDown');
});

When('ユーザーが全文検索を閉じる', async ({ page }) => {
  await page.keyboard.press('Escape');
});

When('ユーザーが検索ボタンを押す', async ({ page }) => {
  await page.getByRole('button', { name: /^検索/ }).click();
});

When('ユーザーが移動ボタンを押す', async ({ page }) => {
  await page.getByRole('button', { name: /^移動/ }).click();
});
