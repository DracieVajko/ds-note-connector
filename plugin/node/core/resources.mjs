/**
 * Notebooks, tags, to-dos, search and version history.
 *
 * Small modules on purpose: each one is a thin, honest mapping over the API,
 * with the quirks that cost someone an hour written down next to the code.
 */
const NOTEBOOK_API = 'SYNO.NoteStation.Notebook';
const TAG_API = 'SYNO.NoteStation.Tag';
const TODO_API = 'SYNO.NoteStation.Todo';
const FTS_API = 'SYNO.NoteStation.FTS';
const VERSION_API = 'SYNO.NoteStation.Note.Version';

export function createNotebooksApi(client) {
  async function list() {
    const data = await client.call(NOTEBOOK_API, 'list');
    return (data?.notebooks ?? []).map((notebook) => ({
      id: notebook.object_id,
      title: notebook.title,
      stack: notebook.stack ?? '',
      noteCount: Array.isArray(notebook.items) ? notebook.items.length : 0,
      noteIds: notebook.items ?? [],
      createdAt: notebook.ctime,
      updatedAt: notebook.mtime,
      preset: Boolean(notebook.preset),
    }));
  }

  async function create(title, { stackId } = {}) {
    const data = await client.call(NOTEBOOK_API, 'create', { title, ...(stackId ? { stack_id: stackId } : {}) });
    return data?.notebook ?? data;
  }

  async function rename(objectId, title) {
    return client.call(NOTEBOOK_API, 'update', { object_id: objectId, title });
  }

  async function remove(objectId) {
    return client.call(NOTEBOOK_API, 'delete', { object_id: objectId });
  }

  return { list, create, rename, remove };
}

export function createTagsApi(client) {
  /**
   * Tags are asymmetric: they read as `Name@uid` but are written as plain
   * names, and `Note.list` never returns a note's tags at all. Inverting this
   * list is the only way to know which notes carry a tag in bulk.
   */
  async function list() {
    const data = await client.call(TAG_API, 'list');
    return (data?.tags ?? []).map((tag) => ({
      id: tag.tag_id,
      title: tag.title,
      noteIds: tag.items ?? [],
    }));
  }

  /** noteId → tag titles, built from the inverted tag list. */
  async function mapByNote() {
    const tags = await list();
    const map = new Map();
    for (const tag of tags) {
      for (const noteId of tag.noteIds) {
        if (!map.has(noteId)) map.set(noteId, []);
        map.get(noteId).push(tag.title);
      }
    }
    return map;
  }

  async function create(name) {
    const data = await client.call(TAG_API, 'create', { name });
    return data?.tag ?? data;
  }

  return { list, mapByNote, create };
}

export function createTodosApi(client) {
  async function list({ includeItems = false, limit = 100, offset = 0 } = {}) {
    const data = await client.call(TODO_API, 'list', {
      field: includeItems ? { items: true } : {},
      filter: {},
      offset,
      limit,
      sort_by: 'due_date',
      sort_direction: 'asc',
    });
    return {
      todos: (data?.todos ?? []).map(normalizeTodo),
      total: data?.total ?? data?.count ?? 0,
    };
  }

  function normalizeTodo(todo) {
    return {
      id: todo.object_id,
      title: todo.title,
      comment: todo.comment ?? '',
      done: Boolean(todo.done),
      starred: Boolean(todo.star),
      priority: todo.priority ?? -1,
      dueDate: todo.due_date && todo.due_date > 0 ? todo.due_date : null,
      parentId: todo.parent_id || null,
      noteId: todo.note_id || null,
      noteTitle: todo.note_title || '',
      items: todo.items ?? [],
    };
  }

  async function create({ title, comment, dueDate, parentId, noteId }) {
    const params = { title };
    if (comment) params.comment = comment;
    if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
      const seconds = Math.floor(Number(dueDate));
      if (!Number.isFinite(seconds)) throw new Error('dueDate must be an ISO date or datetime');
      params.due_date = seconds;
    }
    if (parentId) params.parent_id = parentId;
    if (noteId) params.note_id = noteId;
    return client.call(TODO_API, 'create', params);
  }

  /** Only the fields you pass are sent; everything else is left alone. */
  async function set(objectId, changes) {
    const params = { object_id: [objectId] };
    if (changes.title !== undefined) params.title = changes.title;
    if (changes.comment !== undefined) params.comment = changes.comment;
    if (changes.done !== undefined) params.done = Boolean(changes.done);
    if (changes.starred !== undefined) params.star = Boolean(changes.starred);
    if (changes.priority !== undefined) params.priority = Number(changes.priority);
    if (changes.dueDate !== undefined) {
      const seconds = Math.floor(Number(changes.dueDate));
      if (!Number.isFinite(seconds)) throw new Error('dueDate must be an ISO date or datetime');
      params.due_date = seconds;
    }
    return client.call(TODO_API, 'set', params);
  }

  /** Todo.delete is v1 while list/create/set are v2 — pinned in client.mjs. */
  async function remove(objectId) {
    return client.call(TODO_API, 'delete', { object_id: [objectId] });
  }

  return { list, create, set, remove };
}

export function createSearchApi(client) {
  /**
   * Full-text search. Returns raw note objects, the same shape `Note.list`
   * returns — the presentation layer is what turns them into summaries.
   */
  async function search(keyword, { offset = 0, limit = 50 } = {}) {
    if (!keyword || String(keyword).trim() === '') throw new Error('keyword is required');
    const data = await client.call(FTS_API, 'search', { keyword: String(keyword), offset, limit });
    // The response key is `matches`, not `notes` as the captured write-up said.
    // Verified live: {"data":{"matches":[{...note...}],"offset":0},"success":true}
    const notes = data?.matches ?? data?.notes ?? [];
    return { notes, total: data?.total ?? notes.length };
  }
  return { search };
}

export function createVersionsApi(client) {
  async function list(objectId, { limit = 50 } = {}) {
    const data = await client.call(VERSION_API, 'list', {
      object_id: objectId,
      limit,
      filter: { listable: true },
    });
    return (data?.versions ?? []).map((version) => ({
      id: version.id,
      version: version.version,
      author: version.author,
      updatedAt: version.mtime,
      commitMsg: version.commit_msg ?? {},
    }));
  }

  /** Put a note back to a previous revision, in place. This is the undo. */
  async function restore(objectId, version) {
    return client.call(VERSION_API, 'restore', { object_id: objectId, ver: version });
  }

  return { list, restore };
}
