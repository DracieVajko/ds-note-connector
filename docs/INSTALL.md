# Install

Three routes to the same core. Pick the one that matches the agent you use.

| Route | For | What you get |
|---|---|---|
| **Cindy plugin** | Cindy | Panel, settings page, bundled skill, agent tools |
| **MCP server** | Claude Code, Codex CLI, Cursor, Windsurf, Cline, Zed, Gemini CLI, Cindy | Agent tools over stdio |
| **Library** | your own code | `import { createNoteStation } from './core/index.mjs'` |

All three need the same four things: a NAS with **Note Station** installed, a
DSM account that can reach it, the NAS's address (or QuickConnect ID), and the
account's password.

Use a **dedicated DSM user whose only permission is Note Station**. Not an
admin account.

---

## 1. Cindy plugin

The plugin lives in `plugin/`. Pack and install it with Cindy's plugin tooling
(`ghost_forge_pack` then `ghost_forge_install`), or import the built
`plugin/ds-note-*.cindy`.

Then, in the plugin's settings:

1. **Connection** — `Auto` is the one to pick: list the addresses you have (LAN,
   Tailscale/VPN, DDNS) one per line and give a QuickConnect ID as the fallback.
   It uses the first that answers with a valid certificate. `Direct` and
   `QuickConnect ID` remain for pinning it to one route.
2. **Port** — `5001` (HTTPS) or `5000` (HTTP).
   Certificate verification is on by default. If the NAS uses a self-signed
   certificate the connection will fail with an explanation; tick **accept a
   self-signed certificate** only then, and read the warning it shows — the
   password goes to an address whose identity is no longer checked. A hostname
   with a real certificate avoids the trade-off.
3. **DSM account**.
4. **Save password** — it goes to Cindy's vault, never to the plugin's config.
5. **Save & test** — prints the DSM version, the route it used and the note
   count, or the exact error.
6. Recommended: export the NAS certificate from DSM and point **Certificate
   file exported from DSM** at it. The connection is then verified against that
   certificate with normal verification on. If exporting is inconvenient, copy
   the fingerprint the panel shows into the field next to it instead.

The password is handed only to this plugin's local worker, and only for the one
method that talks to the NAS. The panel never sees it, and neither does the
model.

## 2. MCP server

Zero dependencies, Node 18+. Full client configuration:
[variants/mcp/README.md](../variants/mcp/README.md).

```bash
# Claude Code
claude mcp add ds-note \
  -e DS_NOTE_HOST=192.168.1.10 \
  -e DS_NOTE_ACCOUNT=dsnotes \
  -e DS_NOTE_PASSWORD=… \
  -- node /absolute/path/to/ds-note-connector/variants/mcp/server.mjs
```

```toml
# Codex CLI — ~/.codex/config.toml
[mcp_servers.ds-note]
command = "node"
args = ["/absolute/path/to/ds-note-connector/variants/mcp/server.mjs"]
env = { DS_NOTE_HOST = "192.168.1.10", DS_NOTE_ACCOUNT = "dsnotes", DS_NOTE_PASSWORD = "…" }
```

Over QuickConnect instead of a LAN address, drop the host/port and set
`DS_NOTE_QUICKCONNECT=mynas`.

**Note on where the password lives here.** An MCP client stores its server
environment in that client's own configuration file, in plain text, on your
machine. That is the client's storage, not this project's. If you would rather
not have it there, use the Cindy plugin (vault) or export `DS_NOTE_PASSWORD`
in the shell that starts the server.

## 3. Library

```js
import { createNoteStation } from './core/index.mjs';

const api = await createNoteStation({
  mode: 'quickconnect',
  quickConnectId: 'mynas',
  account: 'dsnotes',
  password: process.env.DS_NOTE_PASSWORD,
});

const [notebook] = await api.notebooks.list();
await api.notes.create({ title: 'Hello', notebookId: notebook.id, markdown: '- [ ] first' });
await api.close();
```

---

## Check it before trusting it

```bash
npm test                        # 67 checks, no dependencies
node tools/probe.mjs --host 192.168.1.10 --account dsnotes
node tools/probe.mjs --quickconnect mynas --account dsnotes --write
```

The probe is read-only unless you pass `--write`, and even then it only creates
its own note and moves it to the recycle bin. It reports what your NAS actually
returned, which is the only claim worth making about an undocumented API.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `not configured` | settings were not saved, or the account field is empty |
| `No DSM password is stored` | the password was never saved (it is separate from the rest) |
| `HTML page instead of JSON` | wrong endpoint — the client now falls back, but this can also mean a portal session that needs repairing |
| `code 105` on writes | missing CSRF token. Check that the DSM accepted `enable_syno_token=yes` |
| `code 119` | the session was never opened for `NoteStation`, or it expired |
| `code 400` at login | wrong account or password |
| `code 403` / `404` at login | two-factor required / wrong code |
| TLS error | self-signed certificate. The error says so and names the setting. Turning it on skips identity verification, so prefer a hostname with a real certificate. A certificate file validates the chain but does not check the hostname — `dsnote_status` says so in `certificate.scope` |
| A note loses its tags after a restore | Note Station drops tags on trash; re-apply them (the skill says so) |
