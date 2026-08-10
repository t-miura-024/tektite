import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [expectedPath, actualPath] = process.argv.slice(2);
const threshold = Number(process.env.PIXELMATCH_THRESHOLD ?? '0.1');
const regions = [
  ['rail', 0, 0, 44, 1027],
  ['sidebar', 44, 0, 244, 1027],
  ['chrome', 244, 0, 1710, 80],
  ['title', 244, 80, 1710, 190],
  ['content', 244, 190, 1710, 1027],
];

if (!expectedPath || !actualPath) {
  throw new Error('Usage: compare-regions.mjs <expected.png> <actual.png>');
}

const expected = PNG.sync.read(readFileSync(expectedPath));
const actual = PNG.sync.read(readFileSync(actualPath));
if (expected.width !== actual.width || expected.height !== actual.height) {
  throw new Error('Image dimensions must match');
}

const results = regions.map(([name, x, y, right, bottom]) => {
  const width = right - x;
  const height = bottom - y;
  const expectedRegion = new Uint8Array(width * height * 4);
  const actualRegion = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y + row) * expected.width + x) * 4;
    const targetOffset = row * width * 4;
    expectedRegion.set(
      expected.data.subarray(sourceOffset, sourceOffset + width * 4),
      targetOffset,
    );
    actualRegion.set(actual.data.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }
  const diff = pixelmatch(expectedRegion, actualRegion, null, width, height, { threshold });
  const total = width * height;
  return {
    name,
    x,
    y,
    width,
    height,
    diffPixels: diff,
    diffRatio: diff / total,
    similarity: 1 - diff / total,
    threshold,
  };
});

process.stdout.write(
  `${JSON.stringify({ expected: expectedPath, actual: actualPath, regions: results })}\n`,
);
