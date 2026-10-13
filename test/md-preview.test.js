'use strict';
// Markdown preview renderer (public/md-preview/frame.js): parsing and the
// security rules for files uploaded by other users. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, sanitizeHtmlLine, safeHref, safeImgSrc } = require('../public/md-preview/frame.js');

const html = md => parse(md).html;

test('headings, emphasis, lists, tables and code render', () => {
  const out = html('# عنوان\n\n**پررنگ** و *کج* و `code`\n\n- یک\n- [x] انجام شد\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```');
  assert.match(out, /<h1 id="عنوان">عنوان<\/h1>/);
  assert.match(out, /<strong>پررنگ<\/strong>/);
  assert.match(out, /<em>کج<\/em>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<li class="task"><input type="checkbox" disabled checked> انجام شد<\/li>/);
  assert.match(out, /<td style="text-align:right">2<\/td>/);
  assert.match(out, /<code class="language-javascript">const x = 1;<\/code>/);
});

test('mermaid fences become diagram placeholders, source escaped', () => {
  const out = html('```mermaid\ngraph TD; A-->B["<img src=x onerror=alert(1)>"]\n```');
  assert.match(out, /class="mermaid-render" data-source="/);
  assert.doesNotMatch(out, /<img src=x/);
});

test('snake_case words are not italicised', () => {
  assert.doesNotMatch(html('use my_var_name here'), /<em>/);
});

test('raw HTML lines keep only allowlisted tags and attributes', () => {
  assert.equal(sanitizeHtmlLine('<div dir="rtl" align="center">'), '<div dir="rtl" align="center">');
  assert.equal(sanitizeHtmlLine('<div dir="rtl" onclick="alert(1)" style="x">'), '<div dir="rtl">');
  assert.equal(sanitizeHtmlLine('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(sanitizeHtmlLine('<script>'), '&lt;script&gt;');
  assert.equal(sanitizeHtmlLine('<iframe src="https://evil">'), '&lt;iframe src=&quot;https://evil&quot;&gt;');
  assert.equal(sanitizeHtmlLine('<div dir="rtl&quot;onmouseover=x">'), '<div>');
  assert.doesNotMatch(html('<svg onload=alert(1)>'), /<svg/);
});

test('links: only http(s), mailto and in-page anchors', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref(' JavaScript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref('vbscript:x'), null);
  assert.equal(safeHref('https://example.com/a?b=1&amp;c=2'), 'https://example.com/a?b=1&c=2');
  assert.equal(safeHref('#section'), '#section');
  const out = html('[click](javascript:alert(1)) [ok](https://example.com)');
  assert.doesNotMatch(out, /href="javascript/i);
  assert.match(out, /<a href="https:\/\/example.com">ok<\/a>/);
});

test('images: only http(s) and raster data URIs', () => {
  assert.equal(safeImgSrc('javascript:alert(1)'), null);
  assert.equal(safeImgSrc('data:image/svg+xml;base64,AAA'), null);
  assert.equal(safeImgSrc('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  const out = html('![x](javascript:alert(1)) ![y](https://example.com/a.png "t")');
  assert.doesNotMatch(out, /src="javascript/i);
  assert.match(out, /<img src="https:\/\/example.com\/a.png" alt="y" title="t" loading="lazy" referrerpolicy="no-referrer">/);
});

test('attribute break-out through link text, title or URL is escaped', () => {
  const out = html('[a" onmouseover="x](https://e.com "t\\" onload=\\"y") ![b"><script>](https://e.com/x.png)');
  assert.doesNotMatch(out, /<script>/);
  assert.doesNotMatch(out, /" onmouseover="/);
  assert.doesNotMatch(out, /" onload="/);
});
