/**
 * 一括コミット: POST /api/files/:owner/:repo/commit
 *
 * 複数ファイルの変更（作成/更新/削除/移動/複製）を 1 回の保存として適用する
 * （リネーム/移動に伴うリンク張り替えもこのエンドポイントで 1 コミットになる）。
 *
 * M4 の R2 先行化（完了条件 3）:
 * - 初期同期済み（R2 メタあり）の Vault は R2 へだけ反映し、GitHub API を
 *   消費しない。GitHub への push は同期時（M5 の定時/明示同期）のみで、
 *   push は既存の commit フロー（src/api/_lib/github-commit.ts の
 *   commitChangesToGitHub: Git Blobs → Trees → Commits → refs）を再利用する
 * - 未同期（R2 メタなし）の Vault は従来どおり GitHub へ直接コミットする
 *   （R2 が正になる前の Vault の書き込み経路）
 *
 * body: `{ changes: [{ op, path, to?, content? }], message }`
 * - op 'create' / 'update': path に content（base64）を置く
 * - op 'delete': path のファイルを削除する
 * - op 'move': path（from）を to へ移動する。本文は送らず、既存の本文を
 *   引き継ぐ（添付ファイルなどクライアントに本文を持たないファイルも移動できる）
 * - op 'copy': path（from）の内容を to へ複製する（元パスは削除しない）
 * - message: コミットメッセージ（必須）
 *
 * R2 への反映:
 * - `.md` で終わるパスはノート（`notes/{path}`）として書き、sha は
 *   コンテンツハッシュ（SHA-256）。それ以外は添付（`raw/{path}`）として
 *   バイナリ + 拡張子由来の Content-Type で書く
 * - move / copy は元パスの種別（notes / raw）に応じて本文・Content-Type を
 *   引き継ぐ。元が R2 に無い場合は 400 invalid_change で中断する
 * - ファイルツリー（`tree`）へも反映し、保存後の読み取り（R2 が正）と整合させる
 * - delete / move（移動元）はローカル削除の tombstone（`deleted/{path}`）を
 *   記録する。同期（M5）がプルで復活させず、プッシュで GitHub へ削除を反映する
 *
 * 応答:
 * - パラメータ不正                  → 400 { error: 'invalid_vault_ref' }
 * - ボディ不正                      → 400 { error: 'invalid_body' }
 * - 移動元/複製元が R2 にない       → 400 { error: 'invalid_change' }
 * - 未ログイン                      → 401 { error: 'unauthenticated' }
 * - レートリミット（403 / 429）     → 429 { error: 'rate_limited' }
 * - ブランチ競合（ref 更新 409）    → 409 { error: 'conflict' }
 * - 正常                            → 200 { owner, name, branch, commitSha }
 */

import { createRoute } from 'honox/factory';

import type { RouteContext } from '@/api/_lib/route-context';
import { isValidGitHubName } from '@/domain/vault';
import { ProxyConfigError, authenticateRequest, resolveProxyConfig } from '@/api/_lib/github-proxy';
import { commitChangesToGitHub } from '@/api/_lib/github-commit';
import type { ParsedChange } from '@/api/_lib/github-commit';
import { sha256Hex } from '@/api/_lib/content-hash';
import {
  applyVaultTreeChanges,
  deleteCachedNote,
  deleteCachedRaw,
  markVaultDeleted,
  readCachedNote,
  readCachedRaw,
  readVaultMeta,
  writeCachedNote,
  writeCachedRaw,
} from '@/api/_lib/r2-vault';
import type { VaultTreeChange } from '@/api/_lib/r2-vault';

/** 1 リクエストで受け付ける変更の上限（個人 Vault 規模の防衛線） */
const MAX_CHANGES = 500;

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** パスのセグメント検証（空セグメント・. / .. ・前後スラッシュを拒否） */
function isValidEntryPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) {
    return false;
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** 標準 base64（btoa 出力相当）かどうか。空文字（空ファイル）も許容する */
function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** ボディを検証し、変更列とメッセージへ正規化する（不正は null） */
function parseCommitBody(raw: unknown): { changes: ParsedChange[]; message: string } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const body = raw as { changes?: unknown; message?: unknown };
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return null;
  }
  if (
    !Array.isArray(body.changes) ||
    body.changes.length === 0 ||
    body.changes.length > MAX_CHANGES
  ) {
    return null;
  }
  const changes: ParsedChange[] = [];
  for (const item of body.changes) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const change = item as { op?: unknown; path?: unknown; to?: unknown; content?: unknown };
    if (
      change.op !== 'create' &&
      change.op !== 'update' &&
      change.op !== 'delete' &&
      change.op !== 'move' &&
      change.op !== 'copy'
    ) {
      return null;
    }
    if (typeof change.path !== 'string' || !isValidEntryPath(change.path)) {
      return null;
    }
    if (change.op === 'move' || change.op === 'copy') {
      if (
        typeof change.to !== 'string' ||
        !isValidEntryPath(change.to) ||
        change.to === change.path
      ) {
        return null;
      }
      changes.push({ op: change.op, path: change.path, to: change.to, content: null });
      continue;
    }
    if (change.op === 'delete') {
      changes.push({ op: 'delete', path: change.path, to: null, content: null });
      continue;
    }
    if (typeof change.content !== 'string' || !isValidBase64(change.content)) {
      return null;
    }
    changes.push({ op: change.op, path: change.path, to: null, content: change.content });
  }
  return { changes, message: body.message };
}

/** base64 文字列を UTF-8 テキストに復号する（ノート本文用） */
function decodeBase64Content(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** base64 文字列をバイト列に復号する（添付バイナリ用） */
function decodeBase64Bytes(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
}

/** パスがノート（Markdown）かどうか。ノート以外は添付（raw）として扱う */
function isNotePath(path: string): boolean {
  return path.endsWith('.md');
}

/** 添付の拡張子から Content-Type を推測する（画像アップロードの規約に合わせる） */
function inferContentType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) {
    return 'application/octet-stream';
  }
  switch (path.slice(dot + 1).toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 変更列を R2 へ適用する（初期同期済み Vault の R2 先行パス）。
 * 変更は順に適用され、同一パスの後続変更が勝つ。move / copy は元パスの
 * 種別（notes / raw）に応じて本文・Content-Type を引き継ぐ。
 */
async function applyChangesToR2(
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  changes: readonly ParsedChange[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly response: Response }> {
  const treeChanges: VaultTreeChange[] = [];
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- 変更は順に適用する（同一パスの後勝ち・
    // move 後の update 反映など GitHub の delta 適用と同じ順序依存がある）ため
    if (change.op === 'create' || change.op === 'update') {
      if (change.content === null) {
        // parseCommitBody で保証されるため到達しない（型の防御線）
        return { ok: false, response: Response.json({ error: 'invalid_body' }, { status: 400 }) };
      }
      if (isNotePath(change.path)) {
        const content = decodeBase64Content(change.content);
        // oxlint-disable-next-line no-await-in-loop -- ハッシュ計算（順次適用の意図）のため
        const noteSha = await sha256Hex(content);
        // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
        await writeCachedNote(bucket, owner, repoName, change.path, {
          sha: noteSha,
          content,
        });
      } else {
        const bytes = decodeBase64Bytes(change.content);
        // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
        await writeCachedRaw(
          bucket,
          owner,
          repoName,
          change.path,
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          inferContentType(change.path),
        );
      }
      treeChanges.push({ op: 'add', path: change.path });
    } else if (change.op === 'delete') {
      // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
      await deleteCachedNote(bucket, owner, repoName, change.path);
      // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
      await deleteCachedRaw(bucket, owner, repoName, change.path);
      // ローカル削除の tombstone を記録する（同期のプルで復活させず、
      // push で GitHub へ削除を反映する。r2-vault.ts の vaultDeletedKey 参照）
      // oxlint-disable-next-line no-await-in-loop -- tombstone 記録（順次適用の意図）のため
      await markVaultDeleted(bucket, owner, repoName, change.path);
      treeChanges.push({ op: 'remove', path: change.path });
    } else if (change.op === 'move' || change.op === 'copy') {
      if (change.to === null) {
        // parseCommitBody で保証されるため到達しない（型の防御線）
        return { ok: false, response: Response.json({ error: 'invalid_body' }, { status: 400 }) };
      }
      const source = change.path;
      const destination = change.to;
      // oxlint-disable-next-line no-await-in-loop -- 元パスの存在確認（順次適用の意図）のため
      const note = await readCachedNote(bucket, owner, repoName, source);
      if (note !== null) {
        // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
        await writeCachedNote(bucket, owner, repoName, destination, note);
        if (change.op === 'move') {
          // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
          await deleteCachedNote(bucket, owner, repoName, source);
          // 移動元はローカル削除として tombstone を記録する（delete と同じ扱い）
          // oxlint-disable-next-line no-await-in-loop -- tombstone 記録（順次適用の意図）のため
          await markVaultDeleted(bucket, owner, repoName, source);
        }
      } else {
        // oxlint-disable-next-line no-await-in-loop -- 元パスの存在確認（順次適用の意図）のため
        const raw = await readCachedRaw(bucket, owner, repoName, source);
        if (raw === null) {
          return {
            ok: false,
            response: Response.json(
              {
                error: 'invalid_change',
                message:
                  change.op === 'move'
                    ? `移動元「${source}」が見つかりません。`
                    : `複製元「${source}」が見つかりません。`,
              },
              { status: 400 },
            ),
          };
        }
        // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
        await writeCachedRaw(bucket, owner, repoName, destination, raw.body, raw.contentType);
        if (change.op === 'move') {
          // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
          await deleteCachedRaw(bucket, owner, repoName, source);
          // 移動元はローカル削除として tombstone を記録する（delete と同じ扱い）
          // oxlint-disable-next-line no-await-in-loop -- tombstone 記録（順次適用の意図）のため
          await markVaultDeleted(bucket, owner, repoName, source);
        }
      }
      treeChanges.push({ op: 'add', path: destination });
      if (change.op === 'move') {
        treeChanges.push({ op: 'remove', path: source });
      }
    }
  }
  await applyVaultTreeChanges(bucket, owner, repoName, treeChanges);
  return { ok: true };
}

export async function handleCommitPost(context: RouteContext): Promise<Response> {
  const { env, request, params } = context;
  const owner = paramToString(params.owner);
  const repoName = paramToString(params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }

  let config;
  try {
    config = resolveProxyConfig(env);
  } catch (error) {
    if (error instanceof ProxyConfigError) {
      return Response.json(
        { error: 'auth_not_configured', message: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  const auth = await authenticateRequest(request, config);
  if (!auth.ok) {
    return auth.response;
  }

  const body = parseCommitBody(await request.json().catch(() => null));
  if (body === null) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  // R2 先行: 初期同期済み（メタあり）の Vault は R2 へだけ反映する
  // （GitHub API を消費しない。push は同期時のみ）
  const bucket = env.VAULT_BUCKET;
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    if (meta !== null) {
      const applied = await applyChangesToR2(bucket, owner, repoName, body.changes);
      if (!applied.ok) {
        return applied.response;
      }
      // commitSha は変更列のコンテンツハッシュ（GitHub コミットが無いため。
      // クライアントはこの値を利用しないが、応答形式は従来と互換を保つ）
      const commitSha = await sha256Hex(JSON.stringify(body.changes));
      return Response.json(
        { owner, name: repoName, branch: meta.defaultBranch, commitSha },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  // 未同期 Vault: GitHub へ直接コミットする（同期 push と同じ commit フロー）
  const result = await commitChangesToGitHub(
    config.apiBaseUrl,
    auth.token,
    owner,
    repoName,
    body.changes,
    body.message,
  );
  if (!result.ok) {
    return result.response;
  }

  return Response.json(
    { owner, name: repoName, branch: result.branch, commitSha: result.commitSha },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const POST = createRoute((c) =>
  handleCommitPost({ env: c.env as Env, request: c.req.raw, params: c.req.param() }),
);
