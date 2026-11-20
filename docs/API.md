# Note Station API — what we know, and how well

Synology never published a specification for `SYNO.NoteStation.*`. Everything
here comes from captured traffic, from other people's reverse engineering, or
from our own runs. Each claim carries a trust level so nobody has to guess how
much weight it holds.

| Level | Meaning |
|---|---|
| **capture** | Seen in a real request/response pair from a stock Note Station client |
| **derived** | Follows from a captured shape by an obvious pattern; not itself observed |
| **guess** | Plausible, unobserved. Do not build anything destructive on it |
| **ours** | Verified by this project against the fake NAS. Not yet a real NAS |

**Provenance.** The detailed field-level documentation this project was built
from is `AWKatz/SynologyNotesEnhanced`, file `.docs/NoteStation API documentation.md`
— a genuinely careful piece of work that tags each fact V (live capture), JS
(grepped from the web client bundle) or I (inference). The QuickConnect
protocol is documented in `nullvoidptr/qcon` (`protocol.md`). Operational
quirks of the relay path come from `VertigoRay/obsidian-synology-sync`.
Where this file says "capture", it means one of those sources, not us.

Every claim marked **ours** was checked against a physical NAS over a
QuickConnect relay; `docs/VERIFIED.md` records what was run and what it
returned. `tools/probe.mjs` repeats those checks against your own NAS.

---

## Transport

### Two endpoints, and which one answers is not a constant

| API family | Documented endpoint | Also seen serving |
|---|---|---|
| `SYNO.API.*`, `SYNO.DSM.*` | `/webapi/entry.cgi` | — |
| `SYNO.NoteStation.*` | `/notestation/webapi/entry.cgi` | `/webapi/entry.cgi` |

Captured traffic from the stock client uses the **package-local** path, and
posting these APIs to the core endpoint is reported to fail. That is not the
whole story. Verified live on a Synology NAS (DSM 7.1.x) reached over
a QuickConnect relay: the package-local path answered with an **HTML page**,
while the same APIs answered correctly on `/webapi/entry.cgi`. The relay is a
reverse proxy, not a transparent tunnel, and it does not forward package-local
paths.

So the client does not pick a side. It tries the documented path first, falls
back to the core path when the answer is HTML (or `102`, "API does not exist"),
and remembers which one worked for the rest of the session. `dsnote_status`
reports the result as `apiPath: "package" | "core"`. **capture + ours**

### TLS through a QuickConnect relay — corrected

The relay is a TCP tunnel to the DSM port, not a TLS-terminating proxy. It
looked otherwise at first: without SNI, DSM answers with its **default**
certificate, which on most NAS boxes is self-signed, so the connection appeared
unverifiable. Send the certificate's own name as SNI and the NAS serves the
certificate issued for that name — a relay route then verifies exactly like a
direct one. **ours**, verified live.

### Param encoding — the trap

Every `SYNO.NoteStation.*` API declares `requestFormat: JSON`, which changes
how a value is form-encoded:

| JS type | On the wire | Example |
|---|---|---|
| string | JSON-quoted | `title="New note"` |
| number | bare | `duration=120` |
| boolean | bare | `recycle=true` |
| array / object | JSON-encoded | `tag=["A","B"]`, `filter={"recycle":false}` |
| `null` / `undefined` | omitted entirely | — |

The envelope is the exception inside the same call: `api`, `version`, `method`
and `_sid` stay plain form fields even for a `requestFormat: JSON` API. Only
the API's own parameters are quoted. **capture + ours** — the fake NAS rejects
a quoted envelope, because a tolerant test double would let that mistake ship.

`SYNO.API.Auth` is the exception: it has no `requestFormat` and takes bare
form fields (`account=alice`, not `account="alice"`). **capture**

Implemented in `core/encoding.mjs`, pinned by `tests/encoding.test.mjs`.

### Authentication and CSRF

1. `SYNO.API.Auth` v7 `login` with `session=NoteStation`,
   `enable_syno_token=yes` returns `sid` **and** `synotoken`.
2. `sid` rides as `_sid` on every call.
3. `synotoken` rides as the `X-SYNO-TOKEN` header on every POST. Without it,
   reads may still work on some configurations and writes fail with 105/119.
   **capture**

Full detail, including the portal/relay flavour and two-factor:
[docs/AUTH.md](AUTH.md).

### Response envelope

```json
{ "success": true,  "data": { … } }
{ "success": false, "error": { "code": 119 } }
```

Only a handful of codes are documented anywhere; `core/errors.mjs` maps those
and reports the rest as "undocumented code N" rather than inventing a meaning.

### Identifiers and time

- `object_id` is `<volumeId>_<ULID>`, e.g. `1001_QF644RE9V50IT7EO6BU21NUFRG`.
  The parameter name is `object_id` everywhere — not `note_id` or `notebook_id`.
- Timestamps are epoch **seconds**.
- `ver` is a sha1 of the note content revision. It is the concurrency handle:
  `Note.set` refuses a write whose `ver` is stale.

---

## Version pinning

The server advertises a `maxVersion` per API, and taking it is a bug:
`SYNO.NoteStation.Note` advertises up to **4**, but `list` at v4 takes a
different parameter shape than the v3 that every capture shows. This project
pins a version per `(api, method)` in `core/client.mjs` → `PINNED_VERSIONS`,
and uses discovery only to confirm the API exists.

| API | list | create | set/update | delete | other |
|---|---|---|---|---|---|
| Notebook | 2 | 2 | 2 | 2 | — |
| Note | 3 | 3 | 3 | 3 | `get` 3, `restore` 3, `copy` 3 |
| Tag | 2 | 2 | — | — | — |
| Todo | 2 | 2 | 2 | **1** | delete is v1 while everything else is v2 |
| FTS | — | — | — | — | `search` 1 |
| Note.Version | 2 | — | — | — | `restore` 2 |
| Info | — | — | — | — | `get` 2 |

---

## Notes

### `list` — v3

```
api=SYNO.NoteStation.Note&version=3&method=list
&filter={"recycle":false,"archive":false,"parent_id":"<optional>"}
&field={"link_id":true,"commit_msg":true}
&offset=0&limit=50&sort_by="mtime"&sort_direction="desc"
```

`Note.list` returns **neither `content` nor `tag`**. Tag membership for a list
of notes can only be derived by inverting `Tag.list` (each tag carries the note
ids that have it). **capture**

### `get` — v3

```
&method=get&object_id="<id>"   [&ver="<sha1>" for a historical revision]
```

The note object is directly under `data`, not `data.note`. Includes `content`
and `tag`. **capture**

### `create` — v3, and it is only half the job

```
&method=create
&commit_msg={"device":"desktop","listable":false}
&title="Untitled Note"&parent_id="<notebook id>"&encrypt=false
```

Creates an **empty** note and returns it with a fresh `ver`. The stock client
then applies the body with a follow-up `set`. Creating and stopping there
leaves an empty note in the user's notebook. **capture**

### `set` — v3, this is "update"

```
&method=set
&commit_msg={"device":"desktop"}
&object_id="<id>"&ver="<current sha1>"&check_conflict=true
&title="…"&content="<html>"&brief="<plain text>"&tag=["Name"]&is_starred=true
```

- `ver` is **required**; a mismatch is refused.
- The response is a **partial** object under `data.data[0]` carrying the new
  `ver`/`mtime` — not the full note.
- `tag` takes tag **names**, not the `Name@uid` composite that `Tag.list`
  returns. **capture**
- `parent_id` moves the note to another notebook. Verified live. **ours**
- `is_starred` (and `star`) are accepted without error but do **not** change
  the note: a write carrying either left `starred` false and the note's `ver`
  untouched. Starring is not exposed as a tool for that reason. **ours**

**ours** — the server's conflict code is not documented anywhere, so
`core/notes.mjs` does not pattern-match on a number. On failure it re-reads the
note and compares `ver`: if it moved, that is a proven conflict
(`NoteConflictError`); if it did not, the original error is rethrown unchanged.

### `delete` / `restore` — v3

```
&method=delete&object_id=["<id>"]&recycle=true     → move to recycle bin
&method=delete&object_id=["<id>"]&recycle=false    → permanent purge (only on an already-trashed note)
&method=restore&object_id=["<id>"]                 → back to its original notebook
```

`object_id` is a JSON **array** even for one note. The same method means
"trash" or "destroy" depending on `recycle`, which is exactly why
`core/notes.mjs` exposes them as two functions and gates `purge` behind
`allowPurge`. **capture**

### `copy` — v3

Duplicates a note with transforms; also the mechanism the stock client uses to
encrypt a note (encrypt client-side, submit the ciphertext via `copy`). Not
implemented here yet.

---

## Notebooks, tags, to-dos, search, versions

### Notebook — v2

`list` → `data.notebooks[]` with `items` as an ordered array of note ids (so
the note count is `items.length`, there is no `note_count` field).
`create` takes `title` (+ optional `stack_id`); `update` and `delete` address
by `object_id`. **capture**

### Tag — v2

`list` → `data.tags[]`, each `{tag_id: "Name@uid", title, items: [note ids]}`.
`create` takes `name`. Asymmetry to remember: **reads use `Name@uid`, writes
use the plain name.** **capture**

### Todo — v2 for list/create/set, v1 for delete

`list` supports `field={"items":true}` and filters by `parent_id` / `note_id`.
A parent's `items` is an array of subtask **ids**, not nested objects.
`priority: -1` and `due_date: -1` mean "unset"; only `priority=300` has ever
been captured, so the bucket boundaries are unknown. **capture**

### FTS — v1

`&method=search&keyword="…"&offset=0&limit=50`

The results are under **`data.matches`**, not `data.notes` — the write-up this
project started from said `notes`, and reading that key silently returned zero
results for every query. Verified live:

```json
{"data":{"matches":[{ "object_id":"1026_…","title":"API","brief":"…","mtime":…,"tag":[],… }],"offset":0},"success":true}
```

Each match is a full note object minus `content`. Diacritics work
("prečiarknuté" matched). Not notebook-scoped; narrow client-side.
**capture + ours**

### Note.Version — v2

`list` → `data.versions[]`. Counter-intuitive detail: the **lowest `id` is the
current content** and `id` increases going further back in time.
`restore` puts a note back to a given `ver`, in place. This is the undo an
agent needs after a bad edit. **capture**

---

## Stored note bodies

### HTML vocabulary

A note's `content` is HTML. Note Station's editor round-trips only a known
subset; anything outside it can be stripped the next time the stock app opens
the note. The subset, from a real "format everything, save, reload" capture:

```
blocks    <div>  (what saved notes actually use)  <p>
headings  <h1>…<h6>
inline    <b> <i> <u> <sup> <sub> <span style>  <br>
lists     <ol> <ul> <li>
checkbox  <input class="syno-notestation-editor-checkbox" type="image" src="…">
          checked adds  " syno-notestation-editor-checkbox-checked"
table     <table> <tbody> <tr> <td>
misc      <hr>  <a href>  <img class="syno-notestation-image-object" ref>
styles    font-family, color, background-color, text-decoration,
          width, height, text-align, font-size
```

Deliberately **not** emitted by this project: `<pre>`, `<code>`, `<blockquote>`,
`<strong>`, `<em>` — Markdown code and quotes are rendered with allowed
constructs instead so the note stays editable in the stock app.

`core/html.mjs` implements Markdown ⇄ this vocabulary, plus `checkRoundTrip()`
so a body can be checked before it is written.

### `brief`

A plain-text preview the stock client sends alongside `content` and shows in
the note list. `deriveBrief()` produces it from the HTML. For an **encrypted**
note the brief stays plaintext even though the content does not — never treat
it as a safe preview.

### Encryption

Notes can be encrypted client-side: `content` becomes a base64
`Salted__` envelope (AES-256-CBC, PKCS#7, OpenSSL `EVP_BytesToKey` with MD5,
plaintext prefixed with `NoTeStAtIoNMaGic`). There is no server-side decrypt.
This project reads `encrypt` and refuses to render or rewrite such a note;
implementing the crypto is a later, separate decision.

---

## Sharing, export, and the rest

Captured but not implemented here: `Share.Priv` (user/group autocomplete),
`Shard.Link` (public share URL), `Permission*` (per-note sharing),
`Export.Notebook` / `Import.Notebook` (server-side async `.nsx` jobs),
`Smart` (saved-search notebooks), `Stack` (shelves), `Shortcut` (sidebar).

The `.nsx` export format is a plain ZIP with `config.json` plus one JSON entry
per object named by its `object_id`, and `file[_enc]_<noteid>_<md5>`
attachments. Useful as a backup path; not a live channel for an agent.

---

## Open questions

1. ~~Does the QuickConnect portal forward the package-local
   `/notestation/webapi/entry.cgi` path?~~ **Answered live: no.** The relay
   answers HTML there and the APIs are served on `/webapi/entry.cgi`. Whether
   the portal behaves the same as the relay is still untested, but the client's
   fallback covers both.
2. The exact error code for a `ver` conflict. We do not need it (we re-read and
   compare), but knowing it would make the error message nicer.
3. `Todo.priority` bucket boundaries — only `300` observed.
4. Whether `Note.create` accepts `content` directly on some DSM versions. The
   captured client does not do it, so neither do we.
5. `Note.Polling` / `Notebook.Polling` — the incremental sync the stock client
   presumably uses. Not captured; would matter for a local mirror, which this
   project does not have.
6. **Tags are lost when a note is trashed and restored.** Verified live: a
   note created with a tag came back from the recycle bin with an empty tag
   list, and the tag object itself disappeared from `Tag.list` because no note
   carried it any more. The stock client presumably re-applies tags on restore;
   this project does not yet.
