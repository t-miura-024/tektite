/**
 * ファイル操作ユースケース（M5: ノート/ディレクトリの作成・リネーム・移動・削除）。
 *
 * UI の操作（FileOperation）を、リンク張り替え（src/domain/notation/rewrite）と
 * 一括コミット（NoteGateway.commitChanges → functions/api/files）に変換して実行する。
 * 変更列の組み立てと検証は src/application/file-changes が担う。
 *
 * 方針:
 * - リネーム/移動は必ず「移動 + リンク張り替え + 影響ノート更新」を 1 コミットに
 *   束ねる（計画方針 2: Git Trees/Blobs API で単一コミット。逐次コミットしない）
 * - 削除は GitHub 上の実削除（確認ダイアログは UI が挟む。ゴミ箱は作らない）
 * - ディレクトリ操作は配下の全ファイル（添付含む）へ展開する。ディレクトリ作成は
 *   GitHub が空ディレクトリを保持できないため `.gitkeep` を作る
 * - リンク張り替えの入力は共有索引（NoteIndexRegistry）の本文と、UI が持つ
 *   ファイルツリーの全パス（filePaths）を使う
 * - 画像アップロード（uploadImage）も一括コミット基盤を再利用する（M2）。
 *   バイナリは UTF-8 テキストと別系統（create-binary）で base64 のまま渡す
 *
 * エラー: 検証（パス重複など）とコミット失敗は FileCommitError、
 * 索引の読み込み失敗は NoteFetchError で返る（UI は既存のエラー変換を再利用する）。
 */

import { Effect } from 'effect';

import {
  buildChanges,
  type FileOperation,
  type FileOperationResult,
} from '@/application/file-changes';
import { isValidPath } from '@/application/file-changes-entries';
import {
  fileCommitError,
  NoteGateway,
  type CommitChangesInput,
  type FileChange,
  type FileCommitError,
} from '@/application/note';
import { NoteIndexRegistry, type NoteIndex } from '@/application/note-index';
import type { VaultRef } from '@/domain/vault';

export type { FileOperation, FileOperationResult };

/** 名前検証: セグメントとして不正な文字（WikiLink 記法と衝突するもの） */
const INVALID_NAME_CHARS = /[/\\#|[\]<>:?*"]/;

/**
 * 作成/リネームの名前（ファイル名・ディレクトリ名の 1 セグメント）を検証する。
 * 不正な場合はエラーメッセージ、正しければ null を返す。
 */
export function validateEntryName(name: string, isNote: boolean): string | null {
  const trimmed = name.trim();
  if (trimmed === '') {
    return '名前を入力してください。';
  }
  if (trimmed !== name) {
    return '名前の前後に空白を入れないでください。';
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) {
    return 'ドット始まりの名前は使えません。';
  }
  if (INVALID_NAME_CHARS.test(trimmed)) {
    return '名前に / \\ # | [ ] < > : ? * " は使えません。';
  }
  if (isNote && !trimmed.endsWith('.md')) {
    return 'ノートのファイル名は .md で終わる必要があります。';
  }
  return null;
}

/** 操作のコミットメッセージ（既存の自動生成テンプレートと同系） */
function commitMessage(operation: FileOperation): string {
  if (operation.kind === 'create-note') {
    return `Create ${operation.path}`;
  }
  if (operation.kind === 'create-directory') {
    return `Create directory ${operation.path}/`;
  }
  if (operation.kind === 'delete-note') {
    return `Delete ${operation.path}`;
  }
  if (operation.kind === 'delete-directory') {
    return `Delete directory ${operation.path}/`;
  }
  if (operation.kind === 'rename-note') {
    return `Rename ${operation.from} to ${operation.to}`;
  }
  if (operation.kind === 'rename-directory') {
    return `Rename directory ${operation.from} to ${operation.to}`;
  }
  if (operation.kind === 'duplicate-note') {
    return `Duplicate ${operation.from} to ${operation.to}`;
  }
  return `Duplicate directory ${operation.from} to ${operation.to}`;
}

/**
 * ファイル操作を実行する（単一コミット + 共有索引の反映）。
 * filePaths は操作前の全ファイルパス（UI がツリーから収集したもの）を渡す。
 */
export const applyFileOperation = (
  ref: VaultRef,
  operation: FileOperation,
  filePaths: readonly string[],
): Effect.Effect<FileOperationResult, FileCommitError | Error, NoteGateway | NoteIndexRegistry> =>
  Effect.gen(function* () {
    const gateway = yield* NoteGateway;
    const registry = yield* NoteIndexRegistry;
    const index: NoteIndex = yield* registry.load(ref);
    const contents = new Map(
      [...index.notes.entries()].map(([path, note]) => [path, note.content]),
    );

    const built = buildChanges(operation, filePaths, contents);
    if (!built.ok) {
      return yield* Effect.fail(built.error);
    }
    const { changes, result } = built;
    const input: CommitChangesInput = { changes, message: commitMessage(operation) };
    yield* gateway.commitChanges(ref, input);

    // 共有索引へ反映（ツリー再読込後の検索・バックリンクが新パスで動くようにする）
    registry.applyFileChanges(ref, changes);
    return result;
  });

// ---- M2: 画像アップロード ----

/** 画像アップロードの入力（fileName の拡張子で画像種別を検証する） */
export type UploadImageInput = {
  /** 元のファイル名（例: screenshot.png。拡張子が無い場合は不正） */
  readonly fileName: string;
  /** 画像バイナリの標準 base64（btoa 互換。コミット API の content と同じ規約） */
  readonly base64: string;
  /** 保存先ディレクトリ（省略時は attachments。Obsidian の添付フォルダ規約） */
  readonly directory?: string;
};

/** 画像アップロードの結果 */
export type UploadImageResult = {
  /** コミットされた Vault 内パス（例: attachments/20260809-123456-3f2a.png） */
  readonly path: string;
};

/** 受け付ける画像拡張子（raw 配信と Embed 表示が対象のラスター/ベクター） */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);

/** ファイル名の拡張子を小文字で返す（画像拡張子でなければ null） */
export function imageExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) {
    return null;
  }
  const extension = fileName.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

/** 標準 base64（btoa 出力相当）かどうか（コミット API と同じ検証） */
function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/**
 * 画像の保存パス（`<directory>/YYYYMMDDHHMMSS-<suffix>.<拡張子>`）を組み立てる。
 * タイムスタンプ + 乱数で同名衝突を避ける（Obsidian の貼り付け規約と同系）。
 * 拡張子が画像でない場合は null。
 */
export function buildImagePath(
  fileName: string,
  directory: string,
  timestamp: number,
  randomSuffix: string,
): string | null {
  const extension = imageExtension(fileName);
  if (extension === null) {
    return null;
  }
  const stamp = new Date(timestamp).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${directory}/${stamp}-${randomSuffix}.${extension}`;
}

/**
 * 画像をアップロードする（ペースト/ドロップ → base64 コミット → Embed 挿入）。
 * 一括コミット基盤（commitChanges）を create-binary で使い、ファイル名衝突しない
 * 一意パスに 1 コミットで保存する。成功時は共有索引へ反映し、パスを返す。
 * 検証エラー・コミット失敗は FileCommitError で返る。
 */
export const uploadImage = (
  ref: VaultRef,
  input: UploadImageInput,
): Effect.Effect<UploadImageResult, FileCommitError, NoteGateway | NoteIndexRegistry> =>
  Effect.gen(function* () {
    const directory = input.directory === undefined ? 'attachments' : input.directory;
    if (directory !== '' && !isValidPath(directory)) {
      return yield* Effect.fail(
        fileCommitError('server', 'アップロード先のフォルダー名が不正です。'),
      );
    }
    const path = buildImagePath(
      input.fileName,
      directory,
      Date.now(),
      // 同名衝突を避ける 4 文字の乱数（短い文字列は 0 埋めで長さを揃える）
      Math.random().toString(36).slice(2, 6).padEnd(4, '0'),
    );
    if (path === null) {
      return yield* Effect.fail(fileCommitError('server', '画像ファイル名が不正です。'));
    }
    if (!isValidBase64(input.base64)) {
      return yield* Effect.fail(fileCommitError('server', '画像データが不正です。'));
    }

    const gateway = yield* NoteGateway;
    const registry = yield* NoteIndexRegistry;
    const change: FileChange = { op: 'create-binary', path, base64: input.base64 };
    yield* gateway.commitChanges(ref, { changes: [change], message: `Create ${path}` });
    registry.applyFileChanges(ref, [change]);
    return { path };
  });
