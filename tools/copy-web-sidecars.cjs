'use strict';

// build:web — los sidecars .cjs que el main carga con require() deben existir
// junto al server compilado (mismo patrón que tools/copy-main-assets.cjs para
// out/main). slack.ts hace require('./slack-trigger.cjs') al cargar.
const { copyFileSync, mkdirSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

const ROOT = join(__dirname, '..');
const ASSETS = [
  ['src/main/slack-trigger.cjs', 'out/web/main/slack-trigger.cjs'],
  ['src/main/kg-core.cjs', 'out/web/main/kg-core.cjs'],
];

for (const [fromRel, toRel] of ASSETS) {
  const from = join(ROOT, fromRel);
  const to = join(ROOT, toRel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const copied = statSync(to);
  if (!copied.isFile() || copied.size === 0) {
    throw new Error(`Failed to copy required web-server asset: ${fromRel} -> ${toRel}`);
  }
  console.log(`[copy-web-sidecars] ${fromRel} -> ${toRel}`);
}
