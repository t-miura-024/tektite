import { describe, expect, it } from 'vitest';

import * as domain from './index';

describe('domain 層の骨格', () => {
  it('純 TS モジュールとして import できる', () => {
    expect(domain).toBeDefined();
  });
});
