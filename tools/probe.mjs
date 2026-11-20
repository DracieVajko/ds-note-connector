#!/usr/bin/env node
/**
 * Live verification probe.
 *
 * Everything in this repository is built on a reverse-engineered API and a
 * fake NAS. This script is the step that turns "should work" into "does work
 * on this machine": it runs each documented call against a real NAS and
 * reports what actually came back.
 *
 * Read-only by default. `--write` additionally creates one throwaway note,
 * edits it, and moves it to the recycle bin (never purges), so the write path
 * and the version-conflict behaviour are proven rather than assumed.
 *
 *   node tools/probe.mjs --host 192.168.1.10 --port 5001 --account me
 *   node tools/probe.mjs --quickconnect mynas --account me --write
 *   node tools/probe.mjs --host 192.168.1.10 --account me --certificate nas.crt
 *
 * With `--certificate` pointing at the NAS certificate exported from DSM, the
 * probe verifies the TLS chain properly instead of trusting the address.
 *   node tools/probe.mjs --host nas.example.com --account me --json
 *
 * The password is read from DS_NOTE_PASSWORD, or prompted for.
 */
import { fileURLToPath } from 'node:url';
import { createNoteStation, versionFor } from '../core/index.mjs';

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';

const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  const colour = status === 'pass' ? GREEN : status === 'fail' ? RED : YELLOW;
  const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN';
  console.log(`${colour}${mark}${RESET}  ${name}${detail ? `${DIM} — ${detail}${RESET}` : ''}`);
}

function parseArgs(argv) {
  const args = { port: 5001, https: true, write: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    const takesValue = !['write', 'json', 'insecure'].includes(key);
    if (takesValue) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function readPassword() {
  if (process.env.DS_NOTE_PASSWORD) return process.env.DS_NOTE_PASSWORD;
  if (!process.stdin.isTTY) {
    throw new Error('no password: set DS_NOTE_PASSWORD or run interactively');
  }
  process.stdout.write('DSM password: ');
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  let value = '';
  for await (const chunk of stdin) {
    const text = chunk.toString('utf8');
    for (const char of text) {
      if (char === '\r' || char === '\n') {
        stdin.setRawMode?.(false);
        stdin.pause();
        process.stdout.write('\n');
        return value;
      }
      if (char === '\u0003') process.exit(130);
      if (char === '\u007f') {
        value = value.slice(0, -1);
        continue;
      }
      value += char;
    }
  }
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const account = args.account ?? process.env.DS_NOTE_ACCOUNT;
  if (!account) {
    console.error('missing --account (or DS_NOTE_ACCOUNT)');
    process.exit(2);
  }
  const password = await readPassword();

  if (args.insecure) {
    console.log(
      `${YELLOW}warn${RESET} --insecure: the NAS certificate will not be checked, so the DSM password could be ` +
        'read by anything answering on that address.',
    );
  }

  const config = {
    account,
    password,
    otpCode: args.otp ?? process.env.DS_NOTE_OTP,
    deviceId: process.env.DS_NOTE_DEVICE_ID,
    // Verification stays on unless --insecure says otherwise. Guessing from the
    // host shape meant every IP address silently skipped the certificate check.
    allowSelfSigned: args.insecure === true,
    timeoutMs: 30000,
    logger: args.json ? undefined : { debug: () => {}, warn: (m) => console.log(`${YELLOW}warn${RESET} ${m}`) },
    mode: args.quickconnect ? 'quickconnect' : args.host?.includes('quickconnect.to') ? 'portal' : 'direct',
  };
  if (args.certificate) config.certificate = args.certificate;
  if (args['certificate-name']) config.certificateName = args['certificate-name'];
  if (args.hosts) {
    config.mode = 'auto';
    config.hosts = String(args.hosts).split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  if (args.quickconnect) config.quickConnectId = args.quickconnect;
  if (config.mode === 'direct') {
    config.host = args.host;
    config.port = Number(args.port);
    config.https = String(args.https) !== 'false';
  }

  console.log(`${DIM}mode ${config.mode}${config.host ? ` · ${config.host}:${config.port}` : ''}${args.quickconnect ? ` · ${args.quickconnect}` : ''}${RESET}\n`);

  let api;
  try {
    api = await createNoteStation(config);
  } catch (error) {
    record('fail', 'connect + login', error.message);
    return finish(args);
  }
  record('pass', 'connect + login', `${api.endpoint.kind} · ${api.endpoint.url}`);

  try {
    // 1. Which APIs exist, and where they live.
    let discovered = {};
    try {
      discovered = await api.client.discover();
      const names = Object.keys(discovered);
      record(names.length > 0 ? 'pass' : 'fail', 'API discovery', `${names.length} SYNO.NoteStation.* APIs`);
      const noteApi = discovered['SYNO.NoteStation.Note'];
      if (noteApi) {
        record(
          noteApi.path === 'entry.cgi' ? 'pass' : 'warn',
          'Note API path',
          `path=${noteApi.path} maxVersion=${noteApi.maxVersion} (we pin list=${versionFor('SYNO.NoteStation.Note', 'list')})`,
        );
      }
      for (const required of ['SYNO.NoteStation.Notebook', 'SYNO.NoteStation.Note', 'SYNO.NoteStation.Tag']) {
        if (!discovered[required]) record('fail', `required API ${required}`, 'not advertised by this NAS');
      }
    } catch (error) {
      record('fail', 'API discovery', error.message);
    }

    // 2. Read path.
    let notebooks = [];
    try {
      notebooks = await api.notebooks.list();
      record('pass', 'Notebook.list', `${notebooks.length} notebooks, ${notebooks.reduce((sum, n) => sum + n.noteCount, 0)} notes`);
    } catch (error) {
      record('fail', 'Notebook.list', error.message);
    }

    let notes = [];
    try {
      const page = await api.notes.list({ limit: 20 });
      notes = page.notes;
      record('pass', 'Note.list', `${page.total} notes, ${notes.length} in this page`);
      if (notes.length > 0) {
        const sample = notes[0];
        record(
          sample.content === undefined ? 'pass' : 'warn',
          'Note.list omits content',
          sample.content === undefined ? 'confirmed, as documented' : 'content WAS returned — update the docs',
        );
        record(
          sample.tag === undefined ? 'pass' : 'warn',
          'Note.list omits tags',
          sample.tag === undefined ? 'confirmed, as documented' : 'tags WERE returned — update the docs',
        );
      }
    } catch (error) {
      record('fail', 'Note.list', error.message);
    }

    let sampleNote = null;
    if (notes.length > 0) {
      try {
        sampleNote = await api.notes.get(notes[0].object_id);
        record(
          sampleNote.content !== undefined ? 'pass' : 'fail',
          'Note.get returns content',
          `${(sampleNote.content ?? '').length} chars, ver=${String(sampleNote.ver).slice(0, 8)}…`,
        );
      } catch (error) {
        record('fail', 'Note.get', error.message);
      }
    }

    try {
      const tags = await api.tags.list();
      record('pass', 'Tag.list', `${tags.length} tags${tags[0] ? `, first id ${tags[0].id}` : ''}`);
    } catch (error) {
      record('fail', 'Tag.list', error.message);
    }

    try {
      const { todos } = await api.todos.list({ limit: 5 });
      record('pass', 'Todo.list', `${todos.length} tasks`);
    } catch (error) {
      record('fail', 'Todo.list', error.message);
    }

    if (sampleNote) {
      try {
        const versions = await api.versions.list(sampleNote.object_id, { limit: 5 });
        record('pass', 'Note.Version.list', `${versions.length} revisions`);
      } catch (error) {
        record('fail', 'Note.Version.list', error.message);
      }
    }

    if (notes.length > 0) {
      try {
        const found = await api.search.search(notes[0].title.split(' ')[0] || notes[0].title, { limit: 5 });
        record('pass', 'FTS.search', `${found.notes.length} hits for "${notes[0].title.slice(0, 20)}"`);
      } catch (error) {
        record('fail', 'FTS.search', error.message);
      }
    }

    // 3. Write path, opt-in.
    if (args.write) {
      const target = notebooks.find((notebook) => !notebook.preset) ?? notebooks[0];
      if (!target) {
        record('fail', 'write probe', 'no notebook to write into');
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let created = null;
        try {
          created = await api.notes.create({
            title: `ds-note-connector probe ${stamp}`,
            notebookId: target.id,
            tags: ['ds-note-connector-probe'],
            markdown: '# probe\n\n- [ ] write path\n- [x] create\n\n`code` and **bold**',
          });
          record('pass', 'Note.create + Note.set', `object_id ${created.object_id}, ver ${String(created.ver).slice(0, 8)}…`);
          record(
            String(created.content ?? '').includes('syno-notestation-editor-checkbox') ? 'pass' : 'warn',
            'checkbox markup round-tripped',
            String(created.content ?? '').includes('syno-notestation-editor-checkbox')
              ? 'the server kept the editor checkbox input'
              : 'the server returned a different body — inspect it before trusting checklists',
          );
        } catch (error) {
          record('fail', 'Note.create + Note.set', error.message);
        }

        if (created) {
          try {
            const stale = await api.notes.get(created.object_id);
            await api.notes.set({ objectId: created.object_id, ver: stale.ver, markdown: '# probe\n\nedited' });
            try {
              await api.notes.set({ objectId: created.object_id, ver: stale.ver, markdown: '# probe\n\nconflicting edit' });
              record('fail', 'version conflict', 'a stale ver was accepted — writes are not protected');
            } catch (error) {
              record(
                error.name === 'NoteConflictError' ? 'pass' : 'warn',
                'version conflict',
                error.name === 'NoteConflictError' ? 'refused, as intended' : error.message,
              );
            }
          } catch (error) {
            record('fail', 'Note.set', error.message);
          }

          try {
            await api.notes.trash(created.object_id);
            record('pass', 'Note.delete (trash)', 'probe note moved to the recycle bin; delete it there when you like');
          } catch (error) {
            record('fail', 'Note.delete (trash)', error.message);
          }
        }
      }
    } else {
      record('warn', 'write probe', 'skipped — re-run with --write to prove create/set/trash and conflict handling');
    }
  } finally {
    await api.close().catch(() => {});
  }

  return finish(args);
}

function finish(args) {
  const failed = results.filter((entry) => entry.status === 'fail');
  const warned = results.filter((entry) => entry.status === 'warn');
  console.log(
    `\n${results.length} checks · ${results.length - failed.length - warned.length} pass · ${warned.length} warn · ${failed.length} fail`,
  );
  if (args.json) {
    console.log(JSON.stringify({ results, ok: failed.length === 0 }, null, 2));
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// Only run when executed directly; importing this module must do nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
