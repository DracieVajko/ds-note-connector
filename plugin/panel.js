/*
 * DS Note — panel.
 *
 * The panel has no Node access and does not talk to the NAS. It asks the
 * plugin brain over a BroadcastChannel, and the brain asks the bundled worker.
 * A freshly opened panel cannot know whether the brain is running yet, so the
 * first thing it does is wake it, and every request is re-sent until it is
 * answered — the brain drops duplicates by `reqId`, so a resend can never
 * become a second write.
 */
const $ = (id) => document.getElementById(id);
const { channel, call } = globalThis.dsNoteBrain;

let notebooks = [];
let searchTimer = null;

/* ------------------------------------------------------------ rendering --- */

function setStatus(text, state) {
  $('status').textContent = text;
  $('dot').dataset.state = state;
}

function escapeHtml(text) {
  // Quotes matter as much as angle brackets here: the result is interpolated
  // into attribute values (`<a href="…">`), so an unescaped quote would close
  // the attribute and let a note body inject an event handler.
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A deliberately small Markdown renderer for reading. It only needs to make
 * stored notes readable; anything it does not understand stays visible text.
 */
function renderMarkdown(markdown) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let inList = null;

  const closeList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (match, label, url) =>
        // Belt and braces: the URL is escaped already, but a scheme check means
        // a `javascript:` or `data:` link can never become a live anchor.
        /^https?:\/\//i.test(url) ? `<a href="${url}" rel="noreferrer noopener">${label}</a>` : match,
      );

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      continue;
    }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      closeList();
      const box = task[1].toLowerCase() === 'x' ? '☑' : '☐';
      out.push(`<span class="task">${box} ${inline(task[2])}</span>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (inList !== 'ul') {
        closeList();
        out.push('<ul>');
        inList = 'ul';
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (inList !== 'ol') {
        closeList();
        out.push('<ol>');
        inList = 'ol';
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() !== '') out.push(`<div>${inline(line)}</div>`);
  }
  closeList();
  return out.join('');
}

function formatWhen(epochSeconds) {
  if (!epochSeconds) return '';
  const date = new Date(epochSeconds * 1000);
  const now = Date.now();
  const diffDays = Math.floor((now - date.getTime()) / 86400000);
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function renderNotebooks() {
  const filter = $('notebook');
  const composer = $('composer-notebook');
  const keepFilter = filter.value;
  filter.innerHTML = '<option value="">All notebooks</option>';
  composer.innerHTML = '';
  for (const notebook of notebooks) {
    const option = document.createElement('option');
    option.value = notebook.id;
    option.textContent = `${notebook.title} (${notebook.noteCount})`;
    filter.append(option);

    const composerOption = option.cloneNode(true);
    composer.append(composerOption);
  }
  if (keepFilter) filter.value = keepFilter;
  if (!composer.value && notebooks.length > 0) composer.value = notebooks[0].id;
}

function renderList(notes) {
  const list = $('list');
  list.innerHTML = '';
  $('count').textContent = notes.length === 1 ? '1 note' : `${notes.length} notes`;
  $('empty').hidden = notes.length > 0;
  if (notes.length === 0) {
    $('empty').textContent = $('search').value
      ? 'Nothing matched that search.'
      : 'No notes here yet.';
    return;
  }
  for (const note of notes) {
    const item = document.createElement('li');
    item.dataset.id = note.id;
    item.innerHTML = `<span class="when">${escapeHtml(formatWhen(note.updatedAt))}</span>
      <span class="title">${escapeHtml(note.title || 'Untitled')}</span>
      <span class="snippet">${escapeHtml(note.brief || '')}</span>`;
    item.addEventListener('click', () => openNote(note.id));
    list.append(item);
  }
}

/* ---------------------------------------------------------------- flow --- */

async function loadStatus() {
  try {
    const status = await call('dsnote_status');
    const counts = status.counts || {};
    const route = status.connection?.route || 'direct';
    const model = status.dsm?.model || 'NAS';
    const certificate = status.certificate ?? {};
    setStatus(
      `${model} · ${route} · ${counts.notebooks ?? 0} notebooks · ${counts.notes ?? 0} notes` +
        (status.session?.csrfToken ? '' : ' · no CSRF token'),
      'ok',
    );
    const pin = $('certificate');
    if (pin) {
      pin.hidden = !certificate.fingerprint;
      pin.textContent = certificate.fingerprint
        ? `${certificate.pinned ? 'pinned' : 'not pinned'}: ${certificate.fingerprint}`
        : '';
      pin.title = certificate.fingerprint ?? '';
    }
    return status;
  } catch (error) {
    setStatus(error.message, 'error');
    return null;
  }
}

async function loadNotebooks() {
  try {
    const result = await call('dsnote_notebooks', { action: 'list' });
    notebooks = result.notebooks || [];
    renderNotebooks();
  } catch (error) {
    notebooks = [];
    renderNotebooks();
    if (!/not configured/i.test(error.message)) setStatus(error.message, 'error');
  }
}

async function loadNotes() {
  const query = $('search').value.trim();
  const notebookId = $('notebook').value;
  try {
    if (query) {
      const result = await call('dsnote_search', { query, limit: 50 });
      renderList(result.notes || []);
      return;
    }
    const result = await call('dsnote_list_notes', { notebookId: notebookId || undefined, limit: 100 });
    renderList(result.notes || []);
  } catch (error) {
    renderList([]);
    setStatus(error.message, 'error');
  }
}

async function openNote(id) {
  $('detail').hidden = false;
  $('list').hidden = true;
  $('detail-title').textContent = 'Loading…';
  $('detail-body').innerHTML = '';
  $('detail-tags').innerHTML = '';
  $('detail-meta').textContent = '';
  try {
    const note = await call('dsnote_get_note', { id });
    $('detail-title').textContent = note.title || 'Untitled';
    $('detail-meta').textContent = [
      formatWhen(note.updatedAt),
      note.encrypted ? 'encrypted' : null,
      note.version ? `v${String(note.version).slice(0, 7)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    $('detail-tags').innerHTML = (note.tags || [])
      .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
      .join('');
    $('detail-body').innerHTML = note.encrypted
      ? '<p class="empty">This note is encrypted. Its body cannot be read through the API.</p>'
      : renderMarkdown(note.markdown || '');
  } catch (error) {
    $('detail-title').textContent = 'Could not open the note';
    $('detail-body').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function showList() {
  $('detail').hidden = true;
  $('list').hidden = false;
}

async function saveComposer() {
  const title = $('composer-title').value.trim();
  const notebookId = $('composer-notebook').value;
  const markdown = $('composer-body').value;
  if (!title) {
    $('composer-status').textContent = 'A title is needed.';
    return;
  }
  if (!notebookId) {
    $('composer-status').textContent = 'Pick a notebook first.';
    return;
  }
  $('composer-save').disabled = true;
  $('composer-status').textContent = 'Saving…';
  try {
    const note = await call('dsnote_create_note', { title, notebookId, markdown });
    $('composer').hidden = true;
    $('composer-title').value = '';
    $('composer-body').value = '';
    $('composer-status').textContent = '';
    await loadNotebooks();
    await loadNotes();
    await openNote(note.id);
  } catch (error) {
    $('composer-status').textContent = error.message;
  } finally {
    $('composer-save').disabled = false;
  }
}

async function refreshAll() {
  setStatus('Loading…', 'busy');
  await globalThis.dsNoteBrain.wake();
  await loadStatus();
  await loadNotebooks();
  await loadNotes();
}

/* --------------------------------------------------------------- wiring --- */

$('refresh').addEventListener('click', refreshAll);
$('back').addEventListener('click', showList);
$('notebook').addEventListener('change', loadNotes);
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadNotes, 300);
});
$('new').addEventListener('click', () => {
  $('composer').hidden = false;
  $('composer-title').focus();
});
$('composer-cancel').addEventListener('click', () => {
  $('composer').hidden = true;
  $('composer-status').textContent = '';
});
$('composer-save').addEventListener('click', saveComposer);

channel.addEventListener('message', (event) => {
  if (event.data?.type === 'settings-changed') refreshAll();
});

refreshAll();
