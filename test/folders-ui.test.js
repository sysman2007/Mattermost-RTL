const test = require('node:test');
const assert = require('node:assert/strict');

global.window = { registerPlugin() {} };
global.document = { documentElement: {} };
global.MutationObserver = class { observe() {} disconnect() {} };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.HTMLTextAreaElement = class { set value(v) {} };
const { splitFences } = require('../webapp/dist/main.js');

test('text and a closed code fence are split in order', () => {
  const parts = splitFences('ساختار مسیرها:\n\n```text\n├── خانه #/home\n└── audit\n```\n\nبرای **جزئیات** ببینید.');
  assert.deepEqual(parts.map(p => p.type), ['text', 'code', 'text']);
  assert.equal(parts[1].lang, 'text');
  assert.equal(parts[1].value, '├── خانه #/home\n└── audit');
  assert.match(parts[2].value, /\*\*جزئیات\*\*/);
});

test('an unclosed fence runs to the end of the message', () => {
  const parts = splitFences('intro\n```sql\nSELECT 1;\nSELECT 2;');
  assert.deepEqual(parts, [{ type: 'text', value: 'intro' }, { type: 'code', lang: 'sql', value: 'SELECT 1;\nSELECT 2;' }]);
});

test('a fence closes only with the same character and at least the same length', () => {
  const parts = splitFences('````md\n```js\nx\n```\n````');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].value, '```js\nx\n```', 'inner fence kept as content');
  const tilde = splitFences('~~~\na\n```\nb\n~~~');
  assert.equal(tilde[0].value, 'a\n```\nb');
});

test('plain text without fences stays one part; CRLF is normalised', () => {
  assert.deepEqual(splitFences('a\r\nb'), [{ type: 'text', value: 'a\nb' }]);
  assert.deepEqual(splitFences(''), []);
});
