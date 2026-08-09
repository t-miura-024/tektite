/**
 * 組成ルート（composition root）。
 *
 * application 層が定義するポート（Effect Service）に対して、infra 層が提供する
 * 具体実装（Layer）をここで組み立て、Effect プログラムを実行可能な形にする。
 *
 * 依存の向きを単方向に保つための唯一の「infra を知っている」モジュールであり、
 * UI 層（src/ui）は infra を直接 import せず、このモジュールの run() を通じて
 * application 層のユースケースを実行する（.oxlintrc.json で機械的に検査される）。
 */

import { Cause, Effect, Exit, Layer, Option } from 'effect';

import { DraftStore } from '@/application/draft';
import { NoteIndexRegistry } from '@/application/note-index';
import { NoteGateway } from '@/application/note';
import type { SessionGateway } from '@/application/session';
import type { VaultGateway } from '@/application/vault';
import { createEditorView as createEditorViewImpl } from '@/infra/editor/editor';
import type { EditorHandle, EditorOptions } from '@/infra/editor/editor';
import { collectEmbedContents } from '@/infra/render/embed-contents';
import type { EmbedContentFetcher } from '@/infra/render/embed-contents';
import { renderNoteMarkdown } from '@/infra/render/render';
import type { RenderNotationOptions, RenderNotationResult } from '@/infra/render/render';
import { sanitizeHtml } from '@/infra/render/sanitize';
import { slugify } from '@/infra/render/slug';

/** CM6 エディタの opaque ハンドル型（UI 層は infra を import できないためここで公開） */
export type { EditorHandle, EditorOptions } from '@/infra/editor/editor';
import { SessionGatewayLive } from '@/infra/auth/session-gateway';
import { NoteGatewayLive, VaultGatewayLive } from '@/infra/github/http-gateway';
import { NoteIndexRegistryLive } from '@/application/note-index';
import { DraftStoreLive } from '@/infra/storage/draft-store';

/** 本アプリが組み立てる全ポートの実装 */
export const MainLive = Layer.merge(
  Layer.merge(
    Layer.merge(Layer.merge(SessionGatewayLive, VaultGatewayLive), NoteGatewayLive),
    DraftStoreLive,
  ),
  NoteIndexRegistryLive,
);

/** MainLive が満たすポートの組（ユースケースが要求しうるコンテキスト） */
export type MainContext =
  | SessionGateway
  | VaultGateway
  | NoteGateway
  | DraftStore
  | NoteIndexRegistry;

/**
 * CM6 エディタ生成。UI 層は infra を直接 import できないため（.oxlintrc.json）、
 * この組成ルートだけが infra を知るという既存規約に沿ってここで公開する。
 * UI は opaque な EditorHandle だけを扱い、CM6 の型には依存しない。
 */
export const createEditorView: (
  parent: HTMLElement,
  doc: string,
  options?: EditorOptions,
) => EditorHandle = createEditorViewImpl;

/** リーディング表示のレンダリング API（UI 層は infra を import できないためここで公開） */
export { collectEmbedContents, renderNoteMarkdown, sanitizeHtml, slugify };
export type { EmbedContentFetcher, RenderNotationOptions, RenderNotationResult };

/**
 * application 層のユースケース（Effect プログラム）を MainLive で組成して実行し、
 * Promise に変換する。失敗はエラーチャネルの値（SessionFetchError / VaultFetchError）
 * をそのまま reject する。UI 層の既存の instanceof 判定と相性を保つため、
 * FiberFailure のラップはここで解除する。
 */
export async function run<A, E>(program: Effect.Effect<A, E, MainContext>): Promise<A> {
  const exit = await Effect.runPromiseExit(Effect.provide(program, MainLive));
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    throw failure.value;
  }
  // 予期しない欠陥（defect）はそのまま投げ上げる
  throw Cause.squash(exit.cause);
}
