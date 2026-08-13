/**
 * ノート保存（features/save.feature）のステップ定義。
 *
 * 保存の検証は、アプリの API（/api/notes/.../blob/:path の GET）経由で
 * リモートの内容を再取得して行う。競合（409）は別クライアント（アプリ API への
 * PUT）による更新で再現する（M4 の R2 先行化: 競合検出は R2 上のコンテンツ
 * ハッシュ）。ログイン・ツリー操作・エディタ入力のステップは auth.feature /
 * vault.feature / note.feature のものを再利用する。
 */

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { When, Then } = createBdd();

/** ノートパスをアプリ API のパスセグメント（1 セグメントエンコード）に変換する */
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

/**
 * 別クライアントによるリモート変更の再現（M4 の R2 先行化対応）。
 * 保存時の競合検出は R2 上のコンテンツハッシュ（SHA-256）で行われるため、
 * モック GitHub サーバーの状態書き換えではなく、アプリ自身の保存 API を
 * 通して更新する（読込時 sha を取得して PUT する = ブラウザとは別クライアント）。
 * これにより R2 の sha が変わり、ページ側の保存が 409 conflict になる。
 */
When(
  '別のクライアントがノート {string} を {string} に変更する',
  async ({ page }, notePath: string, content: string) => {
    const noteUrl = `/api/notes/octocat/notes/blob/${encodeNotePath(notePath)}`;
    const current = await page.request.get(noteUrl);
    expect(current.ok()).toBeTruthy();
    const currentBody = (await current.json()) as { sha?: unknown };
    expect(typeof currentBody.sha).toBe('string');

    const updated = await page.request.put(noteUrl, {
      data: {
        content: btoa(content),
        sha: currentBody.sha,
        message: 'E2E: 別クライアントによる更新',
      },
    });
    expect(updated.ok()).toBeTruthy();
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
