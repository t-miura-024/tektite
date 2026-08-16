/**
 * Vault 同期ロジック（vault-sync.ts）のユニットテスト（M5）。
 *
 * - gitBlobShaHex: 本文から Git blob sha（SHA-1）を計算できる
 * - syncVault（プル）: ツリー sha 比較による差分反映と衝突検出
 * - syncVault（プッシュ）: R2 の未反映変更を 1 コミットに束ねる差分検出
 * - 定時同期（scheduled）: 衝突がある Vault は中断する
 * - listSyncedVaults / recordSyncFailure / resolveSyncConflict
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  githubApiFetch: vi.fn(),
  githubUnreachable: vi.fn(),
  mapGithubFailure: vi.fn(),
}));

vi.mock('@/api/_lib/github-proxy', () => ({
  githubApiFetch: mocks.githubApiFetch,
  githubUnreachable: mocks.githubUnreachable,
  mapGithubFailure: mocks.mapGithubFailure,
}));

import {
  gitBlobShaHex,
  listSyncedVaults,
  recordSyncFailure,
  resolveSyncConflict,
  syncVault,
} from './vault-sync';
import { sha256Hex } from './content-hash';
import {
  applyVaultTreeChanges,
  deleteCachedNote,
  deleteCachedRaw,
  isVaultDeleted,
  markVaultDeleted,
  readCachedNote,
  readVaultMeta,
  readVaultTree,
  writeCachedNote,
  writeCachedRaw,
  writeVaultMeta,
  writeVaultTree,
} from './r2-vault';
import { createFakeR2Bucket } from './fake-r2';

const BASE_URL = 'http://mock.invalid';
const OWNER = 'octocat';
const REPO = 'notes';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GitHub ツリー応答（再帰）を構築する */
function treeResponse(treeSha: string, blobs: { path: string; sha: string }[]) {
  return {
    sha: treeSha,
    truncated: false,
    tree: blobs.map(({ path, sha }) => ({ path, type: 'blob', sha })),
  };
}

function blobResponse(sha: string, content: string): Response {
  return jsonResponse({ sha, encoding: 'base64', content: btoa(content) });
}

/** デフォルトの GitHub API モック（成功系） */
function mockGithubApi(options: {
  treeSha: string;
  blobs: { path: string; sha: string; content: string }[];
  commitRef?: 'missing';
}): void {
  mocks.githubApiFetch.mockImplementation(
    async (
      _base: string,
      apiPath: string,
      _token: string,
      init?: { method?: string; body?: string },
    ) => {
      if (apiPath === `/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`) {
        return jsonResponse(
          treeResponse(
            options.treeSha,
            options.blobs.map(({ path, sha }) => ({ path, sha })),
          ),
        );
      }
      const blobMatch = apiPath.match(/^\/repos\/octocat\/notes\/git\/blobs\/([^/]+)$/);
      if (blobMatch) {
        const sha = decodeURIComponent(blobMatch[1] ?? '');
        const blob = options.blobs.find((entry) => entry.sha === sha);
        if (blob) {
          return blobResponse(sha, blob.content);
        }
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (apiPath === `/repos/${OWNER}/${REPO}`) {
        return jsonResponse({ default_branch: 'main' });
      }
      if (apiPath === `/repos/${OWNER}/${REPO}/git/ref/heads/main`) {
        if (options.commitRef === 'missing') {
          return jsonResponse({ message: 'Not Found' }, 404);
        }
        return jsonResponse({ ref: 'refs/heads/main', object: { sha: 'commit-head' } });
      }
      if (
        apiPath === `/repos/${OWNER}/${REPO}/git/trees/main` ||
        apiPath === `/repos/${OWNER}/${REPO}/git/trees?recursive=1`
      ) {
        return jsonResponse(treeResponse(options.treeSha, []));
      }
      if (apiPath === `/repos/${OWNER}/${REPO}/git/trees` && init?.method === 'POST') {
        return jsonResponse({ sha: 'new-tree', truncated: false, tree: [] });
      }
      if (apiPath === `/repos/${OWNER}/${REPO}/git/blobs` && init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as { content?: string };
        const content = body.content ?? '';
        const bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
        const digest = await crypto.subtle.digest(
          'SHA-1',
          new TextEncoder().encode(`blob ${bytes.byteLength}\0${new TextDecoder().decode(bytes)}`),
        );
        const sha = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return jsonResponse({ sha });
      }
      if (apiPath === `/repos/${OWNER}/${REPO}/git/commits` && init?.method === 'POST') {
        return jsonResponse({ sha: 'commit-1' });
      }
      if (apiPath === `/repos/${OWNER}/${REPO}/git/refs/heads/main` && init?.method === 'PATCH') {
        return jsonResponse({ ref: 'refs/heads/main', object: { sha: 'commit-1' } });
      }
      return jsonResponse({ message: `no mock for ${apiPath}` }, 404);
    },
  );
}

/** 同期済み Vault（メタ + ツリー + ノート）を R2 に用意する */
async function seedSyncedVault(bucket: R2Bucket, treeSha = 'tree-1'): Promise<void> {
  await writeVaultMeta(bucket, OWNER, REPO, {
    syncedAt: '2026-08-13T00:00:00.000Z',
    defaultBranch: 'main',
    treeSha,
  });
  await writeVaultTree(bucket, OWNER, REPO, {
    defaultBranch: 'main',
    truncated: false,
    treeSha,
    entries: [
      { path: 'a.md', type: 'file', sha: 'sha-a' },
      { path: 'b.md', type: 'file', sha: 'sha-b' },
    ],
  });
  await writeCachedNote(bucket, OWNER, REPO, 'a.md', { sha: 'sha-a', content: '# A\n' });
  await writeCachedNote(bucket, OWNER, REPO, 'b.md', { sha: 'sha-b', content: '# B\n' });
}

const FIXED_NOW = () => new Date('2026-08-13T02:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.githubUnreachable.mockReturnValue(
    new Response(JSON.stringify({ error: 'github_unreachable' }), { status: 502 }),
  );
  mocks.mapGithubFailure.mockReturnValue(null);
});

describe('gitBlobShaHex', () => {
  it('Git blob sha（SHA-1 of "blob {len}\\0{content}"）を計算する', async () => {
    // 既知の値: `printf 'hello world\n' | git hash-object --stdin`
    const sha = await gitBlobShaHex(new TextEncoder().encode('hello world\n'));
    expect(sha).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
  });
});

describe('syncVault（プル: ツリー sha 比較）', () => {
  it('ツリー sha が同一なら GitHub はツリー 1 回のみで pulled 0 / pushed 0 を返す', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    mockGithubApi({
      treeSha: 'tree-1',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ pulled: 0, pushed: 0, conflicts: [] });
    expect(outcome.result.syncedAt).toBe('2026-08-13T02:00:00.000Z');
    // meta のツリー sha と失敗記録が更新されている
    const meta = await readVaultMeta(bucket, OWNER, REPO);
    expect(meta?.treeSha).toBe('tree-1');
    expect(meta?.lastSyncError).toBeNull();
  });

  it('GitHub 側で追加されたノートを R2 へ取り込む', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
        { path: 'new.md', sha: 'sha-new', content: '# New\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.pulled).toBe(1);
    expect(await readCachedNote(bucket, OWNER, REPO, 'new.md')).toEqual({
      sha: 'sha-new',
      content: '# New\n',
    });
    // ツリーキャッシュが GitHub ツリーで更新される
    const tree = await readVaultTree(bucket, OWNER, REPO);
    expect(tree?.treeSha).toBe('tree-2');
    expect(tree?.entries).toContainEqual({ path: 'new.md', type: 'file', sha: 'sha-new' });
  });

  it('GitHub 側で変更されたノートを、R2 が未編集なら取り込む', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a2', content: '# A v2\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.pulled).toBe(1);
    expect(await readCachedNote(bucket, OWNER, REPO, 'a.md')).toEqual({
      sha: 'sha-a2',
      content: '# A v2\n',
    });
  });

  it('GitHub 側で削除されたノートを R2 から削除する（R2 未編集の場合）', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [{ path: 'a.md', sha: 'sha-a', content: '# A\n' }],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.pulled).toBe(1);
    expect(await readCachedNote(bucket, OWNER, REPO, 'b.md')).toBeNull();
  });
});

describe('syncVault（同期衝突）', () => {
  it('明示同期: ローカル保存 + GitHub 変更は conflicts として保留し、GitHub 側は上書きしない', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    // a.md をローカル保存（SHA-256）する
    await writeCachedNote(bucket, OWNER, REPO, 'a.md', {
      sha: await sha256Hex('# A local\n'),
      content: '# A local\n',
    });
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a2', content: '# A remote\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.conflicts).toEqual([
      { path: 'a.md', local: '# A local\n', remote: '# A remote\n', remoteSha: 'sha-a2' },
    ]);
    // 衝突パスの R2 はローカル内容のまま（保留）
    expect(await readCachedNote(bucket, OWNER, REPO, 'a.md')).toEqual({
      sha: await sha256Hex('# A local\n'),
      content: '# A local\n',
    });
    // メタは更新されない（解決後の同期で整合が取れるまで前回同期時点を保つ）
    const meta = await readVaultMeta(bucket, OWNER, REPO);
    expect(meta?.treeSha).toBe('tree-1');
  });

  it('定時同期: 衝突がある Vault は何も変更せず sync_conflict で中断する', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    await writeCachedNote(bucket, OWNER, REPO, 'a.md', {
      sha: await sha256Hex('# A local\n'),
      content: '# A local\n',
    });
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a2', content: '# A remote\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'scheduled', FIXED_NOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('sync_conflict');
    // R2 は一切変更されていない
    expect(await readCachedNote(bucket, OWNER, REPO, 'a.md')).toEqual({
      sha: await sha256Hex('# A local\n'),
      content: '# A local\n',
    });
    const meta = await readVaultMeta(bucket, OWNER, REPO);
    expect(meta?.treeSha).toBe('tree-1');
  });
});

describe('syncVault（プッシュ: R2 の未反映変更）', () => {
  it('ローカルで新規作成したノートを 1 コミットで GitHub へ反映する', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    await writeCachedNote(bucket, OWNER, REPO, 'local.md', {
      sha: await gitBlobShaHex(new TextEncoder().encode('# Local\n')),
      content: '# Local\n',
    });
    // ツリーキャッシュにもローカル追加（sha: null）を反映しておく
    const tree = await readVaultTree(bucket, OWNER, REPO);
    if (tree) {
      await writeVaultTree(bucket, OWNER, REPO, {
        ...tree,
        entries: [...tree.entries, { path: 'local.md', type: 'file', sha: null }],
      });
    }
    mockGithubApi({
      treeSha: 'tree-1',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.pushed).toBe(1);
    // blobs API（GitHub 側）への POST が 1 件あり、コミット・ref 更新まで到達している
    const blobPosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/blobs') && init?.method === 'POST',
    );
    expect(blobPosts).toHaveLength(1);
    const commitPosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/commits') && init?.method === 'POST',
    );
    expect(commitPosts).toHaveLength(1);
  });

  it('ローカルで編集したノートは update、削除したノートは delete として反映する（実フロー）', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    // a.md をローカル編集（SHA-256 由来）、b.md をローカル削除。削除は実フロー
    // （commit.ts の applyChangesToR2）と同じく「note 削除 + ツリーキャッシュ
    // からの除去 + tombstone 記録」で再現する（レビュー指摘: 従来はツリー
    // キャッシュにエントリが残ったままの非実フローだった）
    await writeCachedNote(bucket, OWNER, REPO, 'a.md', {
      sha: await gitBlobShaHex(new TextEncoder().encode('# A edited\n')),
      content: '# A edited\n',
    });
    await deleteCachedNote(bucket, OWNER, REPO, 'b.md');
    await applyVaultTreeChanges(bucket, OWNER, REPO, [{ op: 'remove', path: 'b.md' }]);
    await markVaultDeleted(bucket, OWNER, REPO, 'b.md');
    mockGithubApi({
      treeSha: 'tree-1',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.pushed).toBe(2);
    const blobPosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/blobs') && init?.method === 'POST',
    );
    expect(blobPosts).toHaveLength(1);
    // delete は blob POST なしでツリー差分に含まれる（sha: null エントリ）
    const treePosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/trees') && init?.method === 'POST',
    );
    expect(treePosts).toHaveLength(1);
    const treeBody = JSON.parse(String(treePosts[0]?.[3]?.body ?? '{}')) as {
      tree?: { path?: string; sha?: string | null }[];
    };
    expect(treeBody.tree?.find((entry) => entry.path === 'b.md')?.sha).toBeNull();
    // 削除したノートは同期後も復活しない
    expect(await readCachedNote(bucket, OWNER, REPO, 'b.md')).toBeNull();
    // tombstone は GitHub への反映後にクリアされる
    expect(await isVaultDeleted(bucket, OWNER, REPO, 'b.md')).toBe(false);
  });

  it('ローカル削除したノートはプルで復活せず、GitHub への削除として反映される', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    // b.md をローカル削除（実フロー: commit.ts の applyChangesToR2）
    await deleteCachedNote(bucket, OWNER, REPO, 'b.md');
    await applyVaultTreeChanges(bucket, OWNER, REPO, [{ op: 'remove', path: 'b.md' }]);
    await markVaultDeleted(bucket, OWNER, REPO, 'b.md');
    // GitHub 側でツリーが変わり new.md が追加された（ローカル削除とは区別して
    // 取得されるべき。b.md は GitHub に残っているため、tombstone が無ければ
    // プルが無条件 fetch して復活させる状態）
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
        { path: 'new.md', sha: 'sha-new', content: '# New\n' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // b.md は復活しない（pulled は GitHub 新規追加の new.md のみ）
    expect(outcome.result.pulled).toBe(1);
    expect(await readCachedNote(bucket, OWNER, REPO, 'b.md')).toBeNull();
    expect(await readCachedNote(bucket, OWNER, REPO, 'new.md')).toEqual({
      sha: 'sha-new',
      content: '# New\n',
    });
    // push で b.md の削除が GitHub へ反映される
    expect(outcome.result.pushed).toBe(1);
    const treePosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/trees') && init?.method === 'POST',
    );
    expect(treePosts).toHaveLength(1);
    const treeBody = JSON.parse(String(treePosts[0]?.[3]?.body ?? '{}')) as {
      tree?: { path?: string; sha?: string | null }[];
    };
    expect(treeBody.tree?.find((entry) => entry.path === 'b.md')?.sha).toBeNull();
    // tombstone は反映後にクリアされる
    expect(await isVaultDeleted(bucket, OWNER, REPO, 'b.md')).toBe(false);
  });

  it('ローカル削除した添付（raw）も GitHub への削除として反映される', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    // 添付を遅延キャッシュ相当で R2 とツリーキャッシュへ追加しておく
    await writeCachedRaw(
      bucket,
      OWNER,
      REPO,
      'attachments/a.png',
      new TextEncoder().encode('png-bytes').buffer,
      'image/png',
    );
    const tree = await readVaultTree(bucket, OWNER, REPO);
    if (tree) {
      await writeVaultTree(bucket, OWNER, REPO, {
        ...tree,
        entries: [...tree.entries, { path: 'attachments/a.png', type: 'file', sha: 'sha-png' }],
      });
    }
    // ローカル削除（実フロー: commit.ts の applyChangesToR2）
    await deleteCachedRaw(bucket, OWNER, REPO, 'attachments/a.png');
    await applyVaultTreeChanges(bucket, OWNER, REPO, [{ op: 'remove', path: 'attachments/a.png' }]);
    await markVaultDeleted(bucket, OWNER, REPO, 'attachments/a.png');
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
        { path: 'attachments/a.png', sha: 'sha-png', content: 'png-bytes' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 添付はプルの対象外（.md のみ）のため pulled 0、push で削除のみ反映される
    expect(outcome.result.pulled).toBe(0);
    expect(outcome.result.pushed).toBe(1);
    const treePosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/trees') && init?.method === 'POST',
    );
    expect(treePosts).toHaveLength(1);
    const treeBody = JSON.parse(String(treePosts[0]?.[3]?.body ?? '{}')) as {
      tree?: { path?: string; sha?: string | null }[];
    };
    expect(treeBody.tree?.find((entry) => entry.path === 'attachments/a.png')?.sha).toBeNull();
    expect(await isVaultDeleted(bucket, OWNER, REPO, 'attachments/a.png')).toBe(false);
  });

  it('R2 に取り込まれていないファイル（tombstone なし）を削除として push しない（回帰）', async () => {
    // 2026-08-16 の事故: 初期同期が Markdown 以外を取り込まない・取得失敗で
    // ノートが欠落する状態で、push が「ツリーキャッシュにあり GitHub にあるが
    // R2 に無い」ファイルを「ローカル削除」と誤認して GitHub から大量削除した。
    // 削除判定は tombstone（明示的な削除操作）のみを根拠にする仕様の回帰テスト
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    // image.png はツリーキャッシュに存在するが R2（notes/raw）には取り込まれていない
    const tree = await readVaultTree(bucket, OWNER, REPO);
    if (tree) {
      await writeVaultTree(bucket, OWNER, REPO, {
        ...tree,
        entries: [...tree.entries, { path: 'image.png', type: 'file', sha: 'sha-png' }],
      });
    }
    mockGithubApi({
      treeSha: 'tree-1',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
        { path: 'image.png', sha: 'sha-png', content: 'png-bytes' },
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // image.png の削除は push されない（変更なし扱い）
    expect(outcome.result.pushed).toBe(0);
    const treePosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/trees') && init?.method === 'POST',
    );
    expect(treePosts).toHaveLength(0);
  });

  it('削除ガード: 1 回の push で上限（100 件）を超える削除は too_many_deletes で中断する', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    // 101 件のローカル削除（tombstone）を記録する
    const deletedPaths = Array.from({ length: 101 }, (_, i) => `deleted-${i}.md`);
    await Promise.all(deletedPaths.map((path) => markVaultDeleted(bucket, OWNER, REPO, path)));
    mockGithubApi({
      treeSha: 'tree-1',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
        ...deletedPaths.map((path, i) => ({
          path,
          sha: `sha-del-${i}`,
          content: `# Deleted ${i}\n`,
        })),
      ],
    });

    const outcome = await syncVault(BASE_URL, 'token', bucket, OWNER, REPO, 'explicit', FIXED_NOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('too_many_deletes');
    // GitHub へのコミットは発生していない（誤削除の防波堤）
    const commitPosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/commits') && init?.method === 'POST',
    );
    expect(commitPosts).toHaveLength(0);
    // tombstone は残っている（削除は未反映）
    expect(await isVaultDeleted(bucket, OWNER, REPO, 'deleted-0.md')).toBe(true);
  });
});

describe('listSyncedVaults / recordSyncFailure', () => {
  it('保持中の全 Vault（meta がある Vault）を列挙する', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, OWNER, REPO, {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await writeVaultMeta(bucket, 'other', 'vault', {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-2',
    });

    const vaults = await listSyncedVaults(bucket);
    expect(vaults.map(({ owner, repo }) => ({ owner, repo }))).toEqual([
      { owner: 'octocat', repo: 'notes' },
      { owner: 'other', repo: 'vault' },
    ]);
  });

  it('recordSyncFailure は meta に失敗理由と日時を記録する（次回同期で自動リトライ）', async () => {
    const bucket = createFakeR2Bucket();
    await writeVaultMeta(bucket, OWNER, REPO, {
      syncedAt: '2026-08-13T00:00:00.000Z',
      defaultBranch: 'main',
      treeSha: 'tree-1',
    });
    await recordSyncFailure(bucket, OWNER, REPO, 'sync_conflict', FIXED_NOW);
    const meta = await readVaultMeta(bucket, OWNER, REPO);
    expect(meta?.lastSyncError).toBe('sync_conflict');
    expect(meta?.lastFailedAt).toBe('2026-08-13T02:00:00.000Z');
  });
});

describe('resolveSyncConflict', () => {
  it('overwrite: GitHub 側の内容で R2 を更新する', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    await writeCachedNote(bucket, OWNER, REPO, 'a.md', {
      sha: await sha256Hex('# A local\n'),
      content: '# A local\n',
    });
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a2', content: '# A remote\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await resolveSyncConflict(
      BASE_URL,
      'token',
      bucket,
      OWNER,
      REPO,
      'a.md',
      'overwrite',
    );
    expect(outcome.ok).toBe(true);
    expect(await readCachedNote(bucket, OWNER, REPO, 'a.md')).toEqual({
      sha: 'sha-a2',
      content: '# A remote\n',
    });
  });

  it('adopt: R2 のローカル内容を GitHub へ反映し、次回同期で一致する状態にする', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    await writeCachedNote(bucket, OWNER, REPO, 'a.md', {
      sha: await sha256Hex('# A local\n'),
      content: '# A local\n',
    });
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [
        { path: 'a.md', sha: 'sha-a2', content: '# A remote\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });

    const outcome = await resolveSyncConflict(
      BASE_URL,
      'token',
      bucket,
      OWNER,
      REPO,
      'a.md',
      'adopt',
    );
    expect(outcome.ok).toBe(true);
    // GitHub へのコミットが実行される
    const commitPosts = mocks.githubApiFetch.mock.calls.filter(
      ([, path, , init]) => String(path).endsWith('/git/commits') && init?.method === 'POST',
    );
    expect(commitPosts).toHaveLength(1);
    // R2 の sha が git blob sha に揃う（次回の同期で同一判定になる）
    expect(await readCachedNote(bucket, OWNER, REPO, 'a.md')).toEqual({
      sha: await gitBlobShaHex(new TextEncoder().encode('# A local\n')),
      content: '# A local\n',
    });
  });

  it('overwrite: GitHub 側で削除されたノートは R2 からも削除する', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    // b.md をローカル保存（SHA-256）+ GitHub 側で削除された状態
    await writeCachedNote(bucket, OWNER, REPO, 'b.md', {
      sha: await sha256Hex('# B local\n'),
      content: '# B local\n',
    });
    mockGithubApi({
      treeSha: 'tree-2',
      blobs: [{ path: 'a.md', sha: 'sha-a', content: '# A\n' }],
    });

    const outcome = await resolveSyncConflict(
      BASE_URL,
      'token',
      bucket,
      OWNER,
      REPO,
      'b.md',
      'overwrite',
    );
    expect(outcome.ok).toBe(true);
    expect(await readCachedNote(bucket, OWNER, REPO, 'b.md')).toBeNull();
  });

  it('存在しないノートの解決は 404 を返す', async () => {
    const bucket = createFakeR2Bucket();
    await seedSyncedVault(bucket, 'tree-1');
    mockGithubApi({
      treeSha: 'tree-1',
      blobs: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });
    const outcome = await resolveSyncConflict(
      BASE_URL,
      'token',
      bucket,
      OWNER,
      REPO,
      'missing.md',
      'overwrite',
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.response.status).toBe(404);
  });
});
