# DS Note Connector

A bridge between AI agents and **Synology Note Station** — notes, notebooks,
tags, tasks, search and version history on your own NAS, through one core and
several thin adapters.

## Why this is not "just another MCP server"

Synology never published the Note Station API. It is reverse-engineered, and
three things about it bite anyone who treats it like a normal REST service:

- **Two endpoints.** `SYNO.NoteStation.*` lives at
  `/notestation/webapi/entry.cgi`; calling it on the core endpoint fails.
- **JSON-literal parameters.** These APIs take `title="New note"`, not
  `title=New note`. Naive form encoding fails quietly.
- **Writes need a version.** A note edit carries `ver=<sha1>` and
  `check_conflict=true`. Skip it and the server refuses; ignore the conflict
  and you overwrite what someone typed on their phone.

So the core is built around evidence: pinned API versions per method, a
re-read-and-compare conflict check instead of a guessed error code, and a
verification probe that proves the whole thing against a real NAS.

## What exists today

| Part | State |
|---|---|
| `core/` — endpoint resolution, auth, transport, notes, notebooks, tags, todos, search, versions, Markdown ⇄ Note Station HTML | working |
| `core/tools.mjs` — the agent-facing tool catalog, shared by every adapter | working |
| `variants/mcp/` — MCP stdio server (Claude Code, Codex, Cursor, Cindy, …) | working |
| `plugin/` — native Cindy plugin: panel, settings, bundled skill, local worker | working, verified live |
| `tests/fake-nas.mjs` — a NAS that fails the same way the real one does | working |
| `tools/probe.mjs` — the standalone live check you can run yourself | ready; the live results in `docs/VERIFIED.md` came from the plugin's tools instead |

98 tests, no dependencies (`npm test`).

Verified live on a Synology NAS over a QuickConnect relay: login, notebooks, note
CRUD, move, tags, version history and restore, trash and restore, image upload
and search. See [docs/VERIFIED.md](docs/VERIFIED.md) for the exact ledger,
including what is still unverified.

## Layout

```
core/
  endpoint.mjs      direct | quickconnect | portal, and the login flavour each implies
  quickconnect.mjs  Serv.php → candidates → ping-pong/ezid → relay tunnel
  auth.mjs          both login flavours, 2FA, trusted-device token
  client.mjs        entry.cgi transport, pinned versions, session retry
  notes.mjs         list/get/create/set/append/trash/restore/purge
  resources.mjs     notebooks, tags, todos, search, versions
  tools.mjs         the tool catalog every adapter exposes
  html.mjs          Markdown ⇄ the HTML subset Note Station preserves
  encoding.mjs      the JSON-literal wire encoding
  errors.mjs        the few codes that are documented, and nothing invented
  http.mjs          node:https + a cookie jar scoped to one origin
  tls.mjs           the certificate modes and transport options
  redact.mjs        keeps credentials out of logs and tool output
  version.mjs       the one version constant
variants/mcp/
  server.mjs        MCP stdio server
  README.md         client configuration for each harness
plugin/             the native Cindy plugin (packed into plugin/ds-note-0.1.11.cindy)
  ghost.json        manifest; the `tools` array is generated, never hand-edited
  main.js           sandbox brain: config, worker calls, panel channel
  node/worker.cjs   the only part that talks to the NAS (node:https, self-signed ok)
  node/core/        vendored copy of core/, kept in sync by tools/sync-core.mjs
  panel.*           browse, search, read, create
  settings.*        connection mode, account, password → /secrets
  skills/ds-note/   the skill the agent reads
tools/
  probe.mjs         live verification
  sync-core.mjs     vendor core/ into the plugin package
  gen-manifest.mjs  generate ghost.json tools from the catalog
docs/
  API.md            the API, with a trust level per claim
  AUTH.md           connection modes, login, 2FA, failure modes
  VERIFIED.md       what has actually been exercised
tests/              98 tests, node:test, no dependencies
  fake-nas.mjs      a faithful test double (also runs standalone)
```

## Run it

```bash
npm test                 # 98 tests, no install needed
node tests/fake-nas.mjs  # a fake NAS on :8088
```

## The Cindy plugin

`plugin/` is a complete plugin: a panel to browse, search, read and create
notes; a settings page; a bundled skill; and a local Node worker that is the
only part talking to the NAS — because a Synology certificate is usually
self-signed and a QuickConnect relay route is an IP no certificate covers, and
Cindy's host proxy refuses both.

```bash
node tools/sync-core.mjs     # vendor core/ into the package
node tools/gen-manifest.mjs  # regenerate ghost.json tools from the catalog
```

Then pack `plugin/` with Cindy's plugin tooling. The manifest, the vendored
core and the skill frontmatter are all checked by `npm test`, so they cannot
drift apart silently.

```js
import { createNoteStation } from './core/index.mjs';

const api = await createNoteStation({
  mode: 'direct', host: '192.168.1.10', port: 5001,
  account: 'dsnotes', password: process.env.DS_NOTE_PASSWORD,
});

const [notebook] = await api.notebooks.list();
await api.notes.create({
  title: 'Electrical check',
  notebookId: notebook.id,
  tags: ['Work'],
  markdown: '# Hall\n\n- [ ] socket 1\n- [x] socket 2',
});

const hits = await api.search.search('socket');
console.log(hits.notes);
await api.close();
```

## Safety model

- **Delete is trash.** Permanent removal is a separate function, disabled
  unless `allowPurge` is set, and the two are never the same intent. The raw
  debug tool refuses `Note.delete` with `recycle=false` and refuses notebook
  deletion, so no tool can destroy a note unrecoverably.
- **Every write is version-checked.** A stale edit raises
  `NoteConflictError` instead of overwriting.
- **Version history is the undo.** `versions.restore()` puts a note back to a
  revision, in place.
- **Encrypted notes are read-only.** No rendering, no rewriting.
- **Certificates are verified by default.** Skipping verification is an explicit
  setting, and the page warns that the DSM password could then be read by
  anything answering on that address.
- **Nothing is written to a real NAS by a test.** The probe's write path is
  opt-in and only ever trashes its own note.

## Docs

- [docs/INSTALL.md](docs/INSTALL.md) — the three routes, and troubleshooting
- [docs/API.md](docs/API.md) — the API, with a trust level per claim
- [docs/AUTH.md](docs/AUTH.md) — connection modes, login, 2FA
- [docs/VERIFIED.md](docs/VERIFIED.md) — what has actually been exercised
- [variants/mcp/README.md](variants/mcp/README.md) — wiring it into an MCP client
