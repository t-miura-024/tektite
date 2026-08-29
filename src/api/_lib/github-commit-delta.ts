/**
 * 一括コミットの差分エントリ組み立て（Git Trees API への入力）。
 *
 * コミット変更 1 件ずつを base tree のパス → blob sha 対応と突き合わせ、
 * 新 tree へ適用する差分エントリ（path → blob sha / 削除）を組み立てる。
 * create/update は Blob 作成が要るため対象を集めて返す（呼び出し側が並列作成する）。
 */

import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { readJsonBody, readNonEmptyStringField } from '@/api/_lib/github-json';

/** コミット変更 1 件（ボディ検証後の正規化形） */
export type ParsedChange = {
  readonly op: 'create' | 'update' | 'delete' | 'move' | 'copy';
  readonly path: string;
  /** move / copy の移動・複製先（他 op は null） */
  readonly to: string | null;
  /** create/update の本文 base64（他 op は null） */
  readonly content: string | null;
};

/** Git Trees API のエントリ 1 件（差分） */
export type DeltaEntry = {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob';
  readonly sha: string | null;
};

/** 差分組み立ての結果。検証エラー時は完成済みのエラー応答を返す */
export type DeltaBuildResult =
  | {
      readonly ok: true;
      readonly delta: Map<string, DeltaEntry>;
      readonly blobOps: readonly { readonly path: string; readonly content: string }[];
    }
  | { readonly ok: false; readonly response: Response };

const invalidChangeResponse = (message: string): Response =>
  Response.json({ error: 'invalid_change', message }, { status: 400 });

const invalidBodyResponse: Response = Response.json({ error: 'invalid_body' }, { status: 400 });

/**
 * 変更列を差分エントリへ変換する。同一パスの後続変更が勝つ
 * （move 後の update で張り替え後本文が反映される）。
 */
export function buildDelta(
  changes: readonly ParsedChange[],
  blobShaByPath: ReadonlyMap<string, string>,
): DeltaBuildResult {
  const delta = new Map<string, DeltaEntry>();
  // create/update は Blob 作成が要るため対象を一旦集める（順序保持）。
  // move/delete/copy は即座に差分エントリへ反映する
  const blobOps: { readonly path: string; readonly content: string }[] = [];
  for (const change of changes) {
    let failure: Response | null = null;
    if (change.op === 'create' || change.op === 'update') {
      if (change.content === null) {
        // 呼び出し側の検証（parseCommitBody）で保証されるため到達しない（型の防御線）
        failure = invalidBodyResponse;
      }
      if (failure === null && change.content !== null) {
        blobOps.push({ path: change.path, content: change.content });
      }
    }
    if (change.op === 'delete') {
      delta.set(change.path, { path: change.path, mode: '100644', type: 'blob', sha: null });
    }
    if (change.op === 'move') {
      // move: base tree の blob sha を再利用して移動先に引き継ぎ、元パスを削除する
      if (change.to === null) {
        // 呼び出し側の検証で保証されるため到達しない（型の防御線）
        failure = invalidBodyResponse;
      }
      if (failure === null && change.to !== null) {
        const sourceSha = blobShaByPath.get(change.path);
        if (!sourceSha) {
          failure = invalidChangeResponse(`移動元「${change.path}」が見つかりません。`);
        }
        if (failure === null && sourceSha) {
          delta.set(change.to, { path: change.to, mode: '100644', type: 'blob', sha: sourceSha });
          delta.set(change.path, { path: change.path, mode: '100644', type: 'blob', sha: null });
        }
      }
    }
    if (change.op === 'copy') {
      // copy: base tree の blob sha を再利用して複製先に置く（元パスは残す）
      if (change.to === null) {
        // 呼び出し側の検証で保証されるため到達しない（型の防御線）
        failure = invalidBodyResponse;
      }
      if (failure === null && change.to !== null) {
        const sourceSha = blobShaByPath.get(change.path);
        if (!sourceSha) {
          failure = invalidChangeResponse(`複製元「${change.path}」が見つかりません。`);
        }
        if (failure === null && sourceSha) {
          delta.set(change.to, { path: change.to, mode: '100644', type: 'blob', sha: sourceSha });
        }
      }
    }
    if (failure !== null) {
      return { ok: false, response: failure };
    }
  }
  return { ok: true, delta, blobOps };
}

/** Blob 作成結果 1 件 */
export type BlobResult =
  | { readonly ok: true; readonly path: string; readonly sha: string }
  | { readonly ok: false; readonly error: Response };

/**
 * 独立パスの Blob 作成を並列化する（順序依存はなく、同一パスの後勝ちは
 * 呼び出し側の delta 適用順で担保する）。
 */
export async function createBlobs(
  base: string,
  token: string,
  owner: string,
  repoName: string,
  blobOps: readonly { readonly path: string; readonly content: string }[],
): Promise<BlobResult[]> {
  return Promise.all(
    blobOps.map(async ({ path, content }): Promise<BlobResult> => {
      let blobResponse: Response;
      try {
        blobResponse = await githubApiFetch(base, `/repos/${owner}/${repoName}/git/blobs`, token, {
          method: 'POST',
          body: JSON.stringify({ content, encoding: 'base64' }),
        });
      } catch {
        return { ok: false, error: githubUnreachable() };
      }
      const blobFailure = mapGithubFailure(blobResponse);
      if (blobFailure) {
        return { ok: false, error: blobFailure };
      }
      const body: unknown = await readJsonBody(blobResponse);
      const sha = readNonEmptyStringField(body, 'sha');
      if (sha === null) {
        return { ok: false, error: Response.json({ error: 'github_error' }, { status: 502 }) };
      }
      return { ok: true, path, sha };
    }),
  );
}
