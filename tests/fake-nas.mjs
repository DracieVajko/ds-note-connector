#!/usr/bin/env node
/**
 * A fake Synology NAS that behaves like the captured Note Station API.
 *
 * The point is not to be a simulator of DSM — it is to make the real client
 * fail the same way the real server would:
 *
 *  - `SYNO.NoteStation.*` on `/webapi/entry.cgi` is an error, not a fallback.
 *  - NoteStation params must arrive as JSON literals, not bare form fields.
 *  - A write without `X-SYNO-TOKEN` is refused with 105.
 *  - A write without `_sid` is refused with 119.
 *  - `Note.set` without a matching `ver` is refused.
 *  - `Note.list` omits `content` and `tag`, exactly like the real one.
 *
 * Run standalone:  node tests/fake-nas.mjs [port]
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeJsonValue } from '../core/encoding.mjs';

const VOLUME = 1026;

function ulidLike() {
  return crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26);
}

function objectId() {
  return `${VOLUME}_${ulidLike()}`;
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function ok(data) {
  return { success: true, data };
}

function fail(code) {
  return { success: false, error: { code } };
}

/** Read a whole request body. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Multipart is how an attachment is uploaded — `Note.set` re-sent with the file
 * as one part. Only the part headers matter here; the bytes are counted, not
 * kept.
 */
function parseMultipart(raw, boundary) {
  const fields = {};
  const files = [];
  const marker = `--${boundary}`;
  const headerEnd = String.fromCharCode(13, 10, 13, 10);
  const trailing = new RegExp(String.fromCharCode(13, 10) + '$');
  for (const part of String(raw).split(marker)) {
    const split = part.indexOf(headerEnd);
    if (split === -1) continue;
    const headers = part.slice(0, split);
    const content = part.slice(split + 4).replace(trailing, '');
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]+)"/.exec(headers)?.[1];
    if (filename) files.push({ name, filename, bytes: content.length });
    else fields[name] = content;
  }
  return { fields, files };
}

function parseParams(body, { json }) {
  const params = {};
  const search = new URLSearchParams(body ?? '');
  for (const [key, value] of search.entries()) {
    params[key] = json ? decodeJsonValue(value) : value;
  }
  return params;
}

export function createFakeNasStore() {
  const store = {
    account: 'tester',
    password: 'secret',
    otp: null, // set to e.g. '123456' to require 2FA
    requireOtp: false,
    deviceTokens: new Set(),
    sessions: new Map(),
    notebooks: new Map(),
    notes: new Map(),
    tags: new Map(),
    todos: new Map(),
    calls: [],
  };

  const notebookId = objectId();
  store.notebooks.set(notebookId, {
    object_id: notebookId,
    title: 'Notes',
    stack: '',
    items: [],
    ctime: now(),
    mtime: now(),
    archive: false,
    preset: true,
    category: 'notebook',
  });

  const noteId = objectId();
  const content = '<div>Welcome to Note Station.</div>';
  store.notes.set(noteId, {
    object_id: noteId,
    parent_id: notebookId,
    title: 'Welcome',
    content,
    brief: 'Welcome to Note Station.',
    tag: [],
    ctime: now(),
    mtime: now(),
    encrypt: false,
    recycle: false,
    archive: false,
    category: 'note',
    owner: { display_name: 'tester', uid: VOLUME },
    acl: {},
    ver: sha1(content),
    versions: [],
  });
  store.notebooks.get(notebookId).items.push(noteId);

  return store;
}

function pushVersion(note, commitMsg = { device: 'desktop' }) {
  note.versions.unshift({
    id: note.versions.length + 1,
    version: note.ver,
    author: 'tester',
    mtime: note.mtime,
    commit_msg: commitMsg,
    snapshot: { content: note.content, title: note.title, brief: note.brief, tag: [...note.tag] },
  });
}

function applyNoteWrite(store, note, params) {
  if (params.title !== undefined) note.title = params.title;
  if (params.content !== undefined) {
    note.content = params.content;
    note.brief = params.brief ?? String(params.content).replace(/<[^>]*>/g, ' ').slice(0, 200).trim();
    note.ver = sha1(`${note.content}:${Date.now()}`);
  }
  if (params.tag !== undefined) {
    note.tag = Array.isArray(params.tag) ? params.tag : [params.tag];
    for (const name of note.tag) {
      const id = `${name}@${VOLUME}`;
      if (!store.tags.has(id)) store.tags.set(id, { tag_id: id, title: name, items: [], category: 'tag' });
      const tag = store.tags.get(id);
      if (!tag.items.includes(note.object_id)) tag.items.push(note.object_id);
    }
  }
  if (params.is_starred !== undefined) note.is_starred = Boolean(params.is_starred);
  note.mtime = now();
}

function publicNote(note, { includeContent }) {
  const base = {
    object_id: note.object_id,
    parent_id: note.parent_id,
    title: note.title,
    brief: note.brief,
    ctime: note.ctime,
    mtime: note.mtime,
    encrypt: note.encrypt,
    recycle: note.recycle,
    archive: note.archive,
    category: 'note',
    owner: note.owner,
    acl: note.acl,
    ver: note.ver,
    perm: 'owner',
    thumb: null,
    attachment: note.attachment ?? null,
  };
  if (note.is_starred !== undefined) base.is_starred = note.is_starred;
  if (includeContent) {
    base.content = note.content;
    base.tag = note.tag;
  }
  return base;
}

function handleNoteStationApi(store, api, method, params) {
  const version = Number(params.version ?? 1);

  switch (api) {
    case 'SYNO.NoteStation.Notebook': {
      if (method === 'list') {
        const notebooks = [...store.notebooks.values()];
        return ok({ notebooks, total: notebooks.length, offset: 0, count: notebooks.length });
      }
      if (method === 'create') {
        const id = objectId();
        const notebook = {
          object_id: id,
          title: params.title ?? 'Untitled notebook',
          stack: '',
          items: [],
          ctime: now(),
          mtime: now(),
          archive: false,
          preset: false,
          category: 'notebook',
        };
        store.notebooks.set(id, notebook);
        return ok({ notebook });
      }
      if (method === 'update') {
        const notebook = store.notebooks.get(params.object_id);
        if (!notebook) return fail(101);
        notebook.title = params.title ?? notebook.title;
        notebook.mtime = now();
        return ok({ notebook });
      }
      if (method === 'delete') {
        if (!store.notebooks.delete(params.object_id)) return fail(101);
        return ok({});
      }
      return fail(103);
    }

    case 'SYNO.NoteStation.Note': {
      if (method === 'list') {
        const filter = params.filter ?? {};
        const recycle = filter.recycle === true;
        const notes = [...store.notes.values()].filter((note) => {
          if (Boolean(note.recycle) !== recycle) return false;
          if (filter.parent_id && note.parent_id !== filter.parent_id) return false;
          return true;
        });
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? 50);
        const page = notes.slice(offset, offset + limit);
        return ok({
          notes: page.map((note) => publicNote(note, { includeContent: false })),
          total: notes.length,
          count: page.length,
          offset,
        });
      }
      if (method === 'get') {
        const note = store.notes.get(params.object_id);
        if (!note) return fail(101);
        if (params.ver) {
          const version = note.versions.find((entry) => entry.version === params.ver);
          if (!version) return fail(101);
          return ok({ ...publicNote(note, { includeContent: true }), ...version.snapshot, ver: version.version });
        }
        return ok(publicNote(note, { includeContent: true }));
      }
      if (method === 'create') {
        if (!store.notebooks.has(params.parent_id)) return fail(101);
        const id = objectId();
        const note = {
          object_id: id,
          parent_id: params.parent_id,
          title: params.title ?? 'Untitled Note',
          content: '',
          brief: '',
          tag: [],
          ctime: now(),
          mtime: now(),
          encrypt: Boolean(params.encrypt),
          recycle: false,
          archive: false,
          category: 'note',
          owner: { display_name: 'tester', uid: VOLUME },
          acl: {},
          ver: sha1(`${id}:${Date.now()}`),
          versions: [],
        };
        store.notes.set(id, note);
        store.notebooks.get(params.parent_id).items.push(id);
        return ok(publicNote(note, { includeContent: true }));
      }
      if (method === 'set') {
        const note = store.notes.get(params.object_id);
        if (!note) return fail(101);
        if (params.check_conflict && params.ver !== note.ver) {
          // Real code for this is unverified; the client does not depend on
          // the number, it re-reads and compares versions.
          return fail(409);
        }
        pushVersion(note);
        applyNoteWrite(store, note, params);
        if (Array.isArray(params.attachment) && params.attachment.length > 0) {
          note.attachment = note.attachment ?? {};
          for (const entry of params.attachment) {
            note.attachment[entry.ref] = {
              name: entry.name,
              type: 'image',
              size: (params.__files ?? []).find((file) => file.filename === entry.name)?.bytes ?? 0,
              ref: entry.ref,
            };
          }
        }
        return ok({
          data: [
            {
              object_id: note.object_id,
              ver: note.ver,
              mtime: note.mtime,
              link_id: note.link_id ?? null,
              attachment: null,
              thumb: null,
            },
          ],
        });
      }
      if (method === 'delete') {
        const ids = Array.isArray(params.object_id) ? params.object_id : [params.object_id];
        const recycle = params.recycle !== false;
        for (const id of ids) {
          const note = store.notes.get(id);
          if (!note) return fail(101);
          if (recycle) {
            note.recycle = true;
            note.old_parent_id = note.parent_id;
          } else if (note.recycle) {
            store.notes.delete(id);
          }
        }
        return ok({});
      }
      if (method === 'restore') {
        const ids = Array.isArray(params.object_id) ? params.object_id : [params.object_id];
        for (const id of ids) {
          const note = store.notes.get(id);
          if (!note) return fail(101);
          note.recycle = false;
        }
        return ok({});
      }
      return fail(103);
    }

    case 'SYNO.NoteStation.Tag': {
      if (method === 'list') {
        const tags = [...store.tags.values()];
        return ok({ tags, total: tags.length });
      }
      if (method === 'create') {
        const id = `${params.name}@${VOLUME}`;
        if (!store.tags.has(id)) store.tags.set(id, { tag_id: id, title: params.name, items: [], category: 'tag' });
        return ok({ tag: store.tags.get(id) });
      }
      return fail(103);
    }

    case 'SYNO.NoteStation.Todo': {
      if (method === 'list') {
        const todos = [...store.todos.values()].filter((todo) => !todo.parent_id);
        return ok({ todos, total: todos.length, count: todos.length, offset: 0 });
      }
      if (method === 'create') {
        const id = objectId();
        const todo = {
          object_id: id,
          title: params.title ?? '',
          comment: '',
          done: false,
          star: false,
          priority: -1,
          due_date: params.due_date ?? -1,
          parent_id: params.parent_id ?? '',
          note_id: params.note_id ?? '',
          note_parent_id: '',
          note_title: '',
          reminder_offset: -1,
          items: [],
        };
        store.todos.set(id, todo);
        if (todo.parent_id) {
          const parent = store.todos.get(todo.parent_id);
          if (parent) parent.items.push(id);
        }
        return ok(todo);
      }
      if (method === 'set') {
        const ids = Array.isArray(params.object_id) ? params.object_id : [params.object_id];
        for (const id of ids) {
          const todo = store.todos.get(id);
          if (!todo) return fail(101);
          if (params.title !== undefined) todo.title = params.title;
          if (params.comment !== undefined) todo.comment = params.comment;
          if (params.done !== undefined) todo.done = Boolean(params.done);
          if (params.star !== undefined) todo.star = Boolean(params.star);
          if (params.priority !== undefined) todo.priority = Number(params.priority);
          if (params.due_date !== undefined) todo.due_date = Number(params.due_date);
        }
        return ok({});
      }
      if (method === 'delete') {
        if (version !== 1) return fail(104);
        const ids = Array.isArray(params.object_id) ? params.object_id : [params.object_id];
        for (const id of ids) store.todos.delete(id);
        return ok({});
      }
      return fail(103);
    }

    case 'SYNO.NoteStation.FTS': {
      if (method === 'search') {
        const keyword = String(params.keyword ?? '').toLowerCase();
        const notes = [...store.notes.values()].filter(
          (note) =>
            !note.recycle &&
            (note.title.toLowerCase().includes(keyword) || note.content.toLowerCase().includes(keyword)),
        );
        // The real API returns `matches`, not `notes`; answering with the
        // wrong key is exactly the bug that made search look broken.
        return ok({
          matches: notes.map((note) => publicNote(note, { includeContent: false })),
          offset: 0,
        });
      }
      return fail(103);
    }

    case 'SYNO.NoteStation.Note.Version': {
      if (method === 'list') {
        const note = store.notes.get(params.object_id);
        if (!note) return fail(101);
        return ok({ versions: note.versions, total: note.versions.length, offset: 0, count: note.versions.length });
      }
      if (method === 'restore') {
        const note = store.notes.get(params.object_id);
        if (!note) return fail(101);
        const version = note.versions.find((entry) => entry.version === params.ver);
        if (!version) return fail(101);
        pushVersion(note, { action: 'restore' });
        Object.assign(note, version.snapshot);
        note.ver = sha1(`${note.content}:${Date.now()}`);
        note.mtime = now();
        return ok(publicNote(note, { includeContent: true }));
      }
      return fail(103);
    }

    case 'SYNO.NoteStation.Info': {
      return ok({ uid: VOLUME, username: 'tester', is_admin: true });
    }

    default:
      return fail(102);
  }
}

export function startFakeNas({ port = 0, store = createFakeNasStore(), host = '127.0.0.1' } = {}) {
  store.corePathServesNotes = store.corePathServesNotes ?? false;
  store.packagePathDisabled = store.packagePathDisabled ?? false;

  /** Shared by both entry points, so a test can move the API between them. */
  const serveNoteStation = (params, request, send) => {
    const session = store.sessions.get(params._sid);
    if (!session) return send(fail(119));
    const synotoken = request.headers['x-syno-token'];
    const isWrite = ['create', 'set', 'delete', 'restore', 'update'].includes(String(params.method));
    if (isWrite && synotoken !== session.synotoken) return send(fail(105));
    if (!String(params.api ?? '').startsWith('SYNO.NoteStation.')) return send(fail(102));
    return send(handleNoteStationApi(store, params.api, params.method, params));
  };

  /**
   * The envelope is plain form data; only the API's own parameters are JSON
   * literals. A real DSM rejects a quoted `api`, so this double does too —
   * otherwise the client could ship that mistake and only find out live.
   */
  const envelopeIsQuoted = (body) => {
    const raw = new URLSearchParams(body ?? '');
    return ['api', 'method', 'version', '_sid'].some((key) => {
      const value = raw.get(key);
      return value !== null && value.trim().startsWith('"');
    });
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const body = request.method === 'POST' ? await readBody(request) : '';
    const send = (payload) => {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };

    // Ping-pong, used by QuickConnect probing.
    if (url.pathname === '/webman/pingpong.cgi') {
      send({ success: true, ezid: crypto.createHash('md5').update('fake-server-id').digest('hex') });
      return;
    }

    const isNoteStationPath = url.pathname === '/notestation/webapi/entry.cgi';
    const isCorePath = url.pathname === '/webapi/entry.cgi';
    const isAuthPath = url.pathname === '/webapi/auth.cgi';
    const isQueryPath = url.pathname === '/webapi/query.cgi';

    // --- login ------------------------------------------------------------
    if (isAuthPath || (isCorePath && (url.searchParams.get('api') === 'SYNO.API.Auth' || parseParams(body, { json: false }).api === 'SYNO.API.Auth'))) {
      const params = { ...Object.fromEntries(url.searchParams.entries()), ...parseParams(body, { json: false }) };
      store.calls.push({ path: url.pathname, api: params.api, method: params.method });
      if (params.method === 'logout') {
        store.sessions.delete(params._sid);
        send(ok({}));
        return;
      }
      if (params.account !== store.account || params.passwd !== store.password) {
        send(fail(400));
        return;
      }
      const hasDeviceToken = params.device_id && store.deviceTokens.has(params.device_id);
      if (store.requireOtp && !hasDeviceToken) {
        if (!params.otp_code) {
          send(fail(403));
          return;
        }
        if (params.otp_code !== store.otp) {
          send(fail(404));
          return;
        }
      }
      const sid = crypto.randomBytes(12).toString('hex');
      const synotoken = crypto.randomBytes(16).toString('hex');
      const did = store.requireOtp ? crypto.randomBytes(16).toString('hex') : undefined;
      if (did) store.deviceTokens.add(did);
      store.sessions.set(sid, { account: params.account, synotoken });
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `id=${sid}; path=/`,
      });
      response.end(
        JSON.stringify(
          ok({
            account: params.account,
            sid,
            synotoken,
            ...(did ? { did } : {}),
          }),
        ),
      );
      return;
    }

    // --- API discovery ----------------------------------------------------
    if (isQueryPath) {
      send(
        ok({
          'SYNO.API.Auth': { path: 'auth.cgi', minVersion: 1, maxVersion: 7 },
          'SYNO.API.Info': { path: 'query.cgi', minVersion: 1, maxVersion: 1 },
          'SYNO.NoteStation.Notebook': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
          'SYNO.NoteStation.Note': { path: 'entry.cgi', minVersion: 1, maxVersion: 4 },
          'SYNO.NoteStation.Note.Version': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
          'SYNO.NoteStation.Tag': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
          'SYNO.NoteStation.Todo': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
          'SYNO.NoteStation.FTS': { path: 'entry.cgi', minVersion: 1, maxVersion: 1 },
          'SYNO.NoteStation.Info': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
        }),
      );
      return;
    }

    // --- core entry.cgi ---------------------------------------------------
    if (isCorePath) {
      const params = { ...Object.fromEntries(url.searchParams.entries()), ...parseParams(body, { json: false }) };
      store.calls.push({ path: url.pathname, api: params.api, method: params.method });
      if (String(params.api ?? '').startsWith('SYNO.NoteStation.')) {
        // A NAS configured like a QuickConnect relay serves the package APIs on
        // the core endpoint instead of the package-local one.
        if (store.corePathServesNotes) {
          if (envelopeIsQuoted(body)) return send(fail(101));
          const noteParams = parseParams(body, { json: true });
          store.calls.push({ path: url.pathname, api: noteParams.api, method: noteParams.method, params: noteParams });
          serveNoteStation(noteParams, request, send);
          return;
        }
        // The package-local path exists for a reason; the core path refuses.
        send(fail(102));
        return;
      }
      if (params.api === 'SYNO.DSM.Info') {
        send(ok({ model: 'DS920+', version_string: 'DSM 7.2.2-72806', serial: 'FAKE0001' }));
        return;
      }
      send(fail(102));
      return;
    }

    // --- NoteStation entry.cgi -------------------------------------------
    if (isNoteStationPath) {
      if (store.packagePathDisabled) {
        // What a QuickConnect relay actually answered: a web page, not JSON.
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!DOCTYPE html><html><body>DSM</body></html>');
        return;
      }
      const contentType = String(request.headers['content-type'] ?? '');
      let params;
      if (contentType.startsWith('multipart/form-data')) {
        const boundary = contentType.split('boundary=')[1];
        const { fields, files } = parseMultipart(body, boundary);
        params = {};
        for (const [key, value] of Object.entries(fields)) params[key] = decodeJsonValue(value);
        // api/version/method ride on the query string for an upload.
        for (const key of ['api', 'version', 'method']) {
          if (!params[key] && url.searchParams.get(key)) params[key] = url.searchParams.get(key);
        }
        params.__files = files;
      } else {
        params = parseParams(body, { json: true });
      }
      store.calls.push({ path: url.pathname, api: params.api, method: params.method, params });
      if (!params.__files && envelopeIsQuoted(body)) return send(fail(101));
      serveNoteStation(params, request, send);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        store,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8088);
  const nas = await startFakeNas({ port });
  const store = nas.store;
  const notebook = [...store.notebooks.values()][0];
  console.log(`fake NAS listening on ${nas.url}`);
  // Fixture credentials of this local test double. The password is the literal
  // defined in the store above; printing it would put a credential-shaped string
  // into logs and terminals for no reason.
  console.log(`  account   ${store.account}`);
  console.log('  password  the fixture constant in this file (test double only)');
  console.log(`  notebook  ${notebook.object_id}  (${notebook.title})`);
  console.log('  mode      direct, http, allowSelfSigned=false');
  console.log('  stop      Ctrl+C');
}
