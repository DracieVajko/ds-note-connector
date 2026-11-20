/**
 * Notes: the part where a wrong assumption costs data.
 *
 * Three rules shape this module:
 *
 *  1. Creating a note is two calls. `Note.create` makes an *empty* note and
 *     returns its `ver`; the body arrives in a follow-up `Note.set`. Doing
 *     only the first leaves an empty note in the user's notebook.
 *  2. Every write carries `ver` + `check_conflict=true`, so an edit made in
 *     the phone app between our read and our write is refused instead of
 *     silently overwritten.
 *  3. Deleting means trash. Purging is a different intent expressed by the
 *     same method with `recycle=false`, so it is gated behind an explicit
 *     opt-in and never reachable from a plain "delete".
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { DsmError } from './errors.mjs';
import { deriveBrief, markdownToNoteHtml, noteHtmlToMarkdown } from './html.mjs';

const NOTE_API = 'SYNO.NoteStation.Note';

export class NoteConflictError extends DsmError {
  constructor(objectId, expectedVer, actualVer) {
    super(
      `Note ${objectId} changed since it was read (ver ${expectedVer} → ${actualVer}). ` +
        'Re-read it and reapply the change; nothing was overwritten.',
      { api: NOTE_API, method: 'set' },
    );
    this.name = 'NoteConflictError';
    this.objectId = objectId;
    this.expectedVer = expectedVer;
    this.actualVer = actualVer;
  }
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function createNotesApi(client, { allowPurge = false } = {}) {

  async function list({ notebookId, offset = 0, limit = 50, sortBy = 'mtime', sortDirection = 'desc', recycle = false, archive = false } = {}) {
    const filter = { recycle, archive };
    if (notebookId) filter.parent_id = notebookId;
    const data = await client.call(NOTE_API, 'list', {
      filter,
      field: { link_id: true, commit_msg: true },
      offset,
      limit,
      sort_by: sortBy,
      sort_direction: sortDirection,
    });
    return {
      notes: data?.notes ?? [],
      total: data?.total ?? data?.count ?? (data?.notes ?? []).length,
      offset: data?.offset ?? offset,
    };
  }

  async function get(objectId, { ver } = {}) {
    if (!objectId) throw new Error('objectId is required');
    const params = { object_id: objectId };
    if (ver) params.ver = ver;
    const note = await client.call(NOTE_API, 'get', params);
    if (!note) throw new DsmError(`Note ${objectId} was not returned by the server`, { api: NOTE_API, method: 'get' });
    return note;
  }

  /** Create an empty note, then apply the body and tags in one `set`. */
  async function create({ title = 'Untitled note', markdown, contentHtml, notebookId, tags = [] }) {
    if (!notebookId) {
      throw new Error('notebookId is required — resolve a notebook first so the note does not land in the default one');
    }
    if (contentHtml !== undefined && markdown !== undefined) {
      throw new Error('pass markdown or contentHtml, not both');
    }
    const html = contentHtml ?? (markdown !== undefined ? markdownToNoteHtml(markdown) : '');
    const created = await client.call(NOTE_API, 'create', {
      commit_msg: { device: 'desktop', listable: false },
      title,
      parent_id: notebookId,
      encrypt: false,
    });
    const objectId = created?.object_id;
    if (!objectId) {
      throw new DsmError('Note.create succeeded but returned no object_id', { api: NOTE_API, method: 'create' });
    }
    if (html !== '' || tags.length > 0) {
      await set({ objectId, ver: created.ver, title, contentHtml: html, tags });
    }
    // Always the normalised read shape, so a caller never has to branch on
    // whether the note had a body.
    return get(objectId);
  }

  async function set({ objectId, ver, title, markdown, contentHtml, tags, notebookId }) {
    if (!objectId) throw new Error('objectId is required');
    if (!ver) throw new Error('ver is required for a write — read the note first so the server can detect a conflict');

    const params = { object_id: objectId, ver, check_conflict: true, commit_msg: { device: 'desktop' } };
    if (title !== undefined) params.title = title;
    if (tags !== undefined) params.tag = asArray(tags);
    // Moving between notebooks is the same write; the param is unverified.
    if (notebookId) params.parent_id = notebookId;

    if (contentHtml !== undefined && markdown !== undefined) {
      throw new Error('pass markdown or contentHtml, not both');
    }
    const html = contentHtml ?? (markdown !== undefined ? markdownToNoteHtml(markdown) : undefined);
    if (html !== undefined) {
      params.content = html;
      params.brief = deriveBrief(html);
    }

    try {
      const data = await client.call(NOTE_API, 'set', params);
      return data?.data?.[0] ?? data;
    } catch (error) {
      // The server's conflict code is undocumented, so do not guess at it:
      // re-read and compare the version. That is evidence, not a heuristic.
      const current = await get(objectId).catch(() => null);
      if (current?.ver && current.ver !== ver) {
        throw new NoteConflictError(objectId, ver, current.ver);
      }
      throw error;
    }
  }

  /**
   * Append Markdown to the end of a note's body.
   * Reads, converts, appends, writes with the version that was read.
   */
  async function append({ objectId, markdown, heading }) {
    const note = await get(objectId);
    const existingHtml = note.content ?? '';
    const addition = markdownToNoteHtml(heading ? `## ${heading}\n${markdown}` : markdown);
    const merged = `${existingHtml}${addition}`;
    await set({ objectId, ver: note.ver, contentHtml: merged });
    return get(objectId);
  }

  /** Soft delete: the note goes to the recycle bin. */
  async function trash(objectIds) {
    const ids = asArray(objectIds);
    if (ids.length === 0) throw new Error('at least one note id is required');
    return client.call(NOTE_API, 'delete', { object_id: ids, recycle: true });
  }

  async function restore(objectIds) {
    const ids = asArray(objectIds);
    if (ids.length === 0) throw new Error('at least one note id is required');
    return client.call(NOTE_API, 'restore', { object_id: ids });
  }

  /**
   * Permanent removal.
   *
   * Not exposed as a tool and not reachable from the raw tool either: the
   * plugin promises that nothing it does destroys a note. It stays here because
   * a caller embedding core/ may legitimately need it, and it is the only place
   * `recycle=false` is sent.
   */
  async function purge(objectIds) {
    if (allowPurge !== true) {
      throw new Error(
        'purge is disabled: permanent deletion needs an explicit allowPurge decision. ' +
          'Move the note to the recycle bin instead, or empty the bin in DSM where the user sees what disappears.',
      );
    }
    const ids = asArray(objectIds);
    if (ids.length === 0) throw new Error('at least one note id is required');
    return client.call(NOTE_API, 'delete', { object_id: ids, recycle: false });
  }

  /**
   * Attach an image to a note.
   *
   * There is no upload endpoint: the stock client re-sends `Note.set` as
   * multipart with the file as one extra part, and puts an `<img>` in the body
   * whose `ref` matches the attachment entry. The real picture never lives in
   * `src` — that is a transparent placeholder, and the NAS resolves the image
   * from `ref` against the note's attachment map.
   *
   * Unverified against a live NAS when written; see docs/VERIFIED.md.
   */
  async function attachImage({ objectId, filePath, contentType, width, height, caption }) {
    if (!objectId) throw new Error('objectId is required');
    if (!filePath) throw new Error('filePath is required');

    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${filePath} is not a file`);
    const data = await readFile(filePath);
    const fileName = basename(filePath);
    const ref = Buffer.from(`${Date.now()}${fileName}`).toString('base64');

    const note = await get(objectId);
    if (note.encrypt) throw new Error('This note is encrypted; an image cannot be attached to it.');

    const size = [width ? ` width="${Number(width)}"` : '', height ? ` height="${Number(height)}"` : ''].join('');
    const imageHtml =
      `<div><img class="syno-notestation-image-object" ` +
      `src="webman/3rdparty/NoteStation/images/transparent.gif" ref="${ref}"${size}></div>`;
    const content = `${note.content ?? ''}${imageHtml}`;

    const params = {
      commit_msg: { device: 'desktop', listable: false },
      object_id: objectId,
      ver: note.ver,
      check_conflict: true,
      content,
      brief: deriveBrief(content),
      attachment: [
        { action: 'create', name: fileName, format: 'raw', source: fileName, ref, rotate: true },
      ],
    };
    if (caption) params.caption = caption;

    const result = await client.callMultipart(NOTE_API, 'set', {
      params,
      files: [
        {
          name: fileName,
          filename: fileName,
          contentType: contentType ?? guessContentType(fileName),
          data,
        },
      ],
    });
    return { ref, fileName, bytes: data.length, response: result };
  }

  function guessContentType(fileName) {
    const ext = String(fileName).toLowerCase().split('.').pop();
    return (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        pdf: 'application/pdf',
        txt: 'text/plain',
      }[ext] ?? 'application/octet-stream'
    );
  }

  return { list, get, create, set, append, trash, restore, purge, attachImage };
}

/**
 * The normalized view of a note: camelCase, Markdown body, attachments listed.
 *
 * `normalizeNote` turns a raw `Note.get` / `Note.list` payload into one shape.
 * The notes API itself still returns the DSM envelopes; the tool layer calls
 * this at the boundary, so an MCP or panel caller always sees the same fields.
 */
/**
 * @typedef {Object} NormalizedNote
 * @property {string} id
 * @property {string} title
 * @property {string} notebookId
 * @property {number|null} createdAt epoch seconds, as DSM reports it
 * @property {number|null} modifiedAt epoch seconds
 * @property {string[]} tags
 * @property {string} brief
 * @property {string} [markdown] present when the caller read the body
 * @property {string} [version]
 * @property {boolean} [encrypted]
 * @property {boolean} [starred]
 * @property {Array<*>} [attachments]
 */

/**
 * @param {Object} note raw Note.get or Note.list entry
 * @returns {NormalizedNote}
 */
export function normalizeNote(note) {
  const attachments = Object.values(note.attachment ?? {}).map((entry) => ({
    name: entry.name,
    type: entry.type,
    size: entry.size,
    ref: entry.ref,
  }));
  let markdown = note.encrypt ? null : noteHtmlToMarkdown(note.content ?? '');
  // A stored image carries a base64 `ref`, not a file name. Substitute the
  // name so the body reads like something a person wrote.
  if (markdown) {
    for (const attachment of attachments) {
      if (attachment.ref) markdown = markdown.split(`![${attachment.ref}]`).join(`![${attachment.name}]`);
    }
  }
  return {
    id: note.object_id,
    title: note.title,
    notebookId: note.parent_id,
    tags: asArray(note.tag),
    createdAt: note.ctime,
    updatedAt: note.mtime,
    version: note.ver,
    encrypted: Boolean(note.encrypt),
    recycled: Boolean(note.recycle),
    starred: Boolean(note.is_starred),
    markdown,
    attachments,
    brief: note.brief ?? '',
  };
}
