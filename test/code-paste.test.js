'use strict';
// Code-paste language detection and the code file preview. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = { registerPlugin() {} };
global.document = { documentElement: {} };
global.MutationObserver = class { observe() {} disconnect() {} };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.HTMLTextAreaElement = class { set value(v) {} };
const { detectCode, openFenceBefore } = require('../webapp/dist/main.js');
const { renderCode } = require('../public/md-preview/frame.js');

const cases = {
  python: 'def total(items):\n    return sum(i.price for i in items)\n',
  csharp: 'using System;\npublic class Order {\n    public decimal Total { get; set; }\n}',
  javascript: 'const total = items.reduce((s, i) => s + i.price, 0);\nconsole.log(total);',
  typescript: 'interface Order {\n  id: string;\n  total: number;\n}',
  sql: 'SELECT id, total\nFROM orders\nWHERE total > 100;',
  json: '{\n  "id": 1,\n  "name": "علی"\n}',
  go: 'package main\n\nfunc main() {\n\tx := 1\n}',
  bash: 'docker compose up -d\ncurl -s localhost:4000/v1/models',
  powershell: '$files = Get-ChildItem . | Where-Object { $_.Length -gt 0 }\nWrite-Host $files.Count',
  yaml: 'services:\n  web:\n    image: nginx\n    ports:\n      - "80:80"',
  html: '<div class="card">\n  <span>hi</span>\n</div>',
  dockerfile: 'FROM node:20\nWORKDIR /app\nRUN npm ci',
  java: 'public class Main {\n  public static void main(String[] a) { System.out.println(1); }\n}',
  diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b'
};

for (const [lang, code] of Object.entries(cases)) {
  test(`detects ${lang}`, () => assert.deepEqual(detectCode(code), { isCode: true, lang }));
}

test('prose is not code (Persian, English, team messages)', () => {
  assert.equal(detectCode('سلام بچه‌ها، جلسه فردا ساعت ۱۰ است.\nلطفاً گزارش‌ها را آماده کنید.').isCode, false);
  assert.equal(detectCode('Hi team,\nthe meeting is tomorrow at 10.\nPlease bring your reports.').isCode, false);
  for (const f of ['msg-401', 'msg-warehouse', 'msg-litellm']) {
    assert.equal(detectCode(fs.readFileSync(path.join(__dirname, `fixtures/${f}.txt`), 'utf8')).isCode, false, f);
  }
  assert.equal(detectCode('ok').isCode, false);
});

test('unknown but code-shaped text is code with the plain-text language', () => {
  assert.deepEqual(detectCode('foo {\n  bar;\n  baz;\n}'), { isCode: true, lang: 'text' });
});

test('open fence detection at the caret', () => {
  const v = 'intro\n```\n';
  assert.equal(openFenceBefore(v, v.length), 6);
  assert.equal(openFenceBefore('a\n```js\nx\n```\nb', 15), -1);
  assert.equal(openFenceBefore('no fences', 3), -1);
});

test('code file view: line numbers, escaping, unknown language falls back to text', () => {
  const html = renderCode('<script>alert(1)</script>\nx = 1\n', 'python', 'a.py');
  assert.match(html, /python · 2 lines/);
  assert.match(html, /<pre class="code-gutter" aria-hidden="true">1\n2<\/pre>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /class="language-text"/, 'Prism not loaded in tests → text');
  assert.match(html, /<span class="language-label">a\.py<\/span>/);
});
