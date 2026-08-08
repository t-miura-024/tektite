/**
 * ノート表示と編集（features/note.feature）のステップ定義。
 *
 * GitHub API のモックは features/support/mock-github-server.mjs が担う
 * （Pages Functions のサーバー側 fetch は route ハンドラで捕捉できないため）。
 * ログイン・ツリー操作のステップは auth.feature / vault.feature のものを再利用する。
 */

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Then } = createBdd();

Then('エディタにノート本文 {string} が表示される', async ({ page }, text: string) => {
  // CM6 は .cm-content 内に行ごとに .cm-line を描画するため、本文の文字列一致は
  // toContainText で行う（装飾の有無（M2）に依存しない）
  await expect(page.getByTestId('note-editor').locator('.cm-content')).toContainText(text);
});
