import { readFileSync } from 'node:fs';

const [expectedPath, actualPath] = process.argv.slice(2);

if (!expectedPath || !actualPath) {
  throw new Error('Usage: compare-dom.mjs <expected.json> <actual.json>');
}

const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const actual = JSON.parse(readFileSync(actualPath, 'utf8'));
const names = Object.keys(expected.landmarks ?? {});
const errors = names.flatMap((name) => {
  const left = expected.landmarks[name];
  const right = actual.landmarks?.[name];
  if (!right) {
    return [{ name, kind: 'missing', error: Infinity }];
  }
  return ['x', 'y', 'width', 'height'].map((key) => ({
    name,
    kind: key,
    error: Math.abs((left[key] ?? 0) - (right[key] ?? 0)),
  }));
});
const finiteErrors = errors.filter((entry) => Number.isFinite(entry.error));
const missing = errors.filter((entry) => !Number.isFinite(entry.error)).length;
const meanLayoutError =
  finiteErrors.length === 0
    ? Infinity
    : finiteErrors.reduce((sum, entry) => sum + entry.error, 0) / finiteErrors.length;
const maxLayoutError =
  finiteErrors.length === 0 ? Infinity : Math.max(...finiteErrors.map((entry) => entry.error));

const styleNames = Object.keys(expected.styles ?? {});
let matchingStyles = 0;
for (const name of styleNames) {
  const expectedStyle = expected.styles[name];
  const actualStyle = actual.styles?.[name];
  if (
    actualStyle &&
    Object.keys(expectedStyle).every(
      (key) => String(expectedStyle[key]) === String(actualStyle[key]),
    )
  ) {
    matchingStyles += 1;
  }
}

const result = {
  expected: expectedPath,
  actual: actualPath,
  landmarks: names.length,
  missingLandmarks: missing,
  meanLayoutError,
  maxLayoutError,
  styles: styleNames.length,
  matchingStyles,
  styleMatchRatio: styleNames.length === 0 ? 1 : matchingStyles / styleNames.length,
  pass:
    missing === 0 &&
    meanLayoutError <= 2 &&
    maxLayoutError <= 4 &&
    matchingStyles / Math.max(styleNames.length, 1) >= 0.95,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
