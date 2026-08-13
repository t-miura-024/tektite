/**
 * ファイル操作ユースケース（src/application/file.ts）のユニットテスト。
 *
 * 作成/リネーム/移動/削除が「リンク張り替え + 単一コミット」に変換されること、
 * 共有索引へ反映されること、検証エラーを検証する。
 */

import { Effect, Either, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  applyFileOperation,
  buildImagePath,
  imageExtension,
  uploadImage,
} from '@/application/file';
import type { FileOperation } from '@/application/file';
import { FileCommitError, NoteGateway } from '@/application/note';
import type { CommitChangesInput, NoteIndexData } from '@/application/note';
import { NoteIndexRegistry, createNoteIndexRegistry } from '@/application/note-index';
import type { VaultRef } from '@/domain/vault';

const REF: VaultRef = { owner: 'octocat', name: 'notes' };

const DATA: NoteIndexData = {
  defaultBranch: 'main',
  truncated: false,
  notes: [
    {
      path: 'a.md',
      sha: 'sha-a',
      content: '# A\n\n[[b]] を参照する。\n',
    },
    {
      path: 'b.md',
      sha: 'sha-b',
      content: '# B\n',
    },
    {
      path: 'attachments/logo.png',
      // 添付ファイルは索引に含まれない（filePaths 側だけに存在する）
      sha: 'sha-logo',
      content: '',
    },
  ],
};

/** ツリー由来の全ファイルパス（操作前） */
const FILE_PATHS = ['a.md', 'b.md', 'attachments/logo.png'];

interface FakeGateway extends NoteGateway {
  readonly lastInput: () => CommitChangesInput | null;
}

/** commitChanges の入力を記録するフェイクゲートウェイ */
function fakeGateway(notes: NoteIndexData = DATA): FakeGateway {
  let last: CommitChangesInput | null = null;
  return {
    fetchAllNotes: vi.fn(() => Effect.succeed(notes)),
    fetchNote: vi.fn(() => Effect.fail(new Error('unused'))),
    saveNote: vi.fn(() => Effect.fail(new Error('unused'))),
    commitChanges: vi.fn((_ref: VaultRef, input: CommitChangesInput) => {
      last = input;
      return Effect.succeed({ owner: REF.owner, name: REF.name, branch: 'main', commitSha: 'c1' });
    }),
    lastInput: () => last,
  } as unknown as FakeGateway;
}

function provide(registry: NoteIndexRegistry, gateway: NoteGateway) {
  return Layer.merge(
    Layer.succeed(NoteGateway, gateway),
    Layer.succeed(NoteIndexRegistry, registry),
  );
}

async function runOperation(
  operation: FileOperation,
  filePaths: readonly string[] = FILE_PATHS,
  gateway: FakeGateway = fakeGateway(),
) {
  const registry = createNoteIndexRegistry();
  const result = await Effect.runPromise(
    Effect.provide(applyFileOperation(REF, operation, filePaths), provide(registry, gateway)),
  );
  return { result, registry, gateway };
}

/** 失敗系の検証: FiberFailure のラップを解除した FileCommitError を返す */
async function runOperationEither(
  operation: FileOperation,
  filePaths: readonly string[] = FILE_PATHS,
  gateway: FakeGateway = fakeGateway(),
) {
  const registry = createNoteIndexRegistry();
  const result = await Effect.runPromise(
    Effect.either(
      Effect.provide(applyFileOperation(REF, operation, filePaths), provide(registry, gateway)),
    ),
  );
  if (Either.isRight(result)) {
    throw new Error('操作が成功してしまいました');
  }
  return { error: result.left, registry, gateway };
}

describe('applyFileOperation', () => {
  it('create-note は空のノートを 1 コミットで作成する', async () => {
    const { result, registry, gateway } = await runOperation({
      kind: 'create-note',
      path: 'new.md',
    });

    expect(result.createdPaths).toEqual(['new.md']);
    expect(result.issues).toEqual([]);
    expect(gateway.lastInput()).toEqual({
      message: 'Create new.md',
      changes: [{ op: 'create', path: 'new.md', content: '' }],
    });
    expect(registry.get(REF)?.notes.get('new.md')).toEqual({
      path: 'new.md',
      sha: '',
      content: '',
    });
  });

  it('create-note は既存パスなら失敗する', async () => {
    const { error } = await runOperationEither({ kind: 'create-note', path: 'a.md' });
    expect(error).toBeInstanceOf(FileCommitError);
    expect((error as FileCommitError).message).toBe('「a.md」は既に存在します。');
  });

  it('create-directory は .gitkeep を作成して空ディレクトリを表現する', async () => {
    const { result, registry, gateway } = await runOperation({
      kind: 'create-directory',
      path: 'daily',
    });

    expect(result.createdPaths).toEqual(['daily']);
    expect(gateway.lastInput()?.changes).toEqual([
      { op: 'create', path: 'daily/.gitkeep', content: '' },
    ]);
    expect(gateway.lastInput()?.message).toBe('Create directory daily/');
    expect(registry.get(REF)?.notes.has('daily/.gitkeep')).toBe(true);
  });

  it('create-note は content を渡すと本文込みで 1 コミットで作成する（Obsidian 式）', async () => {
    const { result, gateway } = await runOperation({
      kind: 'create-note',
      path: 'new.md',
      content: '# New\n',
    });

    expect(result.createdPaths).toEqual(['new.md']);
    expect(gateway.lastInput()?.changes).toEqual([
      { op: 'create', path: 'new.md', content: '# New\n' },
    ]);
    expect(gateway.lastInput()?.message).toBe('Create new.md');
  });

  it('duplicate-note は copy で内容を複製し、元は残す', async () => {
    const { result, registry, gateway } = await runOperation({
      kind: 'duplicate-note',
      from: 'a.md',
      to: 'a copy.md',
    });

    expect(result.createdPaths).toEqual(['a copy.md']);
    expect(result.movedPaths).toEqual([]);
    expect(result.removedPaths).toEqual([]);
    expect(gateway.lastInput()).toEqual({
      message: 'Duplicate a.md to a copy.md',
      changes: [{ op: 'copy', path: 'a.md', to: 'a copy.md' }],
    });
    // 元と複製の両方が索引に残る（WikiLink は張り替えない）
    expect(registry.get(REF)?.notes.get('a copy.md')?.content).toBe('# A\n\n[[b]] を参照する。\n');
    expect(registry.get(REF)?.notes.get('a.md')).toBeDefined();
  });

  it('duplicate-note は存在しない移動元で失敗し、コミットしない', async () => {
    const { error, gateway } = await runOperationEither({
      kind: 'duplicate-note',
      from: 'missing.md',
      to: 'missing copy.md',
    });
    expect((error as FileCommitError).message).toBe('「missing.md」は存在しません。');
    expect(gateway.lastInput()).toBeNull();
  });

  it('duplicate-note は複製先が既存なら失敗し、コミットしない', async () => {
    const { error, gateway } = await runOperationEither({
      kind: 'duplicate-note',
      from: 'a.md',
      to: 'b.md',
    });
    expect((error as FileCommitError).message).toBe('「b.md」は既に存在します。');
    expect(gateway.lastInput()).toBeNull();
  });

  it('duplicate-directory は配下の全ファイル（添付含む）を複製し、元は残す', async () => {
    const gateway = fakeGateway({
      ...DATA,
      notes: [
        { path: 'projects/tektite.md', sha: 'sha-t', content: '# tektite\n' },
        { path: 'index.md', sha: 'sha-i', content: '# Index\n\n[[tektite]]\n' },
      ],
    });
    const paths = ['index.md', 'projects/tektite.md', 'projects/assets/logo.png'];
    const {
      result,
      registry,
      gateway: captured,
    } = await runOperation(
      { kind: 'duplicate-directory', from: 'projects', to: 'projects copy' },
      paths,
      gateway,
    );

    expect(result.createdPaths).toEqual(['projects copy']);
    expect(captured.lastInput()?.changes).toEqual([
      { op: 'copy', path: 'projects/tektite.md', to: 'projects copy/tektite.md' },
      { op: 'copy', path: 'projects/assets/logo.png', to: 'projects copy/assets/logo.png' },
    ]);
    expect(captured.lastInput()?.message).toBe('Duplicate directory projects to projects copy');
    // 元のノートも複製も残る（リンク張り替えなし）
    expect(registry.get(REF)?.notes.get('projects/tektite.md')).toBeDefined();
    expect(registry.get(REF)?.notes.get('projects copy/tektite.md')?.content).toBe('# tektite\n');
  });

  it('duplicate-directory は展開後の複製先が既存と衝突すると失敗し、コミットしない', async () => {
    const gateway = fakeGateway({
      ...DATA,
      notes: [
        { path: 'projects/tektite.md', sha: 'sha-t', content: '# tektite\n' },
        { path: 'projects copy/tektite.md', sha: 'sha-c', content: '# copy\n' },
      ],
    });
    const paths = ['projects/tektite.md', 'projects copy/tektite.md'];
    const { error, gateway: captured } = await runOperationEither(
      { kind: 'duplicate-directory', from: 'projects', to: 'projects copy' },
      paths,
      gateway,
    );
    expect((error as FileCommitError).message).toBe(
      '複製先「projects copy/tektite.md」は既に存在します。',
    );
    expect(captured.lastInput()).toBeNull();
  });

  it('duplicate-directory は存在しないディレクトリで失敗する', async () => {
    const { error } = await runOperationEither({
      kind: 'duplicate-directory',
      from: 'missing',
      to: 'missing copy',
    });
    expect((error as FileCommitError).message).toBe('「missing」は存在しません。');
  });

  it('delete-note は 1 コミットで削除し、索引からも除去する', async () => {
    const { result, registry, gateway } = await runOperation({
      kind: 'delete-note',
      path: 'b.md',
    });

    expect(result.removedPaths).toEqual(['b.md']);
    expect(gateway.lastInput()).toEqual({
      message: 'Delete b.md',
      changes: [{ op: 'delete', path: 'b.md' }],
    });
    expect(registry.get(REF)?.notes.has('b.md')).toBe(false);
  });

  it('rename-note は移動 + 参照ノートの張り替えを 1 コミットに束ねる', async () => {
    const { result, registry, gateway } = await runOperation({
      kind: 'rename-note',
      from: 'b.md',
      to: 'notes/b.md',
    });

    expect(result.movedPaths).toEqual([{ from: 'b.md', to: 'notes/b.md' }]);
    expect(gateway.lastInput()).toEqual({
      message: 'Rename b.md to notes/b.md',
      changes: [
        { op: 'move', path: 'b.md', to: 'notes/b.md' },
        { op: 'update', path: 'a.md', content: '# A\n\n[[notes/b.md]] を参照する。\n' },
      ],
    });
    // 共有索引: a.md は張り替え後、b.md は移動先へ引き継がれる
    const notes = registry.get(REF)?.notes;
    expect(notes?.get('a.md')?.content).toBe('# A\n\n[[notes/b.md]] を参照する。\n');
    expect(notes?.has('b.md')).toBe(false);
    expect(notes?.get('notes/b.md')).toEqual({
      path: 'notes/b.md',
      sha: '',
      content: '# B\n',
    });
  });

  it('rename-note は移動元ノート自身の自己参照も張り替える', async () => {
    const gateway = fakeGateway({
      ...DATA,
      notes: [
        { path: 'a.md', sha: 'sha-a', content: '# A\n\n[[a#X]]\n' },
        { path: 'b.md', sha: 'sha-b', content: '# B\n' },
      ],
    });
    const { gateway: captured } = await runOperation(
      { kind: 'rename-note', from: 'a.md', to: 'notes/a.md' },
      ['a.md', 'b.md'],
      gateway,
    );

    expect(captured.lastInput()?.changes).toEqual([
      { op: 'move', path: 'a.md', to: 'notes/a.md' },
      { op: 'update', path: 'notes/a.md', content: '# A\n\n[[notes/a.md#X]]\n' },
    ]);
  });

  it('rename-note は移動先が既存なら失敗し、コミットしない', async () => {
    const { error, gateway } = await runOperationEither(
      { kind: 'rename-note', from: 'a.md', to: 'b.md' },
      FILE_PATHS,
    );
    expect(error).toBeInstanceOf(FileCommitError);
    expect(gateway.lastInput()).toBeNull();
  });

  it('rename-note は存在しない移動元で失敗する', async () => {
    const { error } = await runOperationEither({
      kind: 'rename-note',
      from: 'missing.md',
      to: 'x.md',
    });
    expect(error).toBeInstanceOf(FileCommitError);
    expect((error as FileCommitError).message).toBe('「missing.md」は存在しません。');
  });

  it('rename-directory は展開後の移動先が既存ファイルと衝突すると失敗し、コミットしない', async () => {
    // projects/tektite.md を daily/ へ移動すると daily/tektite.md（既存）と衝突する
    const gateway = fakeGateway({
      ...DATA,
      notes: [
        { path: 'projects/tektite.md', sha: 'sha-t', content: '# tektite\n' },
        { path: 'daily/tektite.md', sha: 'sha-d', content: '# daily\n' },
      ],
    });
    const { error, gateway: captured } = await runOperationEither(
      { kind: 'rename-directory', from: 'projects', to: 'daily' },
      ['projects/tektite.md', 'daily/tektite.md'],
      gateway,
    );
    expect(error).toBeInstanceOf(FileCommitError);
    expect((error as FileCommitError).message).toBe('移動先「daily/tektite.md」は既に存在します。');
    expect(captured.lastInput()).toBeNull();
  });

  it('rename-directory は配下の全ファイル（添付含む）を移動し、リンクを張り替える', async () => {
    const gateway = fakeGateway({
      ...DATA,
      notes: [
        {
          path: 'projects/tektite.md',
          sha: 'sha-t',
          content: '# tektite\n',
        },
        {
          path: 'index.md',
          sha: 'sha-i',
          content: '# Index\n\n[[tektite]] と ![[projects/assets/logo.png]]\n',
        },
      ],
    });
    const paths = ['index.md', 'projects/tektite.md', 'projects/assets/logo.png'];
    const {
      result,
      registry,
      gateway: captured,
    } = await runOperation(
      { kind: 'rename-directory', from: 'projects', to: 'archive/projects' },
      paths,
      gateway,
    );

    expect(result.movedPaths).toEqual([
      { from: 'projects/tektite.md', to: 'archive/projects/tektite.md' },
      { from: 'projects/assets/logo.png', to: 'archive/projects/assets/logo.png' },
    ]);
    const changes = captured.lastInput()?.changes ?? [];
    // 添付は move（本文なし）、ノートは move + 張り替え update、参照元は update
    expect(changes).toContainEqual({
      op: 'move',
      path: 'projects/assets/logo.png',
      to: 'archive/projects/assets/logo.png',
    });
    expect(changes).toContainEqual({
      op: 'update',
      path: 'index.md',
      content:
        '# Index\n\n[[archive/projects/tektite.md]] と ![[archive/projects/assets/logo.png]]\n',
    });
    expect(registry.get(REF)?.notes.get('index.md')?.content).toBe(
      '# Index\n\n[[archive/projects/tektite.md]] と ![[archive/projects/assets/logo.png]]\n',
    );
  });

  it('delete-directory は配下の全ファイルを削除する', async () => {
    const gateway = fakeGateway({
      ...DATA,
      notes: [
        { path: 'projects/tektite.md', sha: 'sha-t', content: '# tektite\n' },
        { path: 'projects/roadmap.md', sha: 'sha-r', content: '# roadmap\n' },
      ],
    });
    const paths = ['projects/tektite.md', 'projects/roadmap.md', 'projects/assets/logo.png'];
    const { result, gateway: captured } = await runOperation(
      { kind: 'delete-directory', path: 'projects' },
      paths,
      gateway,
    );

    expect(result.removedPaths).toEqual([
      'projects/tektite.md',
      'projects/roadmap.md',
      'projects/assets/logo.png',
    ]);
    expect(captured.lastInput()?.message).toBe('Delete directory projects/');
    expect(captured.lastInput()?.changes).toEqual([
      { op: 'delete', path: 'projects/tektite.md' },
      { op: 'delete', path: 'projects/roadmap.md' },
      { op: 'delete', path: 'projects/assets/logo.png' },
    ]);
  });

  it('rename 時に曖昧参照があると issues に入り、コミットは成功する', async () => {
    const gateway = fakeGateway({
      ...DATA,
      notes: [
        { path: 'x.md', sha: 'sha-x', content: '# X\n\n[[a]]\n' },
        { path: 'dir1/a.md', sha: 'sha-a1', content: '# A1\n' },
        { path: 'dir2/a.md', sha: 'sha-a2', content: '# A2\n' },
      ],
    });
    const { result } = await runOperation(
      { kind: 'rename-note', from: 'dir2/a.md', to: 'dir2/renamed.md' },
      ['x.md', 'dir1/a.md', 'dir2/a.md'],
      gateway,
    );

    expect(result.issues).toEqual([
      {
        kind: 'ambiguous',
        path: 'x.md',
        target: 'a',
        movedCandidates: ['dir2/a.md'],
      },
    ]);
    // 張り替え対象がなければ update は発生せず、move だけがコミットされる
    expect(gateway.lastInput()?.changes).toEqual([
      { op: 'move', path: 'dir2/a.md', to: 'dir2/renamed.md' },
    ]);
  });

  it('コミット失敗（conflict）は FileCommitError として伝播する', async () => {
    const gateway = fakeGateway();
    (gateway.commitChanges as ReturnType<typeof vi.fn>).mockReturnValue(
      Effect.fail(new FileCommitError('conflict', 'ブランチが移動しました。')),
    );
    const registry = createNoteIndexRegistry();
    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          applyFileOperation(REF, { kind: 'create-note', path: 'new.md' }, FILE_PATHS),
          provide(registry, gateway),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(FileCommitError);
      expect((result.left as FileCommitError).kind).toBe('conflict');
    }
  });
});

// ---- M2: 画像アップロード ----

/** 画像 base64 の固定値（1x1 PNG の base64。形式検証だけに使う） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 成功系: 一括コミット（create-binary）と索引反映を検証する */
async function runUpload(input: Parameters<typeof uploadImage>[1]) {
  const registry = createNoteIndexRegistry();
  const gateway = fakeGateway();
  // Vault 表示中は索引が展開済みの想定（applyFileChanges の反映を確認するため）
  await Effect.runPromise(Effect.provide(registry.load(REF), provide(registry, gateway)));
  const result = await Effect.runPromise(
    Effect.provide(uploadImage(REF, input), provide(registry, gateway)),
  );
  return { result, registry, gateway };
}

/** 失敗系: FiberFailure のラップを解除した FileCommitError を返す */
async function runUploadEither(input: Parameters<typeof uploadImage>[1]) {
  const registry = createNoteIndexRegistry();
  const gateway = fakeGateway();
  const result = await Effect.runPromise(
    Effect.either(Effect.provide(uploadImage(REF, input), provide(registry, gateway))),
  );
  if (Either.isRight(result)) {
    throw new Error('アップロードが成功してしまいました');
  }
  return { error: result.left, registry, gateway };
}

describe('uploadImage（画像アップロード）', () => {
  it('画像を attachments/ の一意パスへ 1 コミットで保存し、パスを返す', async () => {
    const { result, registry, gateway } = await runUpload({
      fileName: 'screenshot.png',
      base64: PNG_BASE64,
    });

    // パスは `attachments/YYYYMMDDHHMMSS-乱数.png` の一意形式
    expect(result.path).toMatch(/^attachments\/\d{14}-[a-z0-9]{4}\.png$/);
    expect(gateway.lastInput()).toEqual({
      message: `Create ${result.path}`,
      changes: [{ op: 'create-binary', path: result.path, base64: PNG_BASE64 }],
    });
    // 添付（画像）はノート索引に混ぜない
    expect(registry.get(REF)?.notes.has(result.path)).toBe(false);
    expect(registry.get(REF)?.notes.has('a.md')).toBe(true);
  });

  it('保存先ディレクトリを指定できる', async () => {
    const { result } = await runUpload({
      fileName: 'photo.jpg',
      base64: PNG_BASE64,
      directory: 'photos',
    });
    expect(result.path).toMatch(/^photos\/\d{14}-[a-z0-9]{4}\.jpg$/);
  });

  it('画像以外の拡張子は検証エラーになり、コミットしない', async () => {
    const { error, gateway } = await runUploadEither({
      fileName: 'note.md',
      base64: PNG_BASE64,
    });
    expect(error).toBeInstanceOf(FileCommitError);
    expect((error as FileCommitError).message).toBe('画像ファイル名が不正です。');
    expect(gateway.lastInput()).toBeNull();
  });

  it('base64 でない画像データは検証エラーになる', async () => {
    const { error, gateway } = await runUploadEither({
      fileName: 'image.png',
      base64: 'not base64!!!',
    });
    expect(error).toBeInstanceOf(FileCommitError);
    expect((error as FileCommitError).message).toBe('画像データが不正です。');
    expect(gateway.lastInput()).toBeNull();
  });

  it('コミット失敗（conflict）は FileCommitError として伝播する', async () => {
    const registry = createNoteIndexRegistry();
    const gateway = fakeGateway();
    (gateway.commitChanges as ReturnType<typeof vi.fn>).mockReturnValue(
      Effect.fail(new FileCommitError('conflict', 'ブランチが移動しました。')),
    );
    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          uploadImage(REF, { fileName: 'image.png', base64: PNG_BASE64 }),
          provide(registry, gateway),
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect((result.left as FileCommitError).kind).toBe('conflict');
    }
  });
});

describe('画像パスの組み立て', () => {
  it('imageExtension は画像拡張子を小文字で返す', () => {
    expect(imageExtension('screenshot.PNG')).toBe('png');
    expect(imageExtension('photo.jpeg')).toBe('jpeg');
    expect(imageExtension('note.md')).toBeNull();
    expect(imageExtension('image')).toBeNull();
    expect(imageExtension('.gitignore')).toBeNull();
  });

  it('buildImagePath はタイムスタンプ + 乱数で一意なパスを作る', () => {
    // 2026-08-09T12:34:56Z → 20260809123456
    const timestamp = Date.UTC(2026, 7, 9, 12, 34, 56);
    expect(buildImagePath('photo.png', 'attachments', timestamp, 'ab12')).toBe(
      'attachments/20260809123456-ab12.png',
    );
    // 拡張子が画像でない場合は null
    expect(buildImagePath('note.md', 'attachments', timestamp, 'ab12')).toBeNull();
  });
});
