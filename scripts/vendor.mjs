/**
 * Copies the browser builds of Chart.js and Lucide out of node_modules into
 * assets/vendor so the app works fully offline with no CDN dependency.
 *
 * Usage: node scripts/vendor.mjs
 */
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'assets/vendor');
mkdirSync(outDir, { recursive: true });

const targets = [
  {
    label: 'chart.js',
    candidates: ['node_modules/chart.js/dist/chart.umd.js', 'node_modules/chart.js/dist/chart.umd.cjs'],
    out: 'chart.umd.js'
  },
  { label: 'lucide', candidates: ['node_modules/lucide/dist/umd/lucide.js'], out: 'lucide.js' }
];

let failed = 0;
for (const target of targets) {
  const source = target.candidates.map((c) => resolve(root, c)).find((p) => existsSync(p));
  if (!source) {
    console.error(`✗ ${target.label}: no build found. Run \`npm install\` first.`);
    failed += 1;
    continue;
  }
  const dest = resolve(outDir, target.out);
  copyFileSync(source, dest);
  const kb = Math.round(statSync(dest).size / 1024);
  console.log(`✓ ${target.label} -> assets/vendor/${target.out} (${kb} kB)`);
}
process.exit(failed ? 1 : 0);
