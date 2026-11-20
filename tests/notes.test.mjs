import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeNas } from './fake-nas.mjs';
import { createNoteStation, NoteConflictError, normalizeNote } from '../core/index.mjs';

async function connect(nas, extra = {}) {
  return createNoteStation({
    mode: 'direct',
    host: '127.0.0.1',
    port: nas.port,
    https: false,
    account: 'tester',
    password: 'secret',
    timeoutMs: 5000,
    ...extra,
  });
}

test('connects, reports status, and finds the package-local API path', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const status = await api.status();
  assert.equal(status.session.authenticated, true);
  assert.equal(status.session.csrfToken, true);
  assert.equal(status.dsm.model, 'DS920+');
  assert.ok(status.counts.notebooks >= 1);
  assert.ok(status.noteStationApis > 0);
  assert.equal(status.connection.route, 'direct');
  assert.equal(status.dsm.serial, undefined, 'the serial must never be returned');
  assert.equal(status.endpoint, undefined, 'the address must never be returned');

  const paths = nas.store.calls.map((call) => call.path);
  assert.ok(paths.includes('/webapi/auth.cgi'), 'login goes to auth.cgi');
  assert.ok(paths.includes('/notestation/webapi/entry.cgi'), 'NoteStation calls use the package path');
});

test('creates a note as create + set, with content, brief and tags', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  const note = await api.notes.create({
    title: 'Electrical check',
    notebookId: notebook.id,
    tags: ['Work', 'Electrical'],
    markdown: '# Hall\n\n- [ ] socket 1\n- [x] socket 2',
  });

  assert.equal(note.title, 'Electrical check');
  assert.ok(note.content.includes('<h1>Hall</h1>'));
  assert.ok(note.content.includes('syno-notestation-editor-checkbox'));
  assert.equal(note.brief.startsWith('Hall'), true);
  assert.deepEqual([...note.tag].sort(), ['Electrical', 'Work']);
  assert.equal(note.encrypt, false);
});

test('reading a note gives markdown, not raw HTML', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  const created = await api.notes.create({
    title: 'Round trip',
    notebookId: notebook.id,
    markdown: '## Plan\n\n- one\n- two',
  });
  const note = normalizeNote(await api.notes.get(created.object_id));
  assert.ok(note.markdown.includes('## Plan'));
  assert.ok(note.markdown.includes('- one'));
  assert.equal(note.version, (await api.notes.get(created.object_id)).ver);
});

test('a write with a stale version is refused, not silently applied', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  const created = await api.notes.create({ title: 'Shared', notebookId: notebook.id, markdown: 'v1' });

  const first = await api.notes.get(created.object_id);
  const second = await api.notes.get(created.object_id);

  await api.notes.set({ objectId: created.object_id, ver: first.ver, markdown: 'v2 from desktop' });

  await assert.rejects(
    () => api.notes.set({ objectId: created.object_id, ver: second.ver, markdown: 'v2 from phone' }),
    (error) => {
      assert.ok(error instanceof NoteConflictError);
      assert.equal(error.objectId, created.object_id);
      return true;
    },
  );

  const current = await api.notes.get(created.object_id);
  assert.ok(current.content.includes('v2 from desktop'));
  assert.ok(!current.content.includes('v2 from phone'));
});

test('append keeps the existing body and adds to it', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  const created = await api.notes.create({ title: 'Log', notebookId: notebook.id, markdown: 'first' });
  const updated = await api.notes.append({
    objectId: created.object_id,
    heading: 'Day 2',
    markdown: '- new entry',
  });
  assert.ok(updated.content.includes('first'));
  assert.ok(updated.content.includes('<h2>Day 2</h2>'));
  assert.ok(updated.content.includes('new entry'));
});

test('delete is trash, restore brings it back, purge needs an explicit opt-in', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  const created = await api.notes.create({ title: 'Disposable', notebookId: notebook.id, markdown: 'x' });

  await api.notes.trash(created.object_id);
  const live = await api.notes.list({ notebookId: notebook.id });
  assert.ok(!live.notes.some((note) => note.object_id === created.object_id));
  const trash = await api.notes.list({ recycle: true });
  assert.ok(trash.notes.some((note) => note.object_id === created.object_id));

  await api.notes.restore(created.object_id);
  const restored = await api.notes.list({ notebookId: notebook.id });
  assert.ok(restored.notes.some((note) => note.object_id === created.object_id));

  // purge() is gated: without an explicit allowPurge it refuses, and the raw
  // tool refuses the same call, so an agent cannot reach permanent deletion.
  const { rawBlocked } = await import('../core/tools.mjs');
  assert.ok(rawBlocked('SYNO.NoteStation.Note', 'delete', { recycle: false }));
  assert.ok(rawBlocked('SYNO.NoteStation.Note', 'delete', { recycle: 0 }), '0 counts as a permanent delete');
  assert.ok(rawBlocked('SYNO.NoteStation.Note', 'delete', {}), 'a missing flag may mean permanent');
  await assert.rejects(() => api.notes.purge([created.object_id]), /purge is disabled/);
});

test('tags read as Name@uid but are written as plain names', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  const created = await api.notes.create({
    title: 'Tagged',
    notebookId: notebook.id,
    markdown: 'body',
    tags: ['Inspection'],
  });

  const tags = await api.tags.list();
  const tag = tags.find((entry) => entry.title === 'Inspection');
  assert.ok(tag, 'tag exists');
  assert.match(tag.id, /@\d+$/);
  assert.ok(tag.noteIds.includes(created.object_id));

  const byNote = await api.tags.mapByNote();
  assert.deepEqual(byNote.get(created.object_id), ['Inspection']);
});

test('todo create, update and delete use the pinned versions', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const todo = await api.todos.create({ title: 'Call the electrician', dueDate: Math.floor(Date.now() / 1000) + 86400 });
  await api.todos.set(todo.object_id, { done: true, comment: 'done at 9' });

  const { todos } = await api.todos.list();
  const found = todos.find((entry) => entry.id === todo.object_id);
  assert.equal(found.done, true);
  assert.equal(found.comment, 'done at 9');

  await api.todos.remove(todo.object_id);
  const after = await api.todos.list();
  assert.ok(!after.todos.some((entry) => entry.id === todo.object_id));

  const todoCalls = nas.store.calls.filter((call) => call.api === 'SYNO.NoteStation.Todo');
  assert.ok(todoCalls.some((call) => call.method === 'delete' && call.params.version === 1));
  assert.ok(todoCalls.some((call) => call.method === 'list' && call.params.version === 2));
});

test('search finds notes by title and body', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  await api.notes.create({ title: 'Boiler service', notebookId: notebook.id, markdown: 'pressure 1.4 bar' });

  const byTitle = await api.search.search('Boiler');
  assert.ok(byTitle.notes.some((note) => note.title === 'Boiler service'));

  const byBody = await api.search.search('1.4 bar');
  assert.ok(byBody.notes.some((note) => note.title === 'Boiler service'));

  const none = await api.search.search('nothing-matches-this');
  assert.equal(none.notes.length, 0);
});

test('version history can undo a bad edit', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  const created = await api.notes.create({ title: 'Undo me', notebookId: notebook.id, markdown: 'good content' });

  const before = await api.notes.get(created.object_id);
  await api.notes.set({ objectId: created.object_id, ver: before.ver, markdown: 'ruined content' });

  const versions = await api.versions.list(created.object_id);
  assert.ok(versions.length >= 1);

  const good = versions.find((version) => version.version === before.ver);
  assert.ok(good, 'the pre-edit revision is listed');

  await api.versions.restore(created.object_id, good.version);
  const restored = await api.notes.get(created.object_id);
  assert.ok(restored.content.includes('good content'));
  assert.ok(!restored.content.includes('ruined content'));
});

test('a write without a CSRF token is refused by the server', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const [notebook] = await api.notebooks.list();
  // Simulate a NAS that never handed out a synotoken: shadow the getter so
  // the client sends no X-SYNO-TOKEN header.
  Object.defineProperty(api.session, 'synotoken', { get: () => null, configurable: true });

  await assert.rejects(
    () => api.notes.create({ title: 'No CSRF', notebookId: notebook.id, markdown: 'x' }),
    (error) => error.code === 105 || error.code === 119,
  );
});

test('falls back to the core endpoint when the package path answers with HTML', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  // What a QuickConnect relay did in practice: the package-local path returns
  // a web page, while the same APIs are served on /webapi/entry.cgi.
  nas.store.packagePathDisabled = true;
  nas.store.corePathServesNotes = true;

  const api = await connect(nas);
  t.after(() => api.close());

  const notebooks = await api.notebooks.list();
  assert.ok(notebooks.length >= 1, 'the core endpoint served the notebook list');
  assert.equal(api.client.noteStationPath, 'core');

  // And the choice is remembered: the next call does not try the dead path.
  const before = nas.store.calls.filter((call) => call.path === '/notestation/webapi/entry.cgi').length;
  await api.notes.list({ limit: 1 });
  const after = nas.store.calls.filter((call) => call.path === '/notestation/webapi/entry.cgi').length;
  assert.equal(after, before, 'no further calls to the path that answers HTML');

  const status = await api.status();
  assert.equal(status.apiPath, 'core');
});

test('an image is uploaded through the multipart set path', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  const api = await connect(nas);
  t.after(() => api.close());

  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'dsnote-img-')), 'shot.png');
  writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));

  const [notebook] = await api.notebooks.list();
  const note = await api.notes.create({ title: 'With a picture', notebookId: notebook.id, markdown: 'body' });

  const result = await api.notes.attachImage({ objectId: note.object_id, filePath: file, width: 10, height: 10 });
  assert.equal(result.fileName, 'shot.png');
  assert.ok(result.bytes > 0);

  const stored = await api.notes.get(note.object_id);
  assert.ok(stored.content.includes('syno-notestation-image-object'), 'the img tag is in the body');
  assert.ok(Object.keys(stored.attachment ?? {}).length > 0, 'the attachment map was populated');

  const view = normalizeNote(stored);
  assert.equal(view.attachments[0].name, 'shot.png');
  assert.ok(view.markdown.includes('![shot.png]'), 'the body reads with the file name, not a ref');
});
