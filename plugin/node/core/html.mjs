/**
 * Note Station rich-text HTML ⇄ Markdown.
 *
 * Note Station stores note bodies as HTML, not Markdown, and its editor only
 * round-trips a known vocabulary — anything outside it can be stripped the
 * next time the stock app opens the note. So this module never emits tags it
 * has not seen in a saved note. The allowlist and the checkbox markup come
 * from a real "format everything, save, reload" capture (see docs/API.md):
 *
 *   blocks      <div> (what saved notes actually use), <p>
 *   headings    <h1>…<h6>
 *   inline      <b> <i> <u> <sup> <sub> <span style>
 *   lists       <ol> <ul> <li>
 *   checkbox    <input class="syno-notestation-editor-checkbox" type="image" src="…">
 *               checked adds the class "syno-notestation-editor-checkbox-checked"
 *   table       <table> <tbody> <tr> <td>
 *   misc        <hr> <br> <a href> <img class="syno-notestation-image-object" ref>
 *
 * Deliberately NOT emitted: <pre>, <code>, <blockquote>, <strong>, <em>.
 * Markdown code and quotes are rendered with allowed constructs instead, so
 * the note stays editable in the stock app.
 */

/** The 1×1 transparent PNG the stock editor uses for its checkbox glyph. */
export const CHECKBOX_SRC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAALSURBVBhXY2AAAgAABQABqtXIUQAAAABJRU5ErkJggg==';

export const CHECKBOX_CLASS = 'syno-notestation-editor-checkbox';
export const CHECKBOX_CHECKED_CLASS = 'syno-notestation-editor-checkbox-checked';

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => ESCAPE[char]);
}

function unescapeHtml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function checkboxHtml(checked) {
  const cls = checked ? `${CHECKBOX_CLASS} ${CHECKBOX_CHECKED_CLASS}` : CHECKBOX_CLASS;
  return `<input class="${cls}" src="${CHECKBOX_SRC}" type="image" />`;
}

/* ------------------------------------------------------------------ *
 * Markdown → Note Station HTML
 * ------------------------------------------------------------------ */

function renderInline(text) {
  let out = escapeHtml(text);
  // Code first, so its contents are not touched by the emphasis rules.
  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });
  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<span style="text-decoration: line-through">$1</span>');
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => {
    const code = codeSpans[Number(index)];
    return `<span style="font-family: monospace">${escapeHtml(code)}</span>`;
  });
  return out;
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/**
 * Convert Markdown to the HTML subset Note Station preserves.
 * Every block becomes a `<div>`, because that is what a saved note contains.
 */
export function markdownToNoteHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  const flushList = (items, ordered) => {
    if (items.length === 0) return;
    const tag = ordered ? 'ol' : 'ul';
    const body = items.map((item) => `<li>${item}</li>`).join('');
    blocks.push(`<${tag}>${body}</${tag}>`);
    items.length = 0;
  };

  let listItems = [];
  let listOrdered = false;

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushList(listItems, listOrdered);
      index += 1;
      const code = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        `<div style="font-family: monospace">${code.map(escapeHtml).join('<br>')}</div>`,
      );
      continue;
    }

    // Table
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushList(listItems, listOrdered);
      const header = splitTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const head = `<tr>${header.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`;
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('');
      blocks.push(`<div><table><tbody>${head}${body}</tbody></table></div>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList(listItems, listOrdered);
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    // Divider
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushList(listItems, listOrdered);
      blocks.push('<hr>');
      index += 1;
      continue;
    }

    // Checklist item
    const checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (checkbox) {
      flushList(listItems, listOrdered);
      blocks.push(`<div>${checkboxHtml(checkbox[1].toLowerCase() === 'x')}${renderInline(checkbox[2])}</div>`);
      index += 1;
      continue;
    }

    // Bullet list
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (listItems.length > 0 && listOrdered) flushList(listItems, listOrdered);
      listOrdered = false;
      listItems.push(renderInline(bullet[1]));
      index += 1;
      continue;
    }

    // Ordered list
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (listItems.length > 0 && !listOrdered) flushList(listItems, listOrdered);
      listOrdered = true;
      listItems.push(renderInline(ordered[1]));
      index += 1;
      continue;
    }

    flushList(listItems, listOrdered);

    // Blockquote — no <blockquote> in the allowlist, so a grey span in a div.
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push(`<div><span style="color: #808080">${renderInline(quote[1])}</span></div>`);
      index += 1;
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    blocks.push(`<div>${renderInline(line)}</div>`);
    index += 1;
  }

  flushList(listItems, listOrdered);
  return blocks.join('');
}

/* ------------------------------------------------------------------ *
 * Note Station HTML → Markdown
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

/**
 * A very small HTML parser. Note Station bodies are machine-generated and
 * well-formed; a tolerant tokenizer is enough, and it keeps this package
 * dependency-free.
 */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const source = String(html ?? '');
  let index = 0;

  const push = (node) => stack[stack.length - 1].children.push(node);

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt === -1) {
      push({ tag: '#text', text: source.slice(index) });
      break;
    }
    if (lt > index) push({ tag: '#text', text: source.slice(index, lt) });

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    const gt = source.indexOf('>', lt);
    if (gt === -1) {
      push({ tag: '#text', text: source.slice(lt) });
      break;
    }
    const raw = source.slice(lt + 1, gt);
    index = gt + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const nameMatch = raw.match(/^([a-zA-Z][\w:-]*)/);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();
    const attrs = {};
    const attrRe = /([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let match;
    while ((match = attrRe.exec(raw)) !== null) {
      attrs[match[1].toLowerCase()] = unescapeHtml(match[3] ?? match[4] ?? match[5] ?? '');
    }
    const node = { tag, attrs, children: [] };
    push(node);
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(node);
  }
  return root;
}

function isCheckbox(node) {
  return node.tag === 'input' && String(node.attrs.class ?? '').includes(CHECKBOX_CLASS);
}

function isChecked(node) {
  return String(node.attrs.class ?? '').includes(CHECKBOX_CHECKED_CLASS);
}

function styleHas(node, property, value) {
  const style = String(node.attrs.style ?? '').toLowerCase();
  return style.includes(property) && (!value || style.includes(value));
}

function renderNodes(nodes, context = {}) {
  let out = '';
  for (const node of nodes) {
    out += renderNode(node, context);
  }
  return out;
}

/** Raw text of a node tree, for code blocks where whitespace matters. */
function rawText(node) {
  if (node.tag === '#text') return node.text;
  if (node.tag === 'br') return '\n';
  return (node.children ?? []).map(rawText).join('');
}

function renderListItem(node, context, listTag, index) {
  const inner = renderNodes(node.children, context).trim();
  if (inner.startsWith('- [') || inner.startsWith('1. [')) return `\n${inner}`;
  return `\n${listTag === 'ol' ? `${index}.` : '-'} ${inner}`;
}

function renderNode(node, context) {
  if (node.tag === '#text') return node.text.replace(/\s+/g, ' ');

  switch (node.tag) {
    case 'br':
      return '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(node.tag[1]);
      return `\n\n${'#'.repeat(level)} ${renderNodes(node.children, context).trim()}\n\n`;
    }
    case 'div': {
      // A monospace block is how a code fence is stored.
      if (styleHas(node, 'font-family', 'monospace')) {
        return `\n\n\`\`\`\n${rawText(node).replace(/\n+$/, '')}\n\`\`\`\n\n`;
      }
      // A single grey span inside a div is how a blockquote is stored.
      const meaningful = (node.children ?? []).filter(
        (child) => child.tag !== '#text' || String(child.text ?? '').trim() !== '',
      );
      if (
        meaningful.length === 1 &&
        meaningful[0].tag === 'span' &&
        styleHas(meaningful[0], 'color', '#808080')
      ) {
        return `\n> ${renderNodes(meaningful[0].children, context).trim()}`;
      }
      const inner = renderNodes(node.children, context).trim();
      if (inner === '') return '';
      // A saved note uses <div> per line, like a line break — not a paragraph.
      return `\n${inner}`;
    }
    case 'p': {
      const inner = renderNodes(node.children, context).trim();
      if (inner === '') return '';
      return `\n\n${inner}\n\n`;
    }
    case 'ul':
    case 'ol': {
      let out = '\n';
      let index = 0;
      for (const child of node.children ?? []) {
        if (child.tag === 'li') {
          index += 1;
          out += renderListItem(child, context, node.tag, index);
        } else {
          out += renderNodes([child], { ...context, list: node.tag });
        }
      }
      return `${out}\n`;
    }
    case 'li': {
      const inner = renderNodes(node.children, context).trim();
      if (inner.startsWith('- [') || inner.startsWith('1. [')) return `\n${inner}`;
      return `\n${context.list === 'ol' ? '1.' : '-'} ${inner}`;
    }
    case 'b':
    case 'strong':
      return `**${renderNodes(node.children, context)}**`;
    case 'i':
    case 'em':
      return `*${renderNodes(node.children, context)}*`;
    case 'u':
      return renderNodes(node.children, context);
    case 'span': {
      const inner = renderNodes(node.children, context);
      if (styleHas(node, 'font-family', 'monospace')) return `\`${inner.trim()}\``;
      if (styleHas(node, 'line-through')) return `~~${inner}~~`;
      return inner;
    }
    case 'a': {
      const inner = renderNodes(node.children, context).trim();
      const href = node.attrs.href;
      return href ? `[${inner || href}](${href})` : inner;
    }
    case 'img': {
      const label = node.attrs.alt || node.attrs.ref || 'image';
      return `![${label}]`;
    }
    case 'input':
      if (isCheckbox(node)) return isChecked(node) ? '- [x] ' : '- [ ] ';
      return '';
    case 'table':
      return `\n\n${renderTable(node)}\n\n`;
    case 'tbody':
    case 'tr':
      return renderNodes(node.children, context);
    case 'td': {
      const inner = renderNodes(node.children, context).trim().replace(/\n+/g, ' ');
      return `| ${inner} `;
    }
    default:
      return renderNodes(node.children, context);
  }
}

function renderTable(table) {
  const rows = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.tag === 'tr') {
        const cells = (child.children ?? [])
          .filter((cell) => cell.tag === 'td')
          .map((cell) => renderNodes(cell.children, {}).trim().replace(/\n+/g, ' '));
        if (cells.length > 0) rows.push(cells);
      } else if (child.children) {
        walk(child);
      }
    }
  };
  walk(table);
  if (rows.length === 0) return '';
  const header = `| ${rows[0].join(' | ')} |`;
  const divider = `| ${rows[0].map(() => '---').join(' | ')} |`;
  const body = rows.slice(1).map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [header, divider, body].filter(Boolean).join('\n');
}

/** Convert a stored note body into Markdown an agent can read. */
export function noteHtmlToMarkdown(html) {
  const tree = parseHtml(html);
  const markdown = renderNodes(tree.children, {});
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The `brief` field the stock client sends alongside `content`: plain text,
 * derived from the HTML. Kept short because it is also what the note list
 * shows.
 */
export function deriveBrief(html, limit = 200) {
  const tree = parseHtml(html);
  const text = renderNodes(tree.children, {})
    .replace(/!\[[^\]]*\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/- \[x\]/gi, '☑')
    .replace(/- \[ \]/g, '☐')
    .replace(/[#*`~>|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/**
 * Whether the body only uses the vocabulary Note Station round-trips.
 *
 * Named `check*` rather than `is*` because it returns a report, not a boolean —
 * every other `is*` helper in this codebase returns true or false.
 */
export function checkRoundTrip(html) {
  const allowed = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'p', 'b', 'i', 'u', 'sup', 'sub',
    'span', 'ol', 'ul', 'li', 'input', 'table', 'tbody', 'tr', 'td', 'hr', 'br', 'a', 'img',
  ]);
  const problems = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.tag !== '#text' && !allowed.has(child.tag)) problems.push(`<${child.tag}>`);
      if (child.children) walk(child);
    }
  };
  walk(parseHtml(html));
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
