/**
 * R2 バケットの共通走査（キー列挙と安全な JSON 読み取り）。
 *
 * r2-vault 系モジュール（meta / tree / notes / raw / marks）から使う
 * 最小のヘルパー集。オブジェクトの破損・形式不正は null に倒す。
 */

/** prefix 配下の全オブジェクトキーをページングで列挙する */
export async function listAllR2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    const listed = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of listed.objects) {
      keys.push(object.key);
    }
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    cursor = listed.truncated ? listed.cursor : undefined;
    if (cursor === undefined) {
      break;
    }
  }
  return keys;
}

/** レコード（オブジェクト）かどうか */
export function isR2Record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** R2 オブジェクトの JSON を安全にパースする（破損・形式不正は null） */
export async function readR2JsonObject(
  bucket: R2Bucket,
  key: string,
): Promise<Record<string, unknown> | null> {
  const object = await bucket.get(key);
  if (object === null) {
    return null;
  }
  const parsed = await object.json().catch(() => null);
  return isR2Record(parsed) ? parsed : null;
}

/** 空でない文字列を読む（それ以外は null） */
export function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
