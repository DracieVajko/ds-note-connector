#!/usr/bin/env node
/**
 * Vendor `core/` into the plugin package.
 *
 * A .cindy package is a zip of one directory, so the plugin cannot import
 * `../../core`. Rather than keeping a second copy by hand, this script copies
 * the real one and `tests/manifest.test.mjs` fails if the copy drifts.
 *
 *   node tools/sync-core.mjs          # copy
 *   node tools/sync-core.mjs --check  # exit 1 if the copy is stale
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'core');
const TARGET = join(ROOT, 'plugin', 'node', 'core');

export function coreFiles() {
  return readdirSync(SOURCE).filter((name) => name.endsWith('.mjs')).sort();
}

export function syncCore({ check = false } = {}) {
  const files = coreFiles();
  const drift = [];
  if (!check) mkdirSync(TARGET, { recursive: true });
  if (check) {
    // A file that only exists in the vendored copy is drift as well, otherwise
    // a deleted module would keep shipping from the package.
    let vendored = [];
    try {
      vendored = readdirSync(TARGET).filter((name) => name.endsWith('.mjs'));
    } catch {
      vendored = [];
    }
    for (const name of vendored) {
      if (!files.includes(name)) drift.push(`${name}: only in the package`);
    }
  }
  for (const name of files) {
    const from = join(SOURCE, name);
    const to = join(TARGET, name);
    if (check) {
      let current = null;
      try {
        current = readFileSync(to, 'utf8');
      } catch {
        drift.push(`${name}: missing`);
        continue;
      }
      if (current !== readFileSync(from, 'utf8')) drift.push(`${name}: differs`);
      continue;
    }
    copyFileSync(from, to);
  }
  return { files, drift };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { files, drift } = syncCore({ check });
  if (check) {
    if (drift.length > 0) {
      console.error(`plugin/node/core is stale:\n  ${drift.join('\n  ')}\nrun: node tools/sync-core.mjs`);
      process.exit(1);
    }
    console.log(`plugin/node/core is in sync (${files.length} files)`);
  } else {
    console.log(`copied ${files.length} files into plugin/node/core`);
  }
}
