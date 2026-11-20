/**
 * Wire encoding for the DSM Web API.
 *
 * Two different encodings exist on the same server, and mixing them up fails
 * silently:
 *
 *  - `SYNO.API.Auth` and the other core APIs take bare form fields:
 *        account=alice&passwd=secret
 *  - every `SYNO.NoteStation.*` API declares `requestFormat: JSON`, so each
 *    value is a JSON literal in the form body:
 *        object_id=%221001_QF64...%22&title=%22New+note%22&check_conflict=true
 *
 * See docs/API.md ("Param value encoding") for the captures behind this.
 */

/** Encode one value the way a `requestFormat: JSON` API expects it. */
export function encodeJsonValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`non-finite number is not encodable: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Encode one value the way a core API (SYNO.API.Auth, SYNO.API.Info) expects it. */
export function encodePlainValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function build(params, encodeOne) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    const encoded = encodeOne(value);
    if (encoded === undefined) continue;
    out.append(key, encoded);
  }
  // URLSearchParams renders a space as "+"; DSM decodes either, but "%20"
  // keeps captured traffic and our traffic byte-identical, which makes
  // diffs against a real capture readable.
  return out.toString().replace(/\+/g, '%20');
}

/** Form body for a `requestFormat: JSON` API (all `SYNO.NoteStation.*`). */
export function encodeJsonBody(params) {
  return build(params, encodeJsonValue);
}

/** Form body for a core API that takes bare form fields. */
export function encodePlainBody(params) {
  return build(params, encodePlainValue);
}

/**
 * Form body for a `SYNO.NoteStation.*` call.
 *
 * The envelope (`api`, `version`, `method`, `_sid`) is plain, exactly like a
 * core API — only the API's own parameters are JSON literals. Quoting the
 * envelope too is a subtle way to get a 101 from a real DSM while a tolerant
 * test double happily accepts it.
 */
export function encodeNoteStationBody(envelope, params) {
  const head = encodePlainBody(envelope);
  const tail = encodeJsonBody(params);
  if (!head) return tail;
  if (!tail) return head;
  return `${head}&${tail}`;
}

/**
 * Decode a value that arrived from a `requestFormat: JSON` API.
 * The NAS always sends a JSON literal, but a bare string is tolerated so the
 * mock and any future permissive server behave the same.
 */
export function decodeJsonValue(raw) {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (text === '') return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
