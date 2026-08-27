/**
 * テスト用のメモリ R2 バケット（r2-vault と API ルートのテストで共用）。
 *
 * workers-types の R2Bucket / R2ObjectBody のうち、tektite のストレージ層
 * （r2-vault.ts）が使う最小の API（get / put / list / delete と body の
 * arrayBuffer / json / customMetadata）だけを実装したフェイク。
 * class を使わずオブジェクトリテラル + ファクトリで構築する
 * （R2 の API は非同期のため Promise を直接返す）。
 */

type FakeR2Object = {
  readonly body: ArrayBuffer;
  readonly metadata?: Record<string, string>;
};

/** R2ObjectBody 相当（tektite が使う範囲のみ） */
function fakeR2ObjectBody(object: FakeR2Object): {
  customMetadata: Record<string, string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
} {
  return {
    get customMetadata(): Record<string, string> {
      return object.metadata ?? {};
    },
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(object.body),
    json: (): Promise<unknown> =>
      Promise.resolve(JSON.parse(new TextDecoder().decode(object.body))),
  };
}

/**
 * メモリ上の R2 バケットを生成する。
 * 戻り値の実体は使用 API だけを持つオブジェクトで、境界で R2Bucket として返す。
 */
export function createFakeR2Bucket(): R2Bucket {
  const objects = new Map<string, FakeR2Object>();

  const bucket = {
    get(key: string): Promise<unknown> {
      const object = objects.get(key);
      return Promise.resolve(object === undefined ? null : fakeR2ObjectBody(object));
    },

    put(
      key: string,
      value: string | ArrayBuffer,
      options?: { customMetadata?: Record<string, string> },
    ): Promise<unknown> {
      const body = typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
      objects.set(key, { body, metadata: options?.customMetadata });
      return Promise.resolve({ key });
    },

    list(options?: { prefix?: string; cursor?: string }): Promise<unknown> {
      const prefix = options?.prefix ?? '';
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return Promise.resolve({
        objects: keys.map((key) => ({ key, size: objects.get(key)?.body.byteLength ?? 0 })),
        truncated: false,
        cursor: undefined,
      });
    },

    delete(key: string): Promise<void> {
      objects.delete(key);
      return Promise.resolve();
    },
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- workers-types の R2Bucket はメソッド多数の広いインターフェースのため、テスト用フェイクは使用部分のみを実装して境界で 1 回だけ型を合わせる
  return bucket as unknown as R2Bucket;
}
