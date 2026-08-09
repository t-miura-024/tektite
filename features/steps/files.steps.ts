/**
 * ファイル管理（features/files.feature）のステップ定義。
 *
 * ツールバーからの作成（新規ノート / 新規フォルダー）、コンテキストメニュー
 * （右クリック）からのリネーム・移動・削除を検証する。ログイン・Vault 選択・
 * ツリー表示・保存状態のステップは auth.feature / vault.feature / save.feature
 * のものを再利用する。
 *
 * 操作は一括コミット（Git Trees/Blobs/Commits/Refs API）で GitHub（モック）に
 * 反映されるため、リモート検証は save.feature と同じくアプリ API
 * （/api/notes/.../blob）経由で行う。
 *
 * ファイルツリー内のリンクはバックリンクパネル（role=link）と名前が衝突する
 * ため、ツリー要素（role="tree"）に限定して特定する（strict mode violation の
 * 回避）。
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { When, Then } = createBdd();

/** テキストを正規表現のリテラルとしてエスケープする */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ファイルツリー（role="tree"）内のファイルリンクに限定して特定する */
function treeFileLink(page: Page, name: string) {
  return page.getByRole('tree').getByRole('link', { name });
}

/** ファイルツリー（role="tree"）内のディレクトリ開閉ボタンに限定して特定する */
function treeDirectoryButton(page: Page, name: string) {
  return page.getByRole('tree').getByRole('button', { name });
}

// ---- 作成（新規ノート / 新規フォルダー） ----

When('ユーザーがツールバーの「新規ノート」を押す', async ({ page }) => {
  await page.getByTestId('file-create-note-button').click();
});

When('ユーザーがツールバーの「新規フォルダー」を押す', async ({ page }) => {
  await page.getByTestId('file-create-directory-button').click();
});

When('ユーザーが作成フォームに {string} と入力する', async ({ page }, name: string) => {
  await page.getByTestId('file-tree-editor-input').fill(name);
});

When('ユーザーが作成を確定する', async ({ page }) => {
  await page.getByTestId('file-tree-editor-submit').click();
});

// ---- コンテキストメニュー（右クリック） ----

When('ユーザーがファイル {string} を右クリックする', async ({ page }, name: string) => {
  await treeFileLink(page, name).click({ button: 'right' });
});

When('ユーザーがディレクトリ {string} を右クリックする', async ({ page }, name: string) => {
  await treeDirectoryButton(page, name).click({ button: 'right' });
});

When('ユーザーがコンテキストメニューから {string} を選ぶ', async ({ page }, label: string) => {
  await page.getByRole('menuitem', { name: label }).click();
});

When('ユーザーがリネーム入力に {string} と入力する', async ({ page }, name: string) => {
  // インライン入力はフォーカス時に全選択されるため fill で置き換える
  await page.getByTestId('file-rename-input').fill(name);
  await page.keyboard.press('Enter');
});

// ---- 移動（移動先ダイアログ） ----

Then('移動ダイアログが表示される', async ({ page }) => {
  await expect(page.getByTestId('move-dialog')).toBeVisible();
});

When('ユーザーが移動先に {string} を選ぶ', async ({ page }, directory: string) => {
  // 移動先候補は深さに応じたインデント付きの「<ディレクトリ名>/」で表示される
  await page.getByRole('option', { name: new RegExp(`${escapeRegExp(directory)}/$`) }).click();
});

When('ユーザーが移動を確定する', async ({ page }) => {
  await page.getByTestId('move-dialog-confirm').click();
});

// ---- 削除（確認ダイアログ） ----

Then('削除確認ダイアログが表示される', async ({ page }) => {
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
});

Then('削除確認ダイアログに {string} が含まれる', async ({ page }, text: string) => {
  await expect(page.getByTestId('confirm-dialog')).toContainText(text);
});

When('ユーザーが削除確認ダイアログの「削除」を押す', async ({ page }) => {
  await page.getByTestId('confirm-dialog-confirm').click();
});

/** クリーンアップ用の短縮手順（右クリック → 削除 → 確認ダイアログで確定） */
When('ユーザーがファイル {string} を削除する', async ({ page }, name: string) => {
  await treeFileLink(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '削除' }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
});

/** クリーンアップ用の短縮手順（ディレクトリ版。配下の全ファイルを削除する） */
When('ユーザーがディレクトリ {string} を削除する', async ({ page }, name: string) => {
  await treeDirectoryButton(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '削除' }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
});

// ---- 結果の検証 ----

Then('ファイルツリーにファイル {string} は表示されない', async ({ page }, name: string) => {
  await expect(treeFileLink(page, name)).toHaveCount(0);
});

Then('ファイルツリーにディレクトリ {string} は表示されない', async ({ page }, name: string) => {
  await expect(treeDirectoryButton(page, name)).toHaveCount(0);
});

/**
 * 表示中の URL が {path} になる（自動待機版）。
 * ファイル操作のコミット → ツリー再読込 → 遷移は非同期のため、即時チェックの
 * 既存ステップ（vault.feature 用）ではなく toHaveURL で完了を待つ。
 */
Then('表示中の URL は {string} になる', async ({ page }, path: string) => {
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(path)}($|#.*)`));
});

/** 削除後にリモート（モック）からも消えていること（GET が 404）を検証する */
Then('リモートのノート {string} は存在しない', async ({ page }, notePath: string) => {
  const response = await page.request.get(
    `/api/notes/octocat/notes/blob/${encodeURIComponent(notePath)}`,
  );
  expect(response.status()).toBe(404);
});
