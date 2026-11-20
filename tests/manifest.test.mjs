import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolCatalog } from '../core/tools.mjs';
import { generateManifestText } from '../tools/gen-manifest.mjs';
import { syncCore } from '../tools/sync-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN = join(ROOT, 'plugin');
const manifest = JSON.parse(readFileSync(join(PLUGIN, 'ghost.json'), 'utf8'));

test('the manifest is generated from the tool catalog, not hand-written', () => {
  assert.equal(
    readFileSync(join(PLUGIN, 'ghost.json'), 'utf8'),
    generateManifestText(),
    'plugin/ghost.json is stale — run: node tools/gen-manifest.mjs',
  );
});

test('the vendored core matches core/', () => {
  const { drift } = syncCore({ check: true });
  assert.deepEqual(drift, [], 'plugin/node/core is stale — run: node tools/sync-core.mjs');
});

test('every tool in the manifest starts with dsnote_, which is what main.js dispatches on', () => {
  const catalog = createToolCatalog({ getApi: async () => null, allowRaw: true });
  const catalogNames = catalog.tools.map((tool) => tool.name).sort();
  const manifestNames = manifest.tools.map((tool) => tool.name).sort();
  assert.deepEqual(manifestNames, catalogNames);
  for (const name of manifestNames) assert.match(name, /^dsnote_/);
});

test('the manifest declares what the plugin actually ships', () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.id, 'ds-note');
  assert.ok(manifest.command, 'a command is required for the $name shortcut and the Use button');
  assert.ok(manifest.whenToUse.length <= 300);
  assert.ok(manifest.description.length <= 300);

  for (const file of [
    manifest.entry,
    manifest.panel.html,
    manifest.settingsHtml,
    manifest.node.entry,
    manifest.readme.en,
    manifest.skill.items[0].dir + '/SKILL.md',
  ]) {
    assert.ok(existsSync(join(PLUGIN, file)), `${file} is declared but missing`);
  }
});

test('the worker entry is CommonJS and imports the vendored core', () => {
  const worker = readFileSync(join(PLUGIN, manifest.node.entry), 'utf8');
  assert.ok(worker.includes("require('node:readline')"), 'worker speaks line-delimited JSON-RPC');
  assert.ok(worker.includes("import('./core/index.mjs')"), 'worker uses the vendored core');
  assert.ok(!worker.includes('node_modules'), 'no dependencies are allowed in a package');
});

test('the DSM password is a node secret binding, not a kv value', () => {
  const binding = manifest.node.secretBindings.find((entry) => entry.key === 'dsm_password');
  assert.ok(binding, 'dsm_password is bound to the worker');
  assert.deepEqual(binding.methods, ['note/call']);

  const settings = readFileSync(join(PLUGIN, 'settings.js'), 'utf8');
  assert.ok(settings.includes("fetch(`/secrets/${PASSWORD_KEY}`"), 'the password goes to /secrets');
  assert.ok(!/fetch\('\/kv'[^)]*password/i.test(settings), 'the password must never reach /kv');
});

test('the skill frontmatter matches the manifest exactly', () => {
  const skill = readFileSync(join(PLUGIN, manifest.skill.items[0].dir, 'SKILL.md'), 'utf8');
  const name = skill.match(/^name:\s*(.+)$/m)?.[1].trim();
  const description = skill.match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^"|"$/g, '');
  assert.equal(name, manifest.skill.items[0].name);
  assert.equal(description, manifest.skill.items[0].description);
});

test('the pages and the brain agree on the channel name', () => {
  const channel = manifest.id;
  const brain = readFileSync(join(PLUGIN, 'main.js'), 'utf8');
  const shared = readFileSync(join(PLUGIN, 'brain-rpc.js'), 'utf8');

  assert.ok(brain.includes(`CHANNEL = '${channel}'`), 'main.js names the channel');
  assert.ok(brain.includes('BroadcastChannel(CHANNEL)'), 'main.js opens it');
  assert.ok(shared.includes(`CHANNEL = '${channel}'`), 'the shared client uses the same name');
  assert.ok(shared.includes('BroadcastChannel(CHANNEL)'), 'the shared client opens it');

  // The two pages must not re-implement it.
  for (const file of ['panel.js', 'settings.js']) {
    const source = readFileSync(join(PLUGIN, file), 'utf8');
    assert.ok(source.includes('globalThis.dsNoteBrain'), `${file} uses the shared client`);
    assert.ok(!source.includes('BroadcastChannel('), `${file} must not open its own channel`);
  }
});

test('the panel and settings pages keep scripts external', () => {
  for (const file of [manifest.panel.html, manifest.settingsHtml]) {
    const html = readFileSync(join(PLUGIN, file), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), `${file} must not inline a script — CSP blocks it`);
    assert.ok(/<script src="\/[^"]+"><\/script>/.test(html), `${file} loads an external script`);
  }
});

test('nothing in the package can purge a note from an agent tool call', () => {
  const catalog = createToolCatalog({ getApi: async () => null, allowRaw: true });
  assert.ok(!catalog.tools.some((tool) => /purge|destroy|empty/i.test(tool.name)));
  const main = readFileSync(join(PLUGIN, 'main.js'), 'utf8');
  assert.ok(!/allowPurge:\s*true/.test(main), 'main.js never forces purge on');
});

test('the certificate choice reaches the worker in every connection mode', () => {
  const main = readFileSync(join(PLUGIN, 'main.js'), 'utf8');
  // It has to sit in the base config object, not inside the direct-only branch:
  // a QuickConnect relay route is an IP no certificate covers, and that is the
  // mode where forgetting it breaks the connection entirely.
  const base = main.slice(main.indexOf('const config = {'), main.indexOf("if (mode === 'direct')"));
  assert.match(base, /allowSelfSigned:\s*kv\.allowSelfSigned === true/);
});

test('the certificate fingerprint is stripped before an agent sees a result', () => {
  const main = readFileSync(join(PLUGIN, 'main.js'), 'utf8');
  assert.match(main, /if \(callId && outcome\?\.result\?\.certificate\)/, 'the strip must be keyed on an agent call');
  assert.match(main, /delete outcome\.result\.certificate\.fingerprint/);
});

test('the release version is the same in the manifest, package.json and the MCP server', async () => {
  const { VERSION } = await import('../core/version.mjs');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, VERSION, 'plugin/ghost.json');
  assert.equal(pkg.version, VERSION, 'package.json');
  const server = readFileSync(join(ROOT, 'variants/mcp/server.mjs'), 'utf8');
  assert.ok(!/version:\s*'\d+\.\d+\.\d+'/.test(server), 'the MCP server must not hardcode a version');
});

test('the panel escapes quotes and only links http(s) URLs', () => {
  const panel = readFileSync(join(PLUGIN, 'panel.js'), 'utf8');
  // Note bodies are interpolated into attribute values before innerHTML is
  // assigned, so an unescaped quote in a link is an injected attribute.
  assert.ok(panel.includes(`/"/g, '&quot;'`), 'quotes must be escaped');
  assert.ok(panel.includes("/'/g, '&#39;'"), 'apostrophes must be escaped');
  assert.ok(panel.includes('rel="noreferrer noopener"'), 'links are built with a scheme check');
  assert.ok(panel.includes('^https?:'), 'the scheme is checked before rendering an anchor');
});

test('the probe does not disable certificate verification on its own', () => {
  const probe = readFileSync(join(ROOT, 'tools', 'probe.mjs'), 'utf8');
  assert.ok(probe.includes('allowSelfSigned: args.insecure === true'));
  assert.ok(!probe.includes('args.insecure ??'), 'never guess from the host shape');
});
