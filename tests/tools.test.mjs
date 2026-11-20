import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCatalog, rawBlocked } from '../core/tools.mjs';

function stubApi() {
  const calls = [];
  return {
    calls,
    client: {
      call: async (api, method, params) => {
        calls.push({ api, method, params });
        return { ok: true };
      },
    },
  };
}

test('the raw tool refuses to purge a note', async () => {
  const api = stubApi();
  const catalog = createToolCatalog({ getApi: async () => api, allowRaw: true });

  const outcome = await catalog.invoke('dsnote_raw', {
    api: 'SYNO.NoteStation.Note',
    method: 'delete',
    params: { object_id: ['1026_X'], recycle: false },
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /permanently/);
  assert.equal(api.calls.length, 0, 'nothing was sent to the NAS');
});

test('the raw tool still allows the soft delete', async () => {
  const api = stubApi();
  const catalog = createToolCatalog({ getApi: async () => api, allowRaw: true });

  const outcome = await catalog.invoke('dsnote_raw', {
    api: 'SYNO.NoteStation.Note',
    method: 'delete',
    params: { object_id: ['1026_X'], recycle: true },
  });

  assert.equal(outcome.ok, true);
  assert.equal(api.calls.length, 1);
});

test('the raw tool refuses to delete a notebook', async () => {
  const api = stubApi();
  const catalog = createToolCatalog({ getApi: async () => api, allowRaw: true });

  const outcome = await catalog.invoke('dsnote_raw', {
    api: 'SYNO.NoteStation.Notebook',
    method: 'delete',
    params: { object_id: '1026_N' },
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /notebook/i);
  assert.equal(api.calls.length, 0);
});

test('no tool in the catalog can purge a note, with or without raw enabled', () => {
  for (const config of [{}, { allowRaw: true }, { allowRaw: true, allowPurge: true }]) {
    const catalog = createToolCatalog({ getApi: async () => stubApi(), config });
    for (const tool of catalog.tools) {
      assert.ok(!/purge|destroy|empty/i.test(tool.name), `${tool.name} must not exist`);
    }
  }
});

test('rawBlocked only matches the destructive shapes', () => {
  assert.ok(rawBlocked('SYNO.NoteStation.Note', 'delete', { recycle: false }));
  assert.equal(rawBlocked('SYNO.NoteStation.Note', 'delete', { recycle: true }), null);
  assert.equal(rawBlocked('SYNO.NoteStation.Note', 'get', {}), null);
  assert.ok(rawBlocked('SYNO.NoteStation.Notebook', 'delete', {}));
  assert.equal(rawBlocked('SYNO.NoteStation.Notebook', 'list', {}), null);
});

test('the raw tool exists only while allowRaw is on', async () => {
  const { createToolCatalog } = await import('../core/tools.mjs');
  const getApi = async () => null;

  const on = createToolCatalog({ getApi, allowRaw: true });
  assert.ok(on.tools.some((tool) => tool.name === 'dsnote_raw'));
  const result = await on.invoke('dsnote_raw', { api: 'SYNO.NoteStation.Note', method: 'list' });
  assert.notEqual(result.kind, 'UnknownTool', 'with the switch on the tool is dispatched');

  const off = createToolCatalog({ getApi, config: { allowRaw: false } });
  assert.ok(!off.tools.some((tool) => tool.name === 'dsnote_raw'), 'the tool is gone from the catalog');
  const refused = await off.invoke('dsnote_raw', { api: 'SYNO.NoteStation.Note', method: 'list' });
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, 'UnknownTool', 'a call is refused, not silently accepted');
});

test('published schemas are enforced before a handler runs', async () => {
  const { createToolCatalog } = await import('../core/tools.mjs');
  let called = 0;
  const catalog = createToolCatalog({
    getApi: async () => {
      called += 1;
      return null;
    },
    config: {},
  });

  const badEnum = await catalog.invoke('dsnote_notebooks', { action: 'destroy' });
  assert.equal(badEnum.ok, false);
  assert.equal(badEnum.kind, 'InvalidArguments');
  assert.match(badEnum.error, /must be one of/);

  const unknownKey = await catalog.invoke('dsnote_search', { query: 'x', nope: 1 });
  assert.equal(unknownKey.ok, false);
  assert.match(unknownKey.error, /unknown key nope/);

  const badType = await catalog.invoke('dsnote_search', { query: 5 });
  assert.equal(badType.ok, false);
  assert.match(badType.error, /must be string/);

  assert.equal(called, 0, 'no handler ran for an invalid call');
});

/**
 * Drive the handlers that the earlier tests only reached through the NAS, so a
 * change in a resource method shows up here instead of at the user's click.
 */
function fullApi() {
  const sent = [];
  const record = (name) => async (...args) => {
    sent.push({ name, args });
    if (name === 'notes.list') return { notes: [], total: 0 };
    if (name === 'notes.get') return { object_id: 'n1', title: 't', content: '<p>x</p>', tag: [], ver: 3 };
    if (name === 'todos.list') return { todos: [], total: 0 };
    if (name === 'versions.list') return [{ version: 'v1' }];
    if (name === 'search.search') return { total: 0, notes: [] };
    if (name === 'tags.list') return [{ title: 'Work', noteIds: ['n1'] }];
    return { ok: true };
  };
  return {
    sent,
    status: record('status'),
    notes: {
      get: record('notes.get'),
      list: record('notes.list'),
      create: record('notes.create'),
      set: record('notes.set'),
      append: record('notes.append'),
      trash: record('notes.trash'),
      restore: record('notes.restore'),
      attachImage: record('notes.attachImage'),
    },
    notebooks: { list: record('notebooks.list'), create: record('notebooks.create'), rename: record('notebooks.rename') },
    tags: { list: record('tags.list'), create: record('tags.create') },
    todos: { list: record('todos.list'), create: record('todos.create'), set: record('todos.set'), remove: record('todos.remove') },
    search: { search: record('search.search') },
    versions: { list: record('versions.list'), restore: record('versions.restore') },
  };
}

test('every published handler runs and reaches its resource method', async () => {
  const api = fullApi();
  const catalog = createToolCatalog({ getApi: async () => api, allowRaw: false });
  const cases = [
    ['dsnote_status', {}],
    ['dsnote_notebooks', { action: 'list' }],
    ['dsnote_notebooks', { action: 'create', title: 'New' }],
    ['dsnote_notebooks', { action: 'rename', id: 'n1', title: 'Renamed' }],
    ['dsnote_search', { query: 'x' }],
    ['dsnote_list_notes', {}],
    ['dsnote_get_note', { id: 'n1' }],
    ['dsnote_create_note', { title: 't', notebookId: 'b1', markdown: '# hi' }],
    ['dsnote_update_note', { id: 'n1', title: 't2' }],
    ['dsnote_append_note', { id: 'n1', markdown: 'more' }],
    ['dsnote_trash_note', { id: 'n1' }],
    ['dsnote_restore_note', { id: 'n1' }],
    ['dsnote_tags', {}],
    ['dsnote_tags', { noteId: 'n1' }],
    ['dsnote_todos', { action: 'list' }],
    ['dsnote_todos', { action: 'create', title: 'task', comment: 'why' }],
    ['dsnote_todos', { action: 'update', id: 't1', done: true }],
    ['dsnote_versions', { id: 'n1', action: 'list' }],
    ['dsnote_versions', { id: 'n1', action: 'restore', version: 'v1' }],
  ];
  for (const [name, args] of cases) {
    const outcome = await catalog.invoke(name, args);
    assert.equal(outcome.ok, true, `${name} ${JSON.stringify(args)} failed: ${outcome.error}`);
  }

  const todoCreate = api.sent.find((entry) => entry.name === 'todos.create');
  assert.equal(todoCreate.args[0].comment, 'why', 'the comment reaches the resource layer');
  const versionRestore = api.sent.find((entry) => entry.name === 'versions.restore');
  assert.equal(versionRestore.args[1], 'v1');
});
