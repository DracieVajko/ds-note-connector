#!/usr/bin/env node
/**
 * Generate the `tools` array in plugin/ghost.json from core/tools.mjs.
 *
 * The manifest and the runtime must describe the same tools. Writing them
 * twice is how they drift, so the manifest is generated and
 * `tests/manifest.test.mjs` fails when it is out of date.
 *
 *   node tools/gen-manifest.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolCatalog } from '../core/tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, 'plugin', 'ghost.json');

/** The manifest's view of a tool: name, description and a JSON Schema. */
export function manifestTools() {
  const catalog = createToolCatalog({ getApi: async () => null, allowRaw: true });
  return catalog.tools.map((tool) => ({
    name: tool.name,
    description: `${tool.title} — ${tool.description}`,
    parameters: tool.inputSchema,
  }));
}

export function generateManifestText() {
  const raw = readFileSync(MANIFEST, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.tools = manifestTools();
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(MANIFEST, generateManifestText(), 'utf8');
  console.log(`wrote ${manifestTools().length} tools into plugin/ghost.json`);
}
