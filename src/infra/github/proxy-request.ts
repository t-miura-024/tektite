/**
 * Pages Functions プロキシへの HTTP リクエスト。
 *
 * HTTP ステータス（401 / 429 / 404 / 409 / 5xx）をエラー種別へ変換し、
 * 成功時は JSON 応答を返す。エラー値は呼び出し側がファクトリ関数で
 * 指定する（application 層の各エラーファクトリを渡す）。
 */

import { Effect } from 'effect';

/** プロキシ系エラーの kind（Vault / ノート取得で共通の文字列合併型） */
export type FetchErrorKind =
  | 'unauthenticated'
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'network';

/** 保存系エラーの kind（FetchErrorKind に conflict を加えたもの） */
export type SaveErrorKind = FetchErrorKind | 'conflict';

/**
 * エラー値のファクトリ。application 層の各エラー（vaultFetchError 等）と
 * 同じ引数形（kind, message, options）を持つ関数を受け取る。
 */
export type ProxyErrorFactory<K extends string, E extends Error> = (
  kind: K,
  message: string,
  options?: { cause?: unknown },
) => E;

/** UTF-8 文字列を base64（btoa 互換）にエンコードする（PUT の content 用） */
export function encodeBase64Content(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** プロキシにリクエストし、HTTP ステータスをエラー種別に変換して JSON を返す */
export function requestJson<E extends Error>(
  path: string,
  makeError: ProxyErrorFactory<FetchErrorKind, E>,
  init: { method?: 'GET' | 'POST' } = {},
): Effect.Effect<unknown, E> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          path,
          init.method === 'POST'
            ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
            : undefined,
        ),
      catch: (error) => makeError('network', 'サーバーと通信できませんでした。', { cause: error }),
    });
    if (response.status === 401) {
      return yield* Effect.fail(makeError('unauthenticated', 'セッションの有効期限が切れました。'));
    }
    if (response.status === 429) {
      return yield* Effect.fail(
        makeError('rate_limited', 'GitHub API のレートリミットに達しました。'),
      );
    }
    if (response.status === 404) {
      return yield* Effect.fail(makeError('not_found', 'リソースが見つかりませんでした。'));
    }
    if (!response.ok) {
      return yield* Effect.fail(
        makeError('server', `データの取得に失敗しました（HTTP ${response.status}）。`),
      );
    }
    return yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (error) => makeError('server', 'サーバー応答の形式が不正です。', { cause: error }),
    });
  });
}

/**
 * 保存/一括コミット（PUT / POST）専用のリクエスト。取得系（requestJson）と違って
 * JSON ボディを送り、409（sha 楽観ロック競合・ブランチ競合）を conflict として
 * 区別して返す。エラー値のファクトリは呼び出し側が選ぶ。
 */
export function requestSave<E extends Error>(
  path: string,
  body: unknown,
  makeError: ProxyErrorFactory<SaveErrorKind, E>,
  options: { method?: 'PUT' | 'POST'; conflictMessage?: string } = {},
): Effect.Effect<unknown, E> {
  const method = options.method ?? 'PUT';
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      catch: (error) => makeError('network', 'サーバーと通信できませんでした。', { cause: error }),
    });
    if (response.status === 401) {
      return yield* Effect.fail(makeError('unauthenticated', 'セッションの有効期限が切れました。'));
    }
    if (response.status === 429) {
      return yield* Effect.fail(
        makeError('rate_limited', 'GitHub API のレートリミットに達しました。'),
      );
    }
    if (response.status === 404) {
      return yield* Effect.fail(makeError('not_found', 'リソースが見つかりませんでした。'));
    }
    if (response.status === 409) {
      return yield* Effect.fail(
        makeError(
          'conflict',
          options.conflictMessage ?? '保存前にリモートの内容が変更されていました。',
        ),
      );
    }
    if (!response.ok) {
      return yield* Effect.fail(
        makeError('server', `保存に失敗しました（HTTP ${response.status}）。`),
      );
    }
    return yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (error) => makeError('server', 'サーバー応答の形式が不正です。', { cause: error }),
    });
  });
}
