# MCP stdio server

One file, no dependencies, newline-delimited JSON-RPC 2.0 on stdin/stdout.
Works with any MCP client: Claude Code, Codex CLI, Cursor, Windsurf, Cline,
Zed, Gemini CLI, Cindy, or your own.

It is a thin adapter over `../../core` — all behaviour, safety and API quirks
live there.

## Configure

Everything is environment variables (or `--config path/to/config.json` for a
JSON file with the same keys).

| Variable | Meaning |
|---|---|
| `DS_NOTE_ACCOUNT` | DSM user. Use a dedicated account whose only access is Note Station |
| `DS_NOTE_PASSWORD` | Its password |
| `DS_NOTE_HOST` | NAS hostname or IP (direct mode) |
| `DS_NOTE_PORT` | DSM port, default `5001` |
| `DS_NOTE_HTTPS` | `true` (default) or `false` |
| `DS_NOTE_URL` | Alternative to host/port, e.g. `https://nas.example.com:5001` |
| `DS_NOTE_QUICKCONNECT` | QuickConnect ID — use instead of host/port when the NAS is not directly reachable |
| `DS_NOTE_INSECURE` | `1` to accept a self-signed certificate. Off by default, including for a bare IP; set it explicitly |
| `DS_NOTE_OTP` | Two-factor code, when the account has no trusted device yet |
| `DS_NOTE_DEVICE_ID` | A previously issued device token, so the OTP is not asked again |
| `DS_NOTE_TIMEOUT` | Request timeout in ms, default `20000` |
| `DS_NOTE_ALLOW_PURGE` | `1` enables `purge()` for code that embeds `core/`; no tool exposes permanent deletion, so it grants nothing to an agent call |
| `DS_NOTE_ALLOW_RAW` | `1` to expose the `dsnote_raw` debug tool. Off by default |

Precedence: `--config` file, then the environment. Nothing is read from the
repository, and no credential is ever logged.

## Register it

**Claude Code**

```bash
claude mcp add ds-note \
  -e DS_NOTE_HOST=192.168.1.10 \
  -e DS_NOTE_ACCOUNT=dsnotes \
  -e DS_NOTE_PASSWORD=… \
  -- node /absolute/path/to/ds-note-connector/variants/mcp/server.mjs
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.ds-note]
command = "node"
args = ["/absolute/path/to/ds-note-connector/variants/mcp/server.mjs"]
env = { DS_NOTE_HOST = "192.168.1.10", DS_NOTE_ACCOUNT = "dsnotes", DS_NOTE_PASSWORD = "…" }
```

**Cursor** (`.cursor/mcp.json`) and most JSON-configured clients

```json
{
  "mcpServers": {
    "ds-note": {
      "command": "node",
      "args": ["/absolute/path/to/ds-note-connector/variants/mcp/server.mjs"],
      "env": {
        "DS_NOTE_HOST": "192.168.1.10",
        "DS_NOTE_ACCOUNT": "dsnotes",
        "DS_NOTE_PASSWORD": "…"
      }
    }
  }
}
```

**Cindy** — add it as an MCP server in Cindy's settings with the same command
and environment. A native Cindy plugin (panel, settings page, no MCP needed) is
the next adapter in this repository.

**QuickConnect instead of a LAN address**

```
DS_NOTE_QUICKCONNECT=mynas
```

The server asks Synology's coordinator for the NAS's routes, probes them, and
prefers a direct route over the relay. See [docs/AUTH.md](../../docs/AUTH.md).

## Tools

| Tool | What it is for |
|---|---|
| `dsnote_status` | Endpoint, session, CSRF token, DSM version, counts. Call it first when something failed |
| `dsnote_notebooks` | List notebooks, create one, rename one |
| `dsnote_search` | Full-text search; the normal way to find a note |
| `dsnote_list_notes` | List a notebook, or the recycle bin |
| `dsnote_get_note` | One note as Markdown, with its version |
| `dsnote_create_note` | Create from Markdown in a specific notebook |
| `dsnote_update_note` | Replace body/title/tags, version-checked |
| `dsnote_append_note` | Add to the end without touching what is there |
| `dsnote_trash_note` | Move to the recycle bin (soft) |
| `dsnote_restore_note` | Bring it back |
| `dsnote_tags` | Tags, or one note's tags |
| `dsnote_todos` | The task list: list/create/update/complete/delete |
| `dsnote_versions` | Revision history, and restore as an undo |
| `dsnote_raw` | Undocumented API call, only when `DS_NOTE_ALLOW_RAW=1` |

## What it will not do

- Permanently delete anything: no tool exposes `purge`. `DS_NOTE_ALLOW_PURGE` only unlocks the core API for an embedding program.
- Overwrite a note edited elsewhere: the write carries the version it read, and
  a mismatch comes back as a conflict instead of a silent loss.
- Read or rewrite an encrypted note.
- Guess a note id from a title.

## Try it without a NAS

```bash
node tools/fake-nas.mjs 8088     # in one terminal

DS_NOTE_HOST=127.0.0.1 DS_NOTE_PORT=8088 DS_NOTE_HTTPS=false \
DS_NOTE_ACCOUNT=tester DS_NOTE_PASSWORD=secret \
node variants/mcp/server.mjs
```

Then paste this line into its stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}
```
