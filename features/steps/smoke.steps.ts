import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Given, Then } = createBdd();

Given('ユーザーがトップページを開いている', async ({ page }) => {
  await page.goto('/');
});

Then('ページタイトルは {string} である', async ({ page }, title: string) => {
  await expect(page).toHaveTitle(title);
});

Then('アプリの見出し {string} が表示されている', async ({ page }, heading: string) => {
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
});
