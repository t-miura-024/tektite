/**
 * R2 Vault ストレージ層（r2-vault.ts）のユニットテスト。
 *
 * メモリ上のフェイク R2 バケットに対して、キー設計（meta / tree / notes /
 * raw）と読み書き・一覧の動作を検証する。
 */

import { describe, expect, it } from 'vitest';

import {
  applyVaultTreeChanges,
  deleteCachedNote,
  deleteCachedRaw,
  listCachedNotes,
  readCachedNote,
  readCachedRaw,
  readVaultMeta,
  readVaultTree,
  vaultRawKey,
  vaultTreeKey,
  writeCachedNote,
  writeCachedRaw,
  writeVaultMeta,
  writeVaultTree,
} from './r2-vault';

/** テスト用のメモリ R2 バケット（workers-types の R2Bucket の最小フェイク） */
class FakeR2Bucket {
  private readonly objects = new Map<
    string,
    { body: ArrayBuffer; metadata?: Record<string, string> }
  >();

  async get(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    return object === undefined ? null : new FakeR2ObjectBody(object);
  }

  async put(
    key: string,
    value: string | ArrayBuffer,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown> {
    const body = typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
    this.objects.set(key, { body, metadata: options?.customMetadata });
    return { key };
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<unknown> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    const objects = keys.map((key) => {
      const object = this.objects.get(key);
      return { key, size: object?.body.byteLength ?? 0 };
    });
    return { objects, truncated: false, cursor: undefined };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeR2ObjectBody {
  constructor(private readonly data: { body: ArrayBuffer; metadata?: Record<string, string> }) {}

  get customMetadata(): Record<string, string> {
    return this.data.metadata ?? {};
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(this.data.body));
  }
}

function createBucket(): R2Bucket {
  return new FakeR2Bucket() as unknown as R2Bucket;
}

const OWNER = 'octocat';
const REPO = 'notes';

describe('r2-vault ストレージ層', () => {
  describe('meta', () => {
    it('未書き込みは null を返す', async () => {
      const bucket = createBucket();
      expect(await readVaultMeta(bucket, OWNER, REPO)).toBeNull();
    });

    it('書き込んだ meta を読み戻せる（treeSha は null 許容）', async () => {
      const bucket = createBucket();
      await writeVaultMeta(bucket, OWNER, REPO, {
        syncedAt: '2026-08-13T00:00:00.000Z',
        defaultBranch: 'main',
        treeSha: 'tree-1',
      });
      expect(await readVaultMeta(bucket, OWNER, REPO)).toEqual({
        syncedAt: '2026-08-13T00:00:00.000Z',
        defaultBranch: 'main',
        treeSha: 'tree-1',
        lastSyncError: null,
        lastFailedAt: null,
      });

      const empty = createBucket();
      await writeVaultMeta(empty, OWNER, REPO, {
        syncedAt: '2026-08-13T00:00:00.000Z',
        defaultBranch: 'main',
        treeSha: null,
      });
      expect((await readVaultMeta(empty, OWNER, REPO))?.treeSha).toBeNull();
    });

    it('形式不正な meta は null を返す（破損は GitHub フォールバックになる）', async () => {
      const bucket = createBucket();
      await bucket.put(vaultTreeKey(OWNER, REPO), JSON.stringify({ broken: true }));
      const metaBucket = createBucket();
      // meta キーに不正 JSON を入れる
      await (metaBucket as unknown as FakeR2Bucket).put(`vaults/${OWNER}/${REPO}/meta`, 'not-json');
      expect(await readVaultMeta(metaBucket, OWNER, REPO)).toBeNull();
    });
  });

  describe('tree', () => {
    it('書き込んだツリーを読み戻せる（entries の型を整形する）', async () => {
      const bucket = createBucket();
      await writeVaultTree(bucket, OWNER, REPO, {
        defaultBranch: 'main',
        truncated: false,
        treeSha: 'tree-1',
        entries: [
          { path: 'a.md', type: 'file' },
          { path: 'daily', type: 'directory' },
        ],
      });
      expect(await readVaultTree(bucket, OWNER, REPO)).toEqual({
        defaultBranch: 'main',
        truncated: false,
        treeSha: 'tree-1',
        entries: [
          { path: 'a.md', type: 'file', sha: null },
          { path: 'daily', type: 'directory', sha: null },
        ],
      });
    });

    it('不正な type のエントリは除外する', async () => {
      const bucket = createBucket();
      await bucket.put(
        vaultTreeKey(OWNER, REPO),
        JSON.stringify({
          defaultBranch: 'main',
          truncated: true,
          treeSha: null,
          entries: [
            { path: 'a.md', type: 'file' },
            { path: 'b.md', type: 'invalid' },
            { path: 'c.md' },
          ],
        }),
      );
      const tree = await readVaultTree(bucket, OWNER, REPO);
      expect(tree?.entries).toEqual([{ path: 'a.md', type: 'file', sha: null }]);
      expect(tree?.truncated).toBe(true);
    });
  });

  describe('notes', () => {
    it('ノートを書き込んで読み戻せる（パスはキーに含まれる）', async () => {
      const bucket = createBucket();
      await writeCachedNote(bucket, OWNER, REPO, 'daily/2026-08-13.md', {
        sha: 'sha-1',
        content: '# 本文',
      });
      expect(await readCachedNote(bucket, OWNER, REPO, 'daily/2026-08-13.md')).toEqual({
        sha: 'sha-1',
        content: '# 本文',
      });
      // 別パスのノートは null（キーの区別が正しいこと）
      expect(await readCachedNote(bucket, OWNER, REPO, 'other.md')).toBeNull();
    });

    it('listCachedNotes は prefix 下の全ノートを path と共に返す', async () => {
      const bucket = createBucket();
      await writeCachedNote(bucket, OWNER, REPO, 'a.md', { sha: 'sha-a', content: 'A' });
      await writeCachedNote(bucket, OWNER, REPO, 'daily/b.md', {
        sha: 'sha-b',
        content: 'B',
      });
      await writeVaultMeta(bucket, OWNER, REPO, {
        syncedAt: '2026-08-13T00:00:00.000Z',
        defaultBranch: 'main',
        treeSha: 'tree-1',
      });
      const notes = await listCachedNotes(bucket, OWNER, REPO);
      expect(notes).toEqual([
        { path: 'a.md', note: { sha: 'sha-a', content: 'A' } },
        { path: 'daily/b.md', note: { sha: 'sha-b', content: 'B' } },
      ]);
      // meta / tree キーは prefix が違うため含まれない
      expect(notes.map((entry) => entry.path)).not.toContain('meta');
    });

    it('listCachedNotes は Vault ごとに分離される', async () => {
      const bucket = createBucket();
      await writeCachedNote(bucket, OWNER, REPO, 'a.md', { sha: 'sha-a', content: 'A' });
      await writeCachedNote(bucket, 'other', 'vault', 'x.md', { sha: 'sha-x', content: 'X' });
      const notes = await listCachedNotes(bucket, OWNER, REPO);
      expect(notes).toEqual([{ path: 'a.md', note: { sha: 'sha-a', content: 'A' } }]);
    });
  });

  describe('raw', () => {
    it('バイナリ本文と Content-Type を書き込んで読み戻せる', async () => {
      const bucket = createBucket();
      const body = new TextEncoder().encode('png-bytes').buffer;
      await writeCachedRaw(bucket, OWNER, REPO, 'attachments/logo.png', body, 'image/png');
      const raw = await readCachedRaw(bucket, OWNER, REPO, 'attachments/logo.png');
      expect(raw?.contentType).toBe('image/png');
      expect(new TextDecoder().decode(raw?.body)).toBe('png-bytes');
    });

    it('未書き込みは null を返す', async () => {
      const bucket = createBucket();
      expect(await readCachedRaw(bucket, OWNER, REPO, 'attachments/logo.png')).toBeNull();
    });

    it('Content-Type が無いオブジェクトは application/octet-stream として返す', async () => {
      const bucket = createBucket();
      const body = new TextEncoder().encode('x').buffer;
      await (bucket as unknown as FakeR2Bucket).put(vaultRawKey(OWNER, REPO, 'f.bin'), body);
      const raw = await readCachedRaw(bucket, OWNER, REPO, 'f.bin');
      expect(raw?.contentType).toBe('application/octet-stream');
    });
  });

  describe('delete', () => {
    it('deleteCachedNote / deleteCachedRaw はオブジェクトを削除する', async () => {
      const bucket = createBucket();
      await writeCachedNote(bucket, OWNER, REPO, 'a.md', { sha: 'sha-a', content: 'A' });
      await writeCachedRaw(
        bucket,
        OWNER,
        REPO,
        'attachments/a.png',
        new TextEncoder().encode('png').buffer,
        'image/png',
      );

      await deleteCachedNote(bucket, OWNER, REPO, 'a.md');
      await deleteCachedRaw(bucket, OWNER, REPO, 'attachments/a.png');

      expect(await readCachedNote(bucket, OWNER, REPO, 'a.md')).toBeNull();
      expect(await readCachedRaw(bucket, OWNER, REPO, 'attachments/a.png')).toBeNull();
    });

    it('存在しないキーの削除は何もしない（エラーにならない）', async () => {
      const bucket = createBucket();
      await expect(deleteCachedNote(bucket, OWNER, REPO, 'missing.md')).resolves.toBeUndefined();
      await expect(deleteCachedRaw(bucket, OWNER, REPO, 'missing.png')).resolves.toBeUndefined();
    });
  });

  describe('applyVaultTreeChanges', () => {
    it('ファイルの追加/削除を反映し、ディレクトリエントリを再構成する', async () => {
      const bucket = createBucket();
      await writeVaultTree(bucket, OWNER, REPO, {
        defaultBranch: 'main',
        truncated: false,
        treeSha: 'tree-1',
        entries: [
          { path: 'a.md', type: 'file' },
          { path: 'daily/b.md', type: 'file' },
          { path: 'daily', type: 'directory' },
        ],
      });

      // b.md を daily から projects へ移動 + a.md を削除 + c.md を追加
      await applyVaultTreeChanges(bucket, OWNER, REPO, [
        { op: 'remove', path: 'daily/b.md' },
        { op: 'remove', path: 'a.md' },
        { op: 'add', path: 'projects/b.md' },
        { op: 'add', path: 'c.md' },
      ]);

      expect(await readVaultTree(bucket, OWNER, REPO)).toEqual({
        defaultBranch: 'main',
        truncated: false,
        treeSha: 'tree-1',
        entries: [
          { path: 'c.md', type: 'file', sha: null },
          { path: 'projects/b.md', type: 'file', sha: null },
          { path: 'projects', type: 'directory', sha: null },
        ],
      });
      // 空になった daily ディレクトリは残らない
    });

    it('ツリー未キャッシュの Vault は何もしない', async () => {
      const bucket = createBucket();
      await expect(
        applyVaultTreeChanges(bucket, OWNER, REPO, [{ op: 'add', path: 'a.md' }]),
      ).resolves.toBeUndefined();
      expect(await readVaultTree(bucket, OWNER, REPO)).toBeNull();
    });
  });
});
