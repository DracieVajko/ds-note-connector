# DS Note

Synology Note Station on your own NAS, for Cindy.

Search and read your notes, write new ones from Markdown, append to existing
ones, manage notebooks, tags and the task list, and undo a bad edit from a
note's version history.

## What it needs

- A Synology NAS with **Note Station** installed (DSM 7.x).
- A DSM account that can reach Note Station. Use a dedicated user whose only
  permission is Note Station — not an admin account.
- The NAS reachable from this computer: a LAN address, a DDNS name, a VPN, or a
  QuickConnect ID.

The DSM password is stored by Cindy in its vault. It is handed only to this
plugin's bundled local worker, which is the only part that talks to the NAS.
It has to reach that worker at login — DSM has no OAuth, API key or
app-specific password for third-party clients — so the useful hardening is
around it: a dedicated account, a password used nowhere else, two-factor, a
pinned certificate, and a VPN instead of a QuickConnect relay.

## Why there is a local worker

Synology NAS boxes almost always serve a **self-signed certificate**, and a
QuickConnect relay route is an IP address that no certificate covers. Cindy's
host network proxy refuses both, so the plugin ships a small Node worker that
uses `node:https` directly and can accept them explicitly. That worker is the
same core the plugin's MCP server and CLI use, so the behaviour is identical
whichever way you reach it.

## Setup

1. Open the plugin's settings.
2. Pick the connection:
   - **Auto** — list every address you have (LAN, Tailscale/VPN, DDNS), one per
     line, plus a QuickConnect ID as the fallback. Each is probed with real
     certificate verification and the first that answers wins, so the same
     settings work at home and away.
   - **Direct** — NAS address and port (`5001` for HTTPS, `5000` for HTTP).
     Certificate verification is on by default. A self-signed certificate fails
     until you either export it from DSM and point **Certificate file exported
     from DSM** at it (best: real chain verification against that one
     certificate), or tick **accept a self-signed certificate** — which the page
     warns about, because the NAS's identity is then not verified at all.
   - **QuickConnect ID** — just the ID; the plugin finds the best route.
3. Enter the DSM account and save the password.
4. Open the panel; it shows the endpoint it used and how many notebooks and
   notes it found.

If the panel says "not configured", the settings were not saved yet. If it says
"no CSRF token", the DSM refused the token that writes require — check that the
account can open Note Station in a browser.

## The panel

- **Search** across titles and bodies; pick a notebook to narrow it.
- Click a note to read it, with its tags and revision.
- **New note** writes Markdown into the notebook you pick.
- Encrypted notes show a notice instead of a body. That is deliberate.

## The tools an agent gets

`dsnote_status` · `dsnote_notebooks` · `dsnote_search` · `dsnote_list_notes` ·
`dsnote_get_note` · `dsnote_create_note` · `dsnote_update_note` ·
`dsnote_append_note` · `dsnote_trash_note` · `dsnote_restore_note` ·
`dsnote_tags` · `dsnote_todos` · `dsnote_versions` · `dsnote_raw` (only when
enabled in settings)

## What it will not do

- **Permanently delete a note.** Delete means the recycle bin; emptying the bin
  stays in DSM. The optional raw debug tool refuses that call too, so there is
  no path from an agent to an unrecoverable deletion.
- **Overwrite an edit made elsewhere.** A write carries the version it read; if
  the note changed in between, the call reports a conflict and nothing is
  overwritten.
- **Read or rewrite an encrypted note.**
- **Guess which note you meant.** Ids come from a search or a list.

## Markdown

Note Station stores HTML, not Markdown. Headings, bold, italic, lists, links,
tables, dividers and checkboxes are converted to the subset Note Station's own
editor preserves, so a note stays editable in the phone app afterwards. Code
blocks and quotes are rendered with allowed constructs instead of `<pre>` and
`<blockquote>`, which the stock editor can strip.
