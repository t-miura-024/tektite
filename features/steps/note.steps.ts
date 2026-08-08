/**
 * ノート表示と編集（features/note.feature）のステップ定義。
 *
 * GitHub API のモックは features/support/mock-github-server.mjs が担う
 * （Pages Functions のサーバー側 fetch は route ハンドラで捕捉できないため）。
 * ログイン・ツリー操作のステップは auth.feature / vault.feature のものを再利用する。
 */

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { When, Then } = createBdd();

Then('エディタにノート本文 {string} が表示される', async ({ page }, text: string) => {
  // CM6 は .cm-content 内に行ごとに .cm-line を描画するため、本文の文字列一致は
  // toContainText で行う（装飾の有無に依存しない。装飾は mark ベースでテキストを保持する）
  await expect(page.getByTestId('note-editor').locator('.cm-content')).toContainText(text);
});

Then('エディタの見出し {string} が装飾されている', async ({ page }, text: string) => {
  // 見出しテキストは .tk-heading クラス付きの span として描画される
  await expect(
    page.getByTestId('note-editor').locator('.cm-content .tk-heading', { hasText: text }),
  ).toHaveCount(1);
});

Then('エディタの強調 {string} が装飾されている', async ({ page }, text: string) => {
  await expect(
    page.getByTestId('note-editor').locator('.cm-content .tk-bold', { hasText: text }),
  ).toHaveCount(1);
});

Then('エディタのインラインコード {string} が装飾されている', async ({ page }, text: string) => {
  await expect(
    page.getByTestId('note-editor').locator('.cm-content .tk-inline-code', { hasText: text }),
  ).toHaveCount(1);
});

Then(
  'エディタのタスクリストにチェックボックスが {int} 個表示される',
  async ({ page }, count: number) => {
    // タスクの [ ] / [x] は replace decoration の widget（.tk-task-checkbox）として描画される
    await expect(
      page.getByTestId('note-editor').locator('.cm-content .tk-task-checkbox'),
    ).toHaveCount(count);
  },
);

When('エディタの末尾に {string} を入力する', async ({ page }, text: string) => {
  const content = page.getByTestId('note-editor').locator('.cm-content');
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
});
