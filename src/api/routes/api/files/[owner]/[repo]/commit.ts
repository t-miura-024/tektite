/**
 * 一括コミット。複数変更（作成・更新・削除・移動・複製）を1保存で適用する。
 * 同期済みVaultはR2にだけ反映してGitHub APIを消費せず、pushは同期時に束ねる。
 * 未同期VaultはGitHubへ直接コミットする。本文検証とパス検証の不正は400で返す。
 * R2反映時は種別に応じてノート・添付・ツリーへ書き分け、削除はtombstoneを残す。
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

  const _raw: unknown = await request.json().catch(() => null);
  let body: { changes: ParsedChange[]; message: string } | null = null;
  const isRecordObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
  if (isRecordObject(_raw) && 'changes' in _raw && 'message' in _raw) {
    const _changes = _raw.changes;
    const _message = _raw.message;
    if (
      typeof _message === 'string' &&
      _message.length > 0 &&
      Array.isArray(_changes) &&
      _changes.length > 0 &&
      _changes.length <= MAX_CHANGES
    ) {
      const changes: ParsedChange[] = [];
      let _failed = false;
      for (const item of _changes) {
        if (!isRecordObject(item)) {
          _failed = true;
          break;
        }
        if (!('op' in item) || !('path' in item)) {
          _failed = true;
          break;
        }
        const _op = item.op;
        const _path = item.path;
        if (typeof _path !== 'string' || !isValidEntryPath(_path)) {
          _failed = true;
          break;
        }
        if (
          _op !== 'create' &&
          _op !== 'update' &&
          _op !== 'delete' &&
          _op !== 'move' &&
          _op !== 'copy'
        ) {
          _failed = true;
          break;
        }
        if (_op === 'move' || _op === 'copy') {
          if (!('to' in item)) {
            _failed = true;
            break;
          }
          const _to = item.to;
          if (typeof _to !== 'string' || !isValidEntryPath(_to) || _to === _path) {
            _failed = true;
            break;
          }
          changes.push({ op: _op, path: _path, to: _to, content: null });
          continue;
        }
        if (_op === 'delete') {
          changes.push({ op: 'delete', path: _path, to: null, content: null });
          continue;
        }
        if (!('content' in item)) {
          _failed = true;
          break;
        }
        const _content = item.content;
        if (
          typeof _content !== 'string' ||
          !(_content.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(_content))
        ) {
          _failed = true;
          break;
        }
        if (_op === 'create' || _op === 'update') {
          changes.push({ op: _op, path: _path, to: null, content: _content });
          continue;
        }
        _failed = true;
        break;
      }
      if (!_failed) {
        body = { changes, message: _message };
      }
    }
  }
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
