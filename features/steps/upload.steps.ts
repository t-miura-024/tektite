/**
 * 画像アップロードと空リポジトリ CTA（features/upload.feature）のステップ定義。
 *
 * 画像ペーストは、クリップボード（DataTransfer）に PNG ファイルをセットした
 * paste イベントをエディタへ dispatch して再現する（CM6 の paste ハンドラが
 * 画像を検出し、onUploadImage → 一括コミット → `![[attachments/...]]` 挿入）。
 * アップロード先のファイル名はタイムスタンプ + 乱数で予測できないため、
 * エディタに挿入された Embed を正規表現で抽出して検証・クリーンアップに使う。
 *
 * 空リポジトリ CTA はモックサーバーの octocat/empty-vault（コミット 0 件）で
 * 検証する。リモート検証は save.feature のステップが octocat/notes 固定のため、
 * Vault を指定できる汎用ステップをここに定義する。
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { When, Then } = createBdd();

/** 1x1 透明 PNG（モックサーバーと同じ素材。ペースト画像の round-trip 検証用） */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---- 画像ペーストとアップロード ----

When('エディタに画像 {string} をペーストする', async ({ page }, fileName: string) => {
  // 新規ノート作成後の遷移ではエディタのマウントが非同期のため、表示を待ってから
  // ペーストする（dispatchEvent は対象要素の存在を待たない）
  await page.getByTestId('note-editor').locator('.cm-content').waitFor({ state: 'visible' });
  await page.evaluate(
    async ({ fileName: pasteFileName, base64 }) => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const file = new File([bytes], pasteFileName, { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const content = document.querySelector('[data-testid="note-editor"] .cm-content');
      if (!(content instanceof HTMLElement)) {
        throw new Error('エディタの .cm-content が見つかりません');
      }
      content.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { fileName, base64: TINY_PNG_BASE64 },
  );
});

/** エディタの本文から画像 Embed（`![[attachments/...]]`）のパスを抽出する */
async function uploadedImagePath(page: Page): Promise<string> {
  const content = await page.getByTestId('note-editor').locator('.cm-content').innerText();
  const match = content.match(/!\[\[(attachments\/[^\]]+)\]\]/);
  expect(match, 'エディタに画像 Embed が見つかりません').not.toBeNull();
  return match![1]!;
}

Then('アップロードされた画像がリモートで参照できる', async ({ page }) => {
  const path = await uploadedImagePath(page);
  // raw 配信: PNG がバイナリで取得できること（モックの blob round-trip の検証）
  const response = await page.request.get(`/api/raw/octocat/notes/${encodeURIComponent(path)}`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type'] ?? '').toContain('image/png');
});

When('ユーザーがアップロードされた画像を削除する', async ({ page }) => {
  const path = await uploadedImagePath(page);
  const fileName = path.split('/').pop()!;
  // attachments ディレクトリが未展開なら展開する。
  // aria-expanded はディレクトリの button ではなく treeitem（li）に付与される
  const toggle = page.getByRole('tree').getByRole('button', { name: 'attachments' });
  const treeItem = page.getByRole('tree').getByRole('treeitem', { name: 'attachments' });
  if ((await treeItem.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await page.getByRole('tree').getByRole('link', { name: fileName }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '削除' }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
});

When('ユーザーが編集モードに切り替える', async ({ page }) => {
  await page.getByTestId('mode-edit-button').click();
});

// ---- 空リポジトリ CTA ----

Then('空リポジトリ CTA が表示される', async ({ page }) => {
  await expect(page.getByTestId('empty-vault-cta')).toBeVisible();
});

When('ユーザーが最初のノートの作成を確定する', async ({ page }) => {
  await page.getByTestId('empty-vault-cta-submit').click();
});

// ---- リモート検証（Vault 指定付きの汎用版） ----

/** アプリ API 経由でリモート（モック）のノート本文を取得する */
async function remoteNoteContent(page: Page, fullName: string, notePath: string): Promise<string> {
  const [owner, repo] = fullName.split('/');
  const response = await page.request.get(
    `/api/notes/${owner}/${repo}/blob/${encodeURIComponent(notePath)}`,
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { content?: unknown };
  expect(typeof body.content).toBe('string');
  return body.content as string;
}

Then(
  'リモートの Vault {string} のノート {string} の内容は {string} を含む',
  async ({ page }, fullName: string, notePath: string, text: string) => {
    const content = await remoteNoteContent(page, fullName, notePath);
    expect(content).toContain(text);
  },
);

Then(
  'リモートの Vault {string} のノート {string} の内容は空である',
  async ({ page }, fullName: string, notePath: string) => {
    const content = await remoteNoteContent(page, fullName, notePath);
    expect(content).toBe('');
  },
);
