import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [expectedPath, actualPath, diffPath] = process.argv.slice(2);
const threshold = Number(process.env.PIXELMATCH_THRESHOLD ?? '0.1');

if (!expectedPath || !actualPath || !diffPath) {
  throw new Error('Usage: compare.mjs <expected.png> <actual.png> <diff.png>');
}

const expected = PNG.sync.read(readFileSync(expectedPath));
const actual = PNG.sync.read(readFileSync(actualPath));

if (expected.width !== actual.width || expected.height !== actual.height) {
  throw new Error(
    `Image dimensions differ: expected ${expected.width}x${expected.height}, actual ${actual.width}x${actual.height}`,
  );
}

const diff = new PNG({ width: expected.width, height: expected.height });
const diffPixels = pixelmatch(
  expected.data,
  actual.data,
  diff.data,
  expected.width,
  expected.height,
  { threshold },
);
const totalPixels = expected.width * expected.height;
const ratio = diffPixels / totalPixels;

writeFileSync(diffPath, PNG.sync.write(diff));
process.stdout.write(
  `${JSON.stringify({
    expected: expectedPath,
    actual: actualPath,
    diff: diffPath,
    width: expected.width,
    height: expected.height,
    diffPixels,
    totalPixels,
    diffRatio: ratio,
    similarity: 1 - ratio,
    threshold,
  })}\n`,
);
