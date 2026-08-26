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

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import { commitChangesToGitHub, type ParsedChange } from '@/api/_lib/github-commit';
import {
  authenticateRequest,
  isProxyConfigError,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import { sha256Hex } from '@/api/_lib/content-hash';
import { isValidGitHubName } from '@/domain/vault';
import { readVaultMeta } from '@/api/_lib/r2-vault';
import { applyChangesToR2 } from '@/api/_lib/apply-r2-changes';

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

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** ボディを検証し、変更列とメッセージへ正規化する（不正は null） */
function parseCommitBody(raw: unknown): { changes: ParsedChange[]; message: string } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  if (!('changes' in raw) || !('message' in raw)) {
    return null;
  }
  const body = { changes: raw.changes, message: raw.message };
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
    if (!isRecordObject(item)) {
      return null;
    }
    const change = item;
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
    if (isProxyConfigError(error)) {
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
  handleCommitPost(toRouteContext(c.env, c.req.raw, c.req.param())),
);
