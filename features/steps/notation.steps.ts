/**
 * 記法（features/notation.feature）のステップ定義。
 *
 * WikiLink / Embed / Tag のライブプレビュー装飾、WikiLink クリック遷移
 * （見出し位置含む）、バックリンクパネル・タグ一覧を検証する。ログイン・
 * ツリー操作のステップは auth.feature / vault.feature のものを再利用する。
 *
 * 装飾スパンの特定は「テキスト完全一致」で行う（`[[tags]]` と
 * `[[tags#セクション|...]]` が部分一致で衝突しないようにするため）。
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { When, Then } = createBdd();

/** テキストを正規表現のリテラルとしてエスケープする */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** エディタ内の装飾スパン（クラス + テキスト完全一致）を特定する */
function decoratedSpan(page: Page, className: string, text: string) {
  return page
    .getByTestId('note-editor')
    .locator(`.cm-content .${className}`)
    .filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`) });
}

/** タグ一覧パネル内のノートリンク（表示名で前方一致）を特定する */
function tagNoteLink(page: Page, noteName: string) {
  return page
    .getByTestId('tag-panel')
    .getByRole('link', { name: new RegExp(`^${escapeRegExp(noteName)}\\b`) });
}

Then('エディタの WikiLink {string} が装飾されている', async ({ page }, text: string) => {
  await expect(decoratedSpan(page, 'tk-wikilink', text)).toHaveCount(1);
});

Then('エディタの壊れ WikiLink {string} が壊れ装飾されている', async ({ page }, text: string) => {
  await expect(decoratedSpan(page, 'tk-wikilink-broken', text)).toHaveCount(1);
});

Then('エディタのタグ {string} が装飾されている', async ({ page }, text: string) => {
  await expect(decoratedSpan(page, 'tk-tag', text)).toHaveCount(1);
});

Then('エディタの埋め込みが {int} 個装飾されている', async ({ page }, count: number) => {
  await expect(page.getByTestId('note-editor').locator('.cm-content .tk-embed')).toHaveCount(count);
});

When('ユーザーがエディタの WikiLink {string} をクリックする', async ({ page }, text: string) => {
  await decoratedSpan(page, 'tk-wikilink', text).click();
});

When('ユーザーが表示モードに切り替える', async ({ page }) => {
  await page.getByTestId('mode-read-button').click();
});

Then('表示中の URL のハッシュは {string} である', async ({ page }, hash: string) => {
  // pushState は非 ASCII のハッシュをパーセントエンコードして正規化するため、
  // デコードして比較する（#セクション ⇔ #%E3%82%BB...）
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(hash);
});

Then('リーディング表示に見出し {string} が表示される', async ({ page }, text: string) => {
  // 見出しリンク（#スラグ）の遷移先がビューポート内にスクロールされていることを確認する
  await expect(
    page.getByTestId('reading-view').getByRole('heading', { name: text }),
  ).toBeInViewport();
});

Then('エディタに見出し {string} が表示される', async ({ page }, text: string) => {
  // エディタはソース表示のため、見出し行（# で始まる行）がビューポート内に
  // スクロールされていることを確認する（見出し遷移の検証）
  await expect(
    page
      .getByTestId('note-editor')
      .locator('.cm-line')
      .filter({ hasText: new RegExp(`^#{1,6} ${escapeRegExp(text)}$`) }),
  ).toBeInViewport();
});

Then('リーディング表示にフロントマテリアが表示される', async ({ page }) => {
  await expect(page.getByTestId('note-frontmatter')).toBeVisible();
});

Then(
  'フロントマテリアに項目 {string} が値 {string} で表示される',
  async ({ page }, key: string, value: string) => {
    const field = page
      .getByTestId('note-frontmatter')
      .locator('.note-frontmatter-field')
      .filter({ hasText: key });
    await expect(field.locator('dt')).toHaveText(key);
    await expect(field.locator('dd')).toHaveText(value);
  },
);

Then('リーディング表示に数式が表示される', async ({ page }) => {
  await expect(page.getByTestId('reading-view').locator('.katex')).toBeVisible();
});

Then('リーディング表示にコールアウト {string} が表示される', async ({ page }, title: string) => {
  await expect(
    page.getByTestId('reading-view').locator('.callout-title').getByText(title, { exact: true }),
  ).toBeVisible();
});

Then('リーディング表示にタスクリストが表示される', async ({ page }) => {
  await expect(page.getByTestId('reading-view').locator('.task-list-checkbox')).toHaveCount(2);
});

Then('リーディング表示にハイライトされたコードが表示される', async ({ page }) => {
  await expect(page.getByTestId('reading-view').locator('pre code.hljs')).toHaveCount(1);
});

Then('リーディング表示に画像が表示される', async ({ page }) => {
  // 読み込み失敗時は onError で span に置き換わるため、img の存在 = 表示成功
  await expect(
    page.getByTestId('reading-view').locator('img[data-embed-image="true"]'),
  ).toHaveCount(1);
});

Then('リーディング表示に埋め込みノート {string} が表示される', async ({ page }, text: string) => {
  // 埋め込み先ノートの本文が Markdown → HTML で描画され、見出しが表示される
  await expect(
    page
      .getByTestId('reading-view')
      .locator('.note-embed-content')
      .getByRole('heading', { name: text }),
  ).toBeVisible();
});

Then('タグ一覧にタグ {string} が表示される', async ({ page }, tag: string) => {
  await expect(
    page.getByTestId('tag-panel').getByRole('button', { name: `#${tag}` }),
  ).toBeVisible();
});

When('ユーザーがタグ {string} を選ぶ', async ({ page }, tag: string) => {
  await page
    .getByTestId('tag-panel')
    .getByRole('button', { name: `#${tag}` })
    .click();
});

Then('タグ一覧にノート {string} が表示される', async ({ page }, noteName: string) => {
  await expect(tagNoteLink(page, noteName)).toBeVisible();
});

When('ユーザーがタグ一覧のノート {string} をクリックする', async ({ page }, noteName: string) => {
  await tagNoteLink(page, noteName).click();
});

Then('バックリンクパネルにノート {string} が表示される', async ({ page }, noteName: string) => {
  await expect(
    page
      .getByTestId('backlink-panel')
      .getByRole('link', { name: new RegExp(`^${escapeRegExp(noteName)}\\b`) }),
  ).toBeVisible();
});

When('ユーザーがバックリンク {string} をクリックする', async ({ page }, noteName: string) => {
  await page
    .getByTestId('backlink-panel')
    .getByRole('link', { name: new RegExp(`^${escapeRegExp(noteName)}\\b`) })
    .click();
});
