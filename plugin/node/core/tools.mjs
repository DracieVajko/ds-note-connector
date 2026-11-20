/**
 * The tool catalog.
 *
 * One definition of what an agent can do, shared by every adapter (MCP now,
 * the Cindy plugin next, a CLI after that). Adapters add transport and
 * presentation; they never add behaviour.
 *
 * Descriptions are written for a model, not for a human reader of API docs:
 * they say when to use the tool, what it will not do, and which mistake it
 * exists to prevent.
 */
import { normalizeNote } from './notes.mjs';

const ID_NOTE = 'Use an object_id returned by dsnote_search or dsnote_list_notes — never a title.';

function summariseNote(note) {
  return {
    id: note.object_id,
    title: note.title,
    notebookId: note.parent_id,
    brief: note.brief ?? '',
    updatedAt: note.mtime,
    version: note.ver,
    encrypted: Boolean(note.encrypt),
  };
}

/**
 * Calls the raw tool must not make.
 *
 * The plugin promises that nothing destroys a note permanently. A debug tool
 * that can issue `Note.delete` with `recycle=false` breaks that promise, and
 * `Notebook.delete` takes the notes inside with it. Both stay available in the
 * DSM web client, where the user is the one clicking and can see what is about
 * to go.
 */
const PERMANENT = new Set([false, 0, '0', 'false', 'False', 'FALSE', null, '']);


const JSON_TYPES = {
  string: (value) => typeof value === 'string',
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
  object: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  null: (value) => value === null,
};

/**
 * Enforce the schema a tool publishes.
 *
 * Without this the published `inputSchema` is documentation only, and a
 * misspelled action or an out-of-enum value reaches a handler that may treat
 * anything unexpected as the write branch.
 */
export function validateToolArguments(schema, args, path = 'arguments') {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.oneOf)) {
    const ok = schema.oneOf.some((option) => {
      try {
        validateToolArguments(option, args, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!ok) throw new Error(`${path} does not match any allowed shape`);
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const unknown = types.filter((type) => !JSON_TYPES[type]);
    if (unknown.length) throw new Error(`${path} uses an unsupported schema type (${unknown.join(', ')})`);
    if (!types.some((type) => JSON_TYPES[type](args))) {
      throw new Error(`${path} must be ${types.join(' or ')}`);
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(args)) {
    throw new Error(`${path} must be one of: ${schema.enum.map(String).join(', ')}`);
  }
  if (typeof args === 'string') {
    if (schema.minLength !== undefined && args.length < schema.minLength) {
      throw new Error(`${path} must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && args.length > schema.maxLength) {
      throw new Error(`${path} must be at most ${schema.maxLength} characters`);
    }
  }
  if (typeof args === 'number') {
    if (schema.minimum !== undefined && args < schema.minimum) {
      throw new Error(`${path} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && args > schema.maximum) {
      throw new Error(`${path} must be at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(args)) {
    if (schema.minItems !== undefined && args.length < schema.minItems) {
      throw new Error(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && args.length > schema.maxItems) {
      throw new Error(`${path} must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      args.forEach((entry, index) => validateToolArguments(schema.items, entry, `${path}[${index}]`));
    }
    return;
  }
  if (args && typeof args === 'object') {
    for (const key of schema.required ?? []) {
      if (args[key] === undefined) throw new Error(`${path} is missing the required key ${key}`);
    }
    for (const [key, value] of Object.entries(args)) {
      if (schema.properties?.[key]) {
        validateToolArguments(schema.properties[key], value, `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        throw new Error(
          `${path} has an unknown key ${key}. Supported: ${Object.keys(schema.properties ?? {}).join(', ')}`,
        );
      }
    }
  }
}

export function rawBlocked(api, method, params = {}) {
  // A missing recycle flag may mean "permanent" just as an explicit false does,
  // and 0/"false" reach the NAS the same way. null and '' are in the set
  // because the encoder drops them, leaving the same flagless delete.
  const permanent = 'recycle' in params ? PERMANENT.has(params.recycle) : true;
  if (api === 'SYNO.NoteStation.Note' && method === 'delete' && permanent) {
    return (
      'Refused: this would delete the note permanently. Notes can only be moved to the recycle bin from ' +
      'here; empty the bin in DSM if permanent removal is really intended.'
    );
  }
  if (api === 'SYNO.NoteStation.Notebook' && method === 'delete') {
    return (
      'Refused: deleting a notebook removes the notes inside it. Do that in DSM, where the user can see ' +
      'what is about to be deleted.'
    );
  }
  return null;
}

/**
 * @param {object} options
 * @param {() => Promise<object>} options.getApi  resolves the connected API surface
 * @param {object} options.config                 feature switch: allowRaw
 */
/**
 * @param {{getApi: () => Promise<any>, allowRaw?: boolean}} options `allowRaw`
 *   is the only switch the catalog reads; it is a flag, not a config bag.
 */
export function createToolCatalog({ getApi, allowRaw = false }) {
  const withApi = async (fn) => {
    const api = await getApi();
    return fn(api);
  };

  const tools = [
    {
      name: 'dsnote_status',
      title: 'Note Station connection status',
      description:
        'Check the connection to the Synology NAS before doing anything else: which route was used (direct, relay or ' +
        'portal), whether the session and CSRF token are live, the DSM version, and how many notebooks, notes and ' +
        'tasks exist. Call this first when a previous call failed, and to confirm that credentials still work. ' +
        'The NAS address, account and serial number are deliberately not returned.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => withApi((api) => api.status()),
    },

    {
      name: 'dsnote_notebooks',
      title: 'List or create notebooks',
      description:
        'List every notebook with its note count, or create/rename one. Call this before creating a note so the ' +
        'note lands in the right notebook instead of the default one.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'rename'], default: 'list' },
          id: { type: 'string', description: 'Notebook object_id (for rename).' },
          title: { type: 'string', description: 'Notebook title (for create and rename).' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const action = args.action ?? 'list';
        if (action === 'list') return withApi(async (api) => ({ notebooks: await api.notebooks.list() }));
        if (action === 'create') {
          if (!args.title) throw new Error('title is required to create a notebook');
          return withApi((api) => api.notebooks.create(args.title));
        }
        if (action !== 'rename') {
          throw new Error(`action must be "list", "create" or "rename", got "${action}"`);
        }
        if (!args.id || !args.title) throw new Error('id and title are required to rename a notebook');
        return withApi((api) => api.notebooks.rename(args.id, args.title));
      },
    },

    {
      name: 'dsnote_search',
      title: 'Search notes',
      description:
        'Full-text search across note titles and bodies. Returns ids, titles and plain-text snippets. ' +
        'This is the normal way to find a note: search first, then use the id with dsnote_get_note.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          const result = await api.search.search(args.query, { limit: args.limit ?? 20 });
          return { total: result.total, notes: result.notes.map(summariseNote) };
        }),
    },

    {
      name: 'dsnote_list_notes',
      title: 'List notes',
      description:
        'List notes in one notebook, or the recycle bin. Does not return note bodies — use dsnote_get_note for that. ' +
        'Use recycle=true to see what is in the trash.',
      inputSchema: {
        type: 'object',
        properties: {
          notebookId: { type: 'string', description: 'Restrict to one notebook.' },
          recycle: { type: 'boolean', default: false, description: 'List the recycle bin instead of live notes.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          const result = await api.notes.list({
            notebookId: args.notebookId,
            recycle: args.recycle ?? false,
            limit: args.limit ?? 30,
            offset: args.offset ?? 0,
          });
          return { total: result.total, notes: result.notes.map(summariseNote) };
        }),
    },

    {
      name: 'dsnote_get_note',
      title: 'Read one note',
      description:
        'Read a note as Markdown, with its notebook, tags, version and timestamps. ' +
        'The returned version is required if you intend to edit the note. ' +
        'Encrypted notes return no body — that is deliberate, not an error.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: ID_NOTE },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.id) throw new Error('id is required');
          return normalizeNote(await api.notes.get(args.id));
        }),
    },

    {
      name: 'dsnote_create_note',
      title: 'Create a note',
      description:
        'Create a new note from Markdown in a specific notebook. Checkboxes (- [ ] / - [x]), headings, lists, ' +
        'tables, links and bold/italic are converted to the HTML subset Note Station preserves. ' +
        'Requires notebookId — resolve one with dsnote_notebooks first.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string', description: 'Note body in Markdown.' },
          notebookId: { type: 'string', description: 'Target notebook object_id.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag names (plain names, not ids).' },
        },
        required: ['title', 'notebookId'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.notebookId) throw new Error('notebookId is required');
          const note = await api.notes.create({
            title: args.title ?? 'Untitled note',
            markdown: args.markdown ?? '',
            notebookId: args.notebookId,
            tags: args.tags ?? [],
          });
          return normalizeNote(note);
        }),
    },

    {
      name: 'dsnote_update_note',
      title: 'Update a note',
      description:
        'Replace a note body and/or change its title, tags or star. Reads the current version first, so an edit made ' +
        'on another device in the meantime is refused with a conflict instead of being overwritten. ' +
        'Only the fields you pass are changed.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: ID_NOTE },
          title: { type: 'string' },
          markdown: { type: 'string', description: 'New body in Markdown; replaces the old body entirely.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the tag list when given.' },
          notebookId: { type: 'string', description: 'Move the note into this notebook.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.id) throw new Error('id is required');
          const current = await api.notes.get(args.id);
          if (current.encrypt) {
            throw new Error('This note is encrypted; its body cannot be read or rewritten through the API.');
          }
          await api.notes.set({
            objectId: args.id,
            ver: current.ver,
            title: args.title,
            markdown: args.markdown,
            tags: args.tags,
            notebookId: args.notebookId,
          });
          return normalizeNote(await api.notes.get(args.id));
        }),
    },

    {
      name: 'dsnote_append_note',
      title: 'Append to a note',
      description:
        'Add Markdown to the end of an existing note without touching what is already there. ' +
        'This is the safe way to add a log entry or a new section.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: ID_NOTE },
          markdown: { type: 'string' },
          heading: { type: 'string', description: 'Optional heading placed above the appended text.' },
        },
        required: ['id', 'markdown'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.id) throw new Error('id is required');
          const current = await api.notes.get(args.id);
          if (current.encrypt) throw new Error('This note is encrypted; nothing can be appended to it.');
          const note = await api.notes.append({ objectId: args.id, markdown: args.markdown, heading: args.heading });
          return normalizeNote(note);
        }),
    },

    {
      name: 'dsnote_attach_image',
      title: 'Attach an image to a note',
      description:
        'Upload a local image file and append it to a note. The file must already exist on this computer; give its ' +
        'absolute path. The image is stored on the NAS and appears at the end of the note body. ' +
        'Only use this when the user asked to put a specific file into a note.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: ID_NOTE },
          path: { type: 'string', description: 'Absolute path of the image on this computer.' },
          caption: { type: 'string', description: 'Optional caption stored with the attachment.' },
          width: { type: 'integer', description: 'Display width in pixels.' },
          height: { type: 'integer', description: 'Display height in pixels.' },
        },
        required: ['id', 'path'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.id) throw new Error('id is required');
          if (!args.path) throw new Error('path is required');
          const result = await api.notes.attachImage({
            objectId: args.id,
            filePath: args.path,
            caption: args.caption,
            width: args.width,
            height: args.height,
          });
          return { ok: true, noteId: args.id, attachment: result.fileName, bytes: result.bytes };
        }),
    },

    {
      name: 'dsnote_trash_note',
      title: 'Move a note to the recycle bin',
      description:
        'Soft delete. The note goes to the recycle bin and can be restored with dsnote_restore_note. ' +
        'Nothing is destroyed permanently by this tool, and it does not empty the bin.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: ID_NOTE } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.id) throw new Error('id is required');
          await api.notes.trash(args.id);
          return { ok: true, id: args.id, movedToRecycleBin: true };
        }),
    },

    {
      name: 'dsnote_restore_note',
      title: 'Restore a note from the recycle bin',
      description: 'Put a trashed note back into the notebook it came from.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: ID_NOTE } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.id) throw new Error('id is required');
          await api.notes.restore(args.id);
          return { ok: true, id: args.id, restored: true };
        }),
    },

    {
      name: 'dsnote_tags',
      title: 'List tags',
      description:
        'List every tag with the notes that carry it. Note Station stores tags asymmetrically: they read as ' +
        '"Name@uid" but are written as plain names, and a note list never includes them.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'Return only the tags carried by this note.' },
        },
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (args.noteId) {
            const note = await api.notes.get(args.noteId);
            return { tags: note.tag ?? [] };
          }
          const tags = await api.tags.list();
          return {
            tags: tags.map((tag) => ({ name: tag.title, noteCount: tag.noteIds.length, noteIds: tag.noteIds })),
          };
        }),
    },

    {
      name: 'dsnote_todos',
      title: 'Note Station tasks',
      description:
        'Read and change the task list that lives next to the notes. Actions: list, create, update, complete, delete. ' +
        'Tasks are separate objects, not checkboxes inside a note — use dsnote_append_note for those.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'complete', 'delete'], default: 'list' },
          id: { type: 'string', description: 'Task object_id (update/complete/delete).' },
          title: { type: 'string' },
          comment: { type: 'string' },
          dueDate: { type: 'string', description: 'ISO date or datetime for the due date.' },
          done: { type: 'boolean' },
          priority: { type: 'integer', description: 'Note Station priority value; only 300 is known to be meaningful.' },
        },
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          const action = args.action ?? 'list';
          const due = args.dueDate ? Math.floor(new Date(args.dueDate).getTime() / 1000) : undefined;
          if (action === 'list') {
            const result = await api.todos.list({ limit: 100 });
            return { total: result.total, todos: result.todos };
          }
          if (action === 'create') {
            if (!args.title) throw new Error('title is required to create a task');
            return api.todos.create({ title: args.title, dueDate: due, comment: args.comment });
          }
          if (!['update', 'complete', 'delete'].includes(action)) {
            throw new Error(`action must be "list", "create", "update", "complete" or "delete", got "${action}"`);
          }
          if (!args.id) throw new Error('id is required for update, complete and delete');
          if (action === 'complete') {
            await api.todos.set(args.id, { done: true });
            return { ok: true, id: args.id, done: true };
          }
          if (action === 'delete') {
            await api.todos.remove(args.id);
            return { ok: true, id: args.id, deleted: true };
          }
          await api.todos.set(args.id, {
            title: args.title,
            comment: args.comment,
            done: args.done,
            priority: args.priority,
            dueDate: due,
          });
          const { todos } = await api.todos.list({ limit: 200 });
          return todos.find((todo) => todo.id === args.id) ?? { ok: true, id: args.id };
        }),
    },

    {
      name: 'dsnote_versions',
      title: 'Note version history',
      description:
        'List a note\'s revisions, or restore one in place. This is the undo after a bad edit: restoring a ' +
        'revision overwrites the current body with that older one, so read the note first if you are unsure.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: ID_NOTE },
          action: { type: 'string', enum: ['list', 'restore'], default: 'list' },
          version: { type: 'string', description: 'The `version` value from a previous list call (for restore).' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          if (!args.id) throw new Error('id is required');
          const action = args.action ?? 'list';
          if (action === 'list') {
            return { versions: await api.versions.list(args.id) };
          }
          if (action !== 'restore') {
            throw new Error(`action must be "list" or "restore", got "${action}"`);
          }
          if (!args.version) throw new Error('version is required to restore');
          await api.versions.restore(args.id, args.version);
          return normalizeNote(await api.notes.get(args.id));
        }),
    },
  ];

  if (allowRaw) {
    tools.push({
      name: 'dsnote_raw',
      title: 'Raw Note Station API call (debug)',
      description:
        'Call an undocumented SYNO.NoteStation.* method directly. Only available when explicitly enabled. ' +
        'Parameters are sent as JSON literals. Use this to investigate, not to do normal work. ' +
        'Destructive calls are refused here: permanent note deletion (Note.delete with recycle=false) and ' +
        'notebook deletion, because the second removes the notes inside it. Both remain possible only by ' +
        'hand in DSM, where the user sees what is about to disappear.',
      inputSchema: {
        type: 'object',
        properties: {
          api: { type: 'string', description: 'e.g. SYNO.NoteStation.Smart' },
          method: { type: 'string', description: 'e.g. list' },
          version: { type: 'integer', description: 'Override the pinned version.' },
          params: { type: 'object', description: 'Parameters, encoded as JSON literals.' },
        },
        required: ['api', 'method'],
        additionalProperties: false,
      },
      handler: async (args) =>
        withApi(async (api) => {
          const params = args.params ?? {};
          const blocked = rawBlocked(args.api, args.method, params);
          if (blocked) throw new Error(blocked);
          return api.client.call(args.api, args.method, params, {
            ...(args.version ? { version: args.version } : {}),
          });
        }),
    });
  }

  /** Run a tool, converting every failure into a result instead of a throw. */
  async function invoke(name, args = {}) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) {
      return {
        ok: false,
        error: `unknown tool "${name}"`,
        kind: 'UnknownTool',
        available: tools.map((entry) => entry.name),
      };
    }
    try {
      validateToolArguments(tool.inputSchema, args);
    } catch (error) {
      return { ok: false, error: error.message, kind: 'InvalidArguments' };
    }
    try {
      const result = await tool.handler(args);
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        kind: error.kind || error.name,
        hint:
          error.name === 'NoteConflictError'
            ? 'Re-read the note and reapply the change; nothing was overwritten.'
            : undefined,
      };
    }
  }

  return {
    tools,
    invoke,
    /** The `tools/list` payload an MCP client expects. */
    listForProtocol() {
      return tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
  };
}
