import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [inputPath, outputPath, heightText] = process.argv.slice(2);
const height = Number(heightText);

if (!inputPath || !outputPath || !Number.isInteger(height)) {
  throw new Error('Usage: crop.mjs <input.png> <output.png> <height>');
}

const input = PNG.sync.read(readFileSync(inputPath));
if (height > input.height) {
  throw new Error(`Crop height ${height} exceeds image height ${input.height}`);
}

const output = new PNG({ width: input.width, height });
PNG.bitblt(input, output, 0, 0, input.width, height, 0, 0);
writeFileSync(outputPath, PNG.sync.write(output));
