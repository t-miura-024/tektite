import { readFileSync, writeFileSync } from 'node:fs';

const id = process.env.TEKTITE_KV_NAMESPACE_ID;
if (!id) {
  console.error('TEKTITE_KV_NAMESPACE_ID is not set. Set the KV namespace id and retry.');
  process.exit(1);
}

const src = readFileSync('wrangler.jsonc', 'utf8').replaceAll('${TEKTITE_KV_NAMESPACE_ID}', id);
writeFileSync('.wrangler.deploy.jsonc', src);
console.log('Generated .wrangler.deploy.jsonc');
