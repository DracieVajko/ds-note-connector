import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeNas } from './fake-nas.mjs';

const SERVER = fileURLToPath(new URL('../variants/mcp/server.mjs', import.meta.url));

/** Spawn the real MCP server and speak JSON-RPC to it over stdio. */
function spawnServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const notifications = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        notifications.push(message);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error(`no response to ${method} within 10s`)), 10000).unref?.();
    });

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  return {
    child,
    request,
    notify,
    notifications,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.stdin.end();
      }),
  };
}

function nasEnv(nas, extra = {}) {
  return {
    DS_NOTE_MODE: 'direct',
    DS_NOTE_HOST: '127.0.0.1',
    DS_NOTE_PORT: String(nas.port),
    DS_NOTE_HTTPS: 'false',
    DS_NOTE_ACCOUNT: 'tester',
    DS_NOTE_PASSWORD: 'secret',
    ...extra,
  };
}

test('initializes, lists tools, and calls them end to end', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const server = spawnServer(nasEnv(nas));
  t.after(() => server.stop());

  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ds-note-connector');
  assert.ok(init.result.capabilities.tools);
  server.notify('notifications/initialized');

  const list = await server.request('tools/list', {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('dsnote_status'));
  assert.ok(names.includes('dsnote_search'));
  assert.ok(names.includes('dsnote_create_note'));
  assert.ok(!names.includes('dsnote_raw'), 'raw is off by default');
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} has an object schema`);
    assert.ok(tool.description.length > 40, `${tool.name} has a real description`);
  }

  const status = await server.request('tools/call', { name: 'dsnote_status', arguments: {} });
  assert.equal(status.result.isError, false);
  const statusBody = JSON.parse(status.result.content[0].text);
  assert.equal(statusBody.session.authenticated, true);
  assert.equal(statusBody.dsm.model, 'DS920+');

  const notebooks = await server.request('tools/call', { name: 'dsnote_notebooks', arguments: {} });
  const notebookBody = JSON.parse(notebooks.result.content[0].text);
  assert.ok(notebookBody.notebooks.length >= 1);

  const notebookId = notebookBody.notebooks[0].id;
  const created = await server.request('tools/call', {
    name: 'dsnote_create_note',
    arguments: {
      title: 'From MCP',
      notebookId,
      markdown: '# MCP\n\n- [ ] one\n- [x] two',
      tags: ['MCP'],
    },
  });
  assert.equal(created.result.isError, false);
  const note = JSON.parse(created.result.content[0].text);
  assert.equal(note.title, 'From MCP');
  assert.ok(note.markdown.includes('# MCP'));
  assert.deepEqual(note.tags, ['MCP']);

  const search = await server.request('tools/call', { name: 'dsnote_search', arguments: { query: 'MCP' } });
  const found = JSON.parse(search.result.content[0].text);
  assert.ok(found.notes.some((entry) => entry.id === note.id));
});

test('a tool failure comes back as isError, not as a dropped request', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const server = spawnServer(nasEnv(nas));
  t.after(() => server.stop());
  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  const unknown = await server.request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.result.isError, true);
  const body = JSON.parse(unknown.result.content[0].text);
  assert.match(body.error, /unknown tool/);

  const missingId = await server.request('tools/call', { name: 'dsnote_get_note', arguments: {} });
  assert.equal(missingId.result.isError, true);

  const badMethod = await server.request('tools/whatever', {});
  assert.equal(badMethod.error.code, -32601);
});

test('an unconfigured server explains what is missing instead of crashing', async (t) => {
  const server = spawnServer({
    DS_NOTE_ACCOUNT: '',
    DS_NOTE_PASSWORD: '',
    DS_NOTE_HOST: '',
    DS_NOTE_URL: '',
    DS_NOTE_QUICKCONNECT: '',
  });
  t.after(() => server.stop());

  const init = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(init.result.protocolVersion, '2024-11-05');

  const status = await server.request('tools/call', { name: 'dsnote_status', arguments: {} });
  assert.equal(status.result.isError, true);
  const body = JSON.parse(status.result.content[0].text);
  assert.match(body.error, /not configured/);
  assert.match(body.error, /DS_NOTE_ACCOUNT/);
});

test('raw API access is opt-in', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const server = spawnServer(nasEnv(nas, { DS_NOTE_ALLOW_RAW: '1' }));
  t.after(() => server.stop());

  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const list = await server.request('tools/list', {});
  assert.ok(list.result.tools.some((tool) => tool.name === 'dsnote_raw'));

  const raw = await server.request('tools/call', {
    name: 'dsnote_raw',
    arguments: { api: 'SYNO.NoteStation.Info', method: 'get' },
  });
  assert.equal(raw.result.isError, false);
  const body = JSON.parse(raw.result.content[0].text);
  assert.equal(body.username, 'tester');
});
