/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
export function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * パスセグメントの URL デコード。
 * Pages Functions のパスパラメータはデコード前の生セグメントで届く想定だが、
 * 実行環境によっては既にデコード済みの可能性があるため、不正なパーセント
 * エスケープでエラーになる場合だけ元の文字列を採用する（二重デコード回避）。
 */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** パスパラメータ（パス全体を 1 セグメントにエンコードしたもの）をノートパスに復元する */
export function resolveNotePath(value: string | string[] | undefined): string | null {
  const rawPath = paramToString(value);
  const notePath = decodeSegment(rawPath)
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
  if (notePath.length === 0) {
    return null;
  }
  return notePath;
}

/** GitHub Contents API の base64 本文を UTF-8 文字列に復号する */
export function decodeBase64Content(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 標準 base64（btoa 出力相当）かどうか。空文字（空ファイル）も許容する */
export function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** PUT ボディを検証し、GitHub へ転送する形に正規化する（不正は null） */
export function parseSaveNoteBody(raw: unknown): {
  content: string;
  message: string;
  sha: string | null;
} | null {
  if (typeof raw !== 'object' || raw === null || !('content' in raw) || !('message' in raw)) {
    return null;
  }
  const body = {
    content: raw.content,
    message: raw.message,
    sha: 'sha' in raw ? raw.sha : undefined,
  };
  if (typeof body.content !== 'string' || !isValidBase64(body.content)) {
    return null;
  }
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return null;
  }
  if (body.sha !== undefined && (typeof body.sha !== 'string' || body.sha.length === 0)) {
    return null;
  }
  return {
    content: body.content,
    message: body.message,
    sha: typeof body.sha === 'string' ? body.sha : null,
  };
}

/** ノートパスを Contents API の URL パス（セグメント単位でエンコード）に変換する */
export function encodeNotePath(notePath: string): string {
  return notePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
