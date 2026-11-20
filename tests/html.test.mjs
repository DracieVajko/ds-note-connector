import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKBOX_CLASS,
  CHECKBOX_CHECKED_CLASS,
  checkboxHtml,
  deriveBrief,
  checkRoundTrip,
  markdownToNoteHtml,
  noteHtmlToMarkdown,
} from '../core/html.mjs';

test('checkbox markup matches the stock editor', () => {
  const unchecked = checkboxHtml(false);
  const checked = checkboxHtml(true);
  assert.match(unchecked, /^<input class="syno-notestation-editor-checkbox" src="data:image\/png;base64,/);
  assert.ok(unchecked.includes('type="image"'));
  assert.ok(checked.includes(`${CHECKBOX_CLASS} ${CHECKBOX_CHECKED_CLASS}`));
});

test('checklist lines become checkbox blocks, not list items', () => {
  const html = markdownToNoteHtml('- [ ] buy milk\n- [x] pay rent');
  assert.equal(html, `<div>${checkboxHtml(false)}buy milk</div><div>${checkboxHtml(true)}pay rent</div>`);
});

test('blocks use <div> because that is what a saved note contains', () => {
  const html = markdownToNoteHtml('first line\n\nsecond line');
  assert.equal(html, '<div>first line</div><div>second line</div>');
});

test('headings, bold, links and lists map onto the allowed vocabulary', () => {
  const html = markdownToNoteHtml('## Title\n\n**bold** and [link](https://example.com)\n\n- one\n- two');
  assert.ok(html.includes('<h2>Title</h2>'));
  assert.ok(html.includes('<b>bold</b>'));
  assert.ok(html.includes('<a href="https://example.com">link</a>'));
  assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
});

test('markdown never emits tags Note Station strips', () => {
  const html = markdownToNoteHtml('> quoted\n\n```js\nconst a = 1;\n```\n\n`inline`');
  assert.ok(!html.includes('<blockquote>'));
  assert.ok(!html.includes('<pre>'));
  assert.ok(!html.includes('<code>'));
  assert.ok(!html.includes('<strong>'));
  assert.ok(html.includes('font-family: monospace'));
  assert.equal(checkRoundTrip(html).ok, true);
});

test('html entities are escaped, so a note cannot inject markup', () => {
  const html = markdownToNoteHtml('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a markdown round trip keeps the structure', () => {
  const source = '# Heading\n\n- one\n- two\n\n- [ ] task\n- [x] done';
  const markdown = noteHtmlToMarkdown(markdownToNoteHtml(source));
  assert.ok(markdown.includes('# Heading'));
  assert.ok(markdown.includes('- one'));
  assert.ok(markdown.includes('- [ ] task'));
  assert.ok(markdown.includes('- [x] done'));
});

test('reading a real-shaped stored note produces readable markdown', () => {
  const stored =
    '<h2>Report</h2><div>Checked <b>all</b> sockets.</div>' +
    `<div>${checkboxHtml(true)}RCD test</div>` +
    '<ul><li>kitchen</li><li>bathroom</li></ul>' +
    '<div><a href="https://example.com">docs</a></div>';
  const markdown = noteHtmlToMarkdown(stored);
  assert.ok(markdown.includes('## Report'));
  assert.ok(markdown.includes('**all**'));
  assert.ok(markdown.includes('- [x] RCD test'));
  assert.ok(markdown.includes('- kitchen'));
  assert.ok(markdown.includes('[docs](https://example.com)'));
});

test('brief is plain text, short, and free of markup', () => {
  const brief = deriveBrief('<div>Hello <b>world</b> — this is a note.</div>');
  assert.equal(brief, 'Hello world — this is a note.');
  const long = deriveBrief(`<div>${'x'.repeat(400)}</div>`, 50);
  assert.ok(long.length <= 50);
  assert.ok(long.endsWith('…'));
});

test('round-trip check flags a tag outside the allowlist', () => {
  assert.equal(checkRoundTrip('<div><marquee>hi</marquee></div>').ok, false);
});
