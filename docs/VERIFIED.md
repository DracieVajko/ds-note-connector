# Verified behaviour

What has actually been exercised, and what is still taken on someone else's
word. This file is the honest ledger; `docs/API.md` is the reference.

## Live NAS — two sessions, all writes on our own notes

One NAS, one account, exercised through the installed Cindy plugin. **No user
note was read for content, modified, moved or deleted.** Everything below was
done to notes this project created, in notebooks this project created.

| | |
|---|---|
| NAS | a Synology NAS, DSM 7.1.x |
| Route | QuickConnect **relay** (no direct route answered from the client machine) |
| Scale | a small account: one notebook, a few dozen notes |

### The matrix

| Check | Result |
|---|---|
| Login over the relay, `sid` + `synotoken` + device token | pass |
| API discovery | pass, 34 `SYNO.NoteStation.*` APIs advertised |
| **Package-local path** `/notestation/webapi/entry.cgi` | **fail — returns an HTML page over the relay** |
| **Core path** `/webapi/entry.cgi` for NoteStation APIs | **pass** — this is what the NAS serves |
| `Notebook.list` / `Notebook.create` | pass |
| `Note.list` | pass; confirmed it omits `content` and `tag` |
| `Note.get` | pass |
| **Formatting round-trip** | headings, bold, italic, strikethrough, inline code, bullets, ordered lists, checklists, blockquote, divider, table, code fence, link — all preserved |
| **Image upload** (multipart `Note.set`) | pass, 21 970-byte PNG stored, `attachment` map populated |
| `Note.create` + `Note.set` | pass |
| `Note.set` with `parent_id` (move) | **pass** — the note changed notebook |
| `Note.set` with `is_starred` / `star` | **silently does nothing** — accepted, no change |
| `append` (heading + body) | pass, existing body untouched |
| `Tag` on write (3 tags) | pass |
| `Note.Version.list` | pass, 3 revisions with authors and timestamps |
| `Note.Version.restore` | pass — body **and** the tags of that revision came back |
| `Note.delete` `recycle=true` | pass |
| `Note.list` with `filter.recycle=true` | pass, the note appears with `parent_id: "<volume>_#00000000"` |
| `Note.restore` | pass, back in its notebook with its body intact |
| `FTS.search` | pass **after a fix** — results live under `data.matches`, not `data.notes` |

### Findings that changed the code

1. **The relay does not serve the package-local path.** The documented endpoint
   answered with HTML; `/webapi/entry.cgi` answered correctly. The client now
   tries the documented path, falls back on HTML or `102`, and remembers the
   winner. `dsnote_status` reports `apiPath`.
2. **The envelope must stay plain.** `api`, `version`, `method` and `_sid` are
   bare form fields even for `requestFormat: JSON` APIs; only the API's own
   parameters are JSON literals. The fake NAS now rejects a quoted envelope.
3. **`FTS.search` returns `data.matches`.** Reading `data.notes` returned zero
   results for every query, on every note — including notes that clearly
   matched. This was the difference between a working search tool and a
   plausible-looking broken one.
4. **Multipart needs the session in the query string too.** With only the
   `X-SYNO-TOKEN` header, the upload failed with `105` while the same session
   wrote notes fine. Adding `_sid` + `SynoToken` to the query string fixed it.
5. **Starring is not reachable.** `is_starred` and `star` are accepted and
   ignored. The parameter was removed rather than shipped as a switch that
   lies.
6. **Trash + restore loses tags.** A tagged note came back from the recycle bin
   with `tags: []`, and the tag object disappeared from `Tag.list` once no note
   carried it. Restoring a *revision* does restore that revision's tags.
7. **`Note.list` marks trashed notes with `parent_id: "<volume>_#00000000"`**, a
   pseudo-notebook, not a real one.

### Still unverified on a live NAS

- A `ver` conflict (needs two writers racing on purpose).
- `Todo` create / set / delete.
- QuickConnect **portal** mode (only the relay route was used).
- A direct LAN route, and a hostname with a real certificate.
- Encrypted notes, sharing, smart notebooks, `.nsx` export.
- Behaviour on DSM 7.2 and on a NAS where the package-local path *does* work.

## Verified without a NAS

Everything below runs against `tools/fake-nas.mjs`, which is built from the
captured traffic in `docs/API.md` and fails the same way a real NAS does.

| Area | Result |
|---|---|
| JSON-literal param encoding, plain envelope | pass |
| `null` omitted, spaces as `%20` | pass |
| Login (direct flavour), error 400 at login | pass |
| 2FA: 403 → OTP → device token reuse | pass |
| Portal flavour: cookie bootstrap + `entry.cgi` POST | pass |
| HTML-instead-of-JSON detected as a portal problem | pass |
| Endpoint fallback to the core path, and remembering it | pass |
| QuickConnect candidate ordering, `ezid` = MD5(serverID) | pass |
| Relay route forces `allowSelfSigned` | pass |
| Stale `ver` refused (`NoteConflictError`), no silent overwrite | pass |
| Trash → restore, purge gated behind `allowPurge` | pass |
| Todo create/set/delete with pinned versions | pass |
| Version list + restore as undo | pass |
| Write without CSRF token refused | pass |
| MCP `initialize` / `tools/list` / `tools/call` | pass |
| MCP tool failure returns `isError` | pass |
| MCP unconfigured server explains what is missing | pass |
| `dsnote_raw` only with `DS_NOTE_ALLOW_RAW` | pass |
| Plugin manifest validates, packs and installs | pass |
| Manifest tools match the runtime catalog | pass |
| Vendored `plugin/node/core` matches `core/` | pass |
| Skill frontmatter matches the manifest | pass |
| Password goes to `/secrets`, never `/kv` | pass |
| Panel and settings keep scripts external (CSP) | pass |
| Redaction: password and QuickConnect ID never leave the worker | pass |
| Redaction: note bodies are never rewritten | pass |
| Certificate pinning: correct fingerprint accepted, wrong one refused **before the request is sent** | pass, against a real TLS server |
| A pin alone accepts a self-signed certificate (no "accept anything" flag needed) | pass |
| A supplied certificate: chain verified, hostname mismatch tolerated, a different certificate refused | pass |

Test command: `npm test` (67 checks, no dependencies).

## What the plugin still has not proven

Packing and installing prove the manifest, the layout and the package. The
worker was exercised live, so its transport, session handling and tool dispatch
are real. Not yet proven: the panel rendering in a real sidebar, the settings
page in Cindy's settings surface, and the setup card for the password. Those
are UI paths, and they are the next thing to look at by hand.
