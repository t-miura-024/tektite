/**
 * テスト用のメモリ R2 バケット（r2-vault と API ルートのテストで共用）。
 *
 * workers-types の R2Bucket / R2ObjectBody のうち、tektite のストレージ層
 * （r2-vault.ts）が使う最小の API（get / put / list / delete と body の
 * arrayBuffer / json / customMetadata）だけを実装したフェイク。
 */

export class FakeR2Bucket {
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
    return {
      objects: keys.map((key) => ({ key, size: this.objects.get(key)?.body.byteLength ?? 0 })),
      truncated: false,
      cursor: undefined,
    };
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

export function createFakeR2Bucket(): R2Bucket {
  return new FakeR2Bucket() as unknown as R2Bucket;
}
