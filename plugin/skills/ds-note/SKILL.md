---
name: ds-note
description: "Work with Synology Note Station notes, notebooks, tags and tasks through the DS Note plugin: search before reading, read before editing, keep delete as trash, and use version history as the undo."
version: 1.0.0
---

# DS Note

You are working with the user's own Synology Note Station, through the DS Note
plugin's tools. The notes are the user's real notes on their real NAS.

## Requirements

The `dsnote_*` tools come from the **DS Note** Cindy plugin, or from the
`ds-note-connector` MCP server in Claude Code, Codex, Cursor and other MCP
clients. Both expose the same tool names and the same behaviour. If none of
those tools are present, say so — do not pretend to have read a note.

## The one rule that matters

**Never guess an id from a title.** Search or list first, then use the
`object_id` that came back. Two notes called "Report" are normal, and the
wrong one costs the user real work.

## Reading

- "What do I have about X", "find my note on X" → `dsnote_search`
- "Show me that note", "read it" → `dsnote_get_note` with the id from a search
- "What's in my Work notebook" → `dsnote_notebooks` for the id, then
  `dsnote_list_notes` with that `notebookId`
- "What did I delete" → `dsnote_list_notes` with `recycle: true`
- Search returns titles and plain-text snippets, not bodies. Read the note when
  the body matters.

Note bodies come back as Markdown. Checkboxes appear as `- [ ]` / `- [x]`.
If a note reports `encrypted: true`, its body is unavailable by design — say so
and do not pretend to have read it.

## Writing

- New note → `dsnote_create_note`. It needs a `notebookId`; resolve one with
  `dsnote_notebooks` rather than letting it land in the default notebook.
- Add to an existing note → `dsnote_append_note`. This never touches what is
  already there.
- Change a body, title or tags → `dsnote_update_note`. It replaces the body
  entirely, so if the user asked for a small change, read the note first and
  rewrite it deliberately, or use append.
- Checklist lines are the right shape for tasks inside a note:
  `- [ ] item` and `- [x] done item`.
- Tags are plain names, never `Name@uid`.

## Deleting

`dsnote_trash_note` moves a note to the recycle bin. That is the only delete
this plugin exposes — permanent removal is not available, by design. Say
"moved to the recycle bin", not "deleted". If the user really means permanent
deletion, tell them to empty the recycle bin in DSM.

Restoring is `dsnote_restore_note`.

**Trashing drops a note's tags.** Verified on a real NAS: a tagged note came
back from the recycle bin with an empty tag list, and the tag object itself
disappeared when no note carried it any more. So if a note is tagged, read its
tags first, and re-apply them after a restore.

## When an edit goes wrong

`dsnote_versions` lists a note's revisions and can restore one in place. This
is the undo. Before restoring, read the current note so you can tell the user
what is being replaced.

## Conflicts

If a write comes back as a conflict, someone edited the note elsewhere (the
phone app, the web client) between your read and your write. **Nothing was
overwritten.** Re-read the note, reapply the change, and mention it.

## Tasks

`dsnote_todos` manages the task list that lives next to the notes. Tasks are
separate objects, not checkboxes inside a note:
- "add a task" / "remind me to X" → `action: "create"`
- "what are my tasks" → `action: "list"`
- "mark it done" → `action: "complete"` with the id from a list

## Style

Keep answers short. After a write, say what changed and where:

- `Saved: "Electrical check" → Work.`
- `Appended to "Boiler log" under Day 2.`
- `Moved "Old draft" to the recycle bin.`

Do not paste whole note bodies back unless the user asked to see them. Do not
expose ids unless they are useful.

## Safety

- Never create test notes in the user's account to "check whether it works".
- Never touch a note the user did not name or ask you to find.
- Do not silently broaden "delete this note" into anything else.
- If a tool fails, report what it actually said. Do not claim success.
