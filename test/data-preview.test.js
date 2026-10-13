'use strict';
// CSV/TSV and JSON preview (public/md-preview/frame.js). Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectDelimiter, parseCsv, renderCsv, renderJson } = require('../public/md-preview/frame.js');

test('delimiter detection', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3', 'csv'), ',');
  assert.equal(detectDelimiter('a;b;c\n1;2;3', 'csv'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2', 'csv'), '\t');
  assert.equal(detectDelimiter('a,b\n1,2', 'tsv'), '\t');
  assert.equal(detectDelimiter('"x;y",b,c', 'csv'), ',');
});

test('RFC 4180 quoting: delimiters, newlines and escaped quotes inside fields', () => {
  const { rows } = parseCsv('name,note\r\n"Ali, R.","line1\nline2"\n"say ""hi""",x\n', ',');
  assert.deepEqual(rows, [['name', 'note'], ['Ali, R.', 'line1\nline2'], ['say "hi"', 'x']]);
});

test('BOM, blank lines and a missing trailing newline', () => {
  assert.deepEqual(parseCsv('﻿a,b\n\n1,2', ',').rows, [['a', 'b'], ['1', '2']]);
});

test('row limit truncates', () => {
  const text = 'h\n' + Array.from({ length: 50 }, (_, i) => i).join('\n');
  const { rows, truncated } = parseCsv(text, ',', 10);
  assert.equal(rows.length, 10);
  assert.equal(truncated, true);
});

test('CSV table: per-cell direction, numbers, ragged rows, escaping', () => {
  const html = renderCsv('نام,Price,x\nکتاب,۱۲۰٬۰۰۰\n<img src=x onerror=alert(1)>,15.5,y', 'csv');
  assert.match(html, /2 rows × 3 columns · comma-separated/);
  assert.match(html, /<th dir="rtl">نام<\/th>/);
  assert.match(html, /<td dir="ltr" class="num">۱۲۰٬۰۰۰<\/td><td dir="ltr"><\/td>/);
  assert.match(html, /<td dir="ltr" class="num">15.5<\/td>/);
  assert.doesNotMatch(html, /<img/);
});

test('JSON: pretty-printed and summarised; invalid JSON shows the error and raw text', () => {
  const ok = renderJson('{"a":[1,2],"نام":"علی"}');
  assert.match(ok, /object · 2 keys · 7 lines/);
  assert.match(ok, /class="language-json"/);
  assert.match(ok, /&quot;نام&quot;: &quot;علی&quot;/);
  const bad = renderJson('{"a": <script>}');
  assert.match(bad, /Invalid JSON/);
  assert.doesNotMatch(bad, /<script>/);
});
