/**
 * ノート保存（features/save.feature）のステップ定義。
 *
 * 保存の検証は、アプリの API（/api/notes/.../blob/:path の GET）経由で
 * リモート（モックサーバー）の内容を再取得して行う。競合（409）は
 * モックサーバーのコントロールエンドポイント（POST /__mock/contents/...）で
 * リモート内容を書き換えて再現する。ログイン・ツリー操作・エディタ入力の
 * ステップは auth.feature / vault.feature / note.feature のものを再利用する。
 */

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { When, Then } = createBdd();

/** モックサーバーのポート（playwright.config.ts の webServer と一致） */
const MOCK_GITHUB_PORT = 4174;

/** ノートパスをアプリ API / モックのパスセグメント（1 セグメントエンコード）に変換する */
function encodeNotePath(notePath: string): string {
  return encodeURIComponent(notePath);
}

When('ユーザーが Cmd+S で保存する', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+s');
});

When('ユーザーが保存ボタンを押す', async ({ page }) => {
  await page.getByTestId('save-button').click();
});

Then('保存状態が {string} である', async ({ page }, label: string) => {
  await expect(page.getByTestId('save-status')).toHaveText(label);
});

/** アプリの GET 経由でリモート（モック）の保存内容を検証する */
Then(
  'リモートのノート {string} の内容は {string} を含む',
  async ({ page }, notePath: string, text: string) => {
    const response = await page.request.get(
      `/api/notes/octocat/notes/blob/${encodeNotePath(notePath)}`,
    );
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { content?: unknown };
    expect(typeof body.content).toBe('string');
    expect(body.content as string).toContain(text);
  },
);

/** リモートに保存されていないことの検証（Draft 破棄時の blur 自動保存抑止確認用） */
Then(
  'リモートのノート {string} の内容は {string} を含まない',
  async ({ page }, notePath: string, text: string) => {
    const response = await page.request.get(
      `/api/notes/octocat/notes/blob/${encodeNotePath(notePath)}`,
    );
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { content?: unknown };
    expect(typeof body.content).toBe('string');
    expect(body.content as string).not.toContain(text);
  },
);

/** 空ファイル（全内容削除）の保存結果を検証する */
Then('リモートのノート {string} の内容は空である', async ({ page }, notePath: string) => {
  const response = await page.request.get(
    `/api/notes/octocat/notes/blob/${encodeNotePath(notePath)}`,
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { content?: unknown };
  expect(body.content).toBe('');
});

/** モックサーバーの保存状態を直接書き換える（別クライアントによるリモート変更の再現） */
When(
  'モックサーバーがノート {string} のリモート内容を {string} に変更する',
  async ({ page }, notePath: string, content: string) => {
    const response = await page.request.post(
      `http://127.0.0.1:${MOCK_GITHUB_PORT}/__mock/contents/octocat/notes/${encodeNotePath(notePath)}`,
      { data: { content } },
    );
    expect(response.ok()).toBeTruthy();
  },
);

Then('競合パネルが表示される', async ({ page }) => {
  await expect(page.getByTestId('conflict-panel')).toBeVisible();
});

Then('競合パネルにリモートの内容 {string} が表示される', async ({ page }, text: string) => {
  await expect(page.getByTestId('conflict-remote')).toContainText(text);
});

Then('競合パネルに編集中の内容 {string} が表示される', async ({ page }, text: string) => {
  await expect(page.getByTestId('conflict-local')).toContainText(text);
});

When('ユーザーが「上書きで保存」を選ぶ', async ({ page }) => {
  await page.getByTestId('conflict-overwrite').click();
});

When('ユーザーが「リモートの変更を取り込む」を選ぶ', async ({ page }) => {
  await page.getByTestId('conflict-adopt').click();
});

/** ウィンドウ blur 相当: フォーカス中の要素（CM6 エディタ）のフォーカスを外す */
When('ユーザーがウィンドウのフォーカスを失う', async ({ page }) => {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
});

Then('Draft 復元通知が表示される', async ({ page }) => {
  await expect(page.getByTestId('draft-restore')).toContainText('未保存の変更が復元されました');
});

When('ユーザーが未保存の変更を復元する', async ({ page }) => {
  await page.getByTestId('draft-restore-button').click();
});

When('ユーザーが未保存の変更を破棄する', async ({ page }) => {
  await page.getByTestId('draft-discard-button').click();
});

/** エディタの全内容を選択して削除する（空ノート保存の検証用） */
When('エディタの全内容を削除する', async ({ page }) => {
  const content = page.getByTestId('note-editor').locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
});

Then('Draft 復元通知が表示されない', async ({ page }) => {
  await expect(page.getByTestId('draft-restore')).toHaveCount(0);
});

Then('エディタにノート本文 {string} は表示されない', async ({ page }, text: string) => {
  await expect(page.getByTestId('note-editor').locator('.cm-content')).not.toContainText(text);
});
