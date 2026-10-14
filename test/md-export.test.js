'use strict';
// Message → Markdown conversion (MdExport.toMarkdown in webapp/dist/main.js). Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = { registerPlugin() {} };
global.document = { documentElement: {} };
global.MutationObserver = class { observe() {} disconnect() {} };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.HTMLTextAreaElement = class { set value(v) {} };
const { toMarkdown, titleFrom, fileName } = require('../webapp/dist/main.js');

const sample = fs.readFileSync(path.join(__dirname, 'fixtures/plain-message.txt'), 'utf8');
const md = toMarkdown(sample, { author: '@ali', channel: '~ERP', date: '۲۲ مهر ۱۴۰۵' });

test('metadata line is a separate blockquote', () => {
  assert.match(md, /^> \*\*نویسنده:\*\* @ali · \*\*کانال:\*\* ~ERP · \*\*تاریخ:\*\* ۲۲ مهر ۱۴۰۵\n\n/);
});

test('═══ framed lines become ## sections with a rule before them', () => {
  assert.match(md, /---\n\n## بخش الف\) `POST \/api\/fin\/credit\/remain`/);
  assert.match(md, /---\n\n## آزمون‌ها\n/);
  assert.doesNotMatch(md, /═/);
});

test('«۱)» introducing an indented block becomes ### and the brace block is fenced', () => {
  assert.match(md, /### ۱\) فیلترهای تازه/);
  assert.match(md, /```text\n\{\n {2}agGridRequest, searchText,/);
  assert.match(md, /\n\}\n```\n/);
});

test('sibling bullets stay on one level; standalone numbered lines become list items', () => {
  assert.match(md, /\n- همهٔ شرط‌ها[^\n]*\n- بندِ مالکیت[^\n]*\n- ⚠️/);
  assert.match(md, /\n3\. اکسلِ/);
});

test('code-like tokens are wrapped once, prose and URLs are not', () => {
  for (const tok of ['`/accounting/customer-card`', '`sec."Webservices"`', '`GetRemainCreditListHandler`', '`OwnershipFilters.RemainCreditInOwnBooks`', '`searchText`', '`HomeDashboardDtos.cs`', '`Services/Sal/Sal.Application/Process/Report/HomeDashboard/`', '`"customer-card"`']) {
    assert.ok(md.includes(tok), tok);
  }
  assert.doesNotMatch(md.replace(/^```.*$/gm, ''), /``/);
  const withUrl = toMarkdown('see https://example.com/a/b/c and fooBar');
  assert.equal(withUrl, 'see https://example.com/a/b/c and `fooBar`\n');
});

test('fenced code inside the message is left untouched', () => {
  const out = toMarkdown('intro\n```\nconst fooBar = "x";\n```');
  assert.match(out, /```\nconst fooBar = "x";\n```/);
});

test('short first line becomes the title; notes become callouts; line breaks kept', () => {
  const out = toMarkdown('گزارش هفتگی\n\nخط یک\nخط دو\n\nنکته: deploy پنجشنبه است.');
  assert.match(out, /^# گزارش هفتگی\n\n/);
  assert.match(out, /خط یک {2}\nخط دو/);
  assert.match(out, /> \*\*نکته:\*\* deploy پنجشنبه است\./);
});

test('text that is already Markdown is kept as is', () => {
  const src = '# Title\n\n- a\n- b\n\n```js\nx()\n```';
  assert.equal(toMarkdown(src), '# Title\n\n- a\n- b\n\n```js\nx()\n```\n');
});

test('title and file name', () => {
  assert.equal(titleFrom('══════\n**گزارش**: فروش\nبقیه'), 'گزارش: فروش');
  assert.equal(fileName('a/b:c*?"<>|d'), 'a b c d.md');
  assert.equal(fileName('گزارش\u200cها'), 'گزارش ها.md');
  assert.equal(fileName('پایان جمله.'), 'پایان جمله.md');
  assert.ok(fileName('x'.repeat(200)).length <= 63);
});

// Real-world team messages (test/fixtures/msg-*.txt).
const conv = name => toMarkdown(fs.readFileSync(path.join(__dirname, `fixtures/${name}.txt`), 'utf8'));

test('label + key/value lines become a list with bold keys, nested under a sub-label', () => {
  const out = conv('msg-litellm');
  assert.match(out, /## داخلِ فایل\n\n- \*\*مشخصاتِ اتصال:\*\* /);
  assert.match(out, /- \*\*دو نکته از رفتارِ فعلیِ برنامه‌اش:\*\*\n {2}- \*\*سقفِ خروجی:\*\* همیشه `max_tokens` بفرستد/);
  assert.match(out, /\n {2}- \*\*embedding:\*\* /);
  for (const tok of ['`litellm-key-erpapi-chatbot-dev.md`', '`erpapi-chatbot-dev`', '`gpt.ibarsam.com`', '`Llm__ApiKey`', '`Microsoft.Extensions.AI`']) assert.ok(out.includes(tok), tok);
  assert.ok(out.includes('https://gpt.ibarsam.com/v1'), 'URL left as a link');
});

test('a leading «label:» line is the title; «کلید: …» paragraphs get a bold key; «یک نکته:» is a callout', () => {
  const out = conv('msg-401');
  assert.match(out, /^# علت 401\n\n/);
  assert.match(out, /\n\*\*اقدام تیم:\*\* دوباره لاگین کنند/);
  assert.match(out, /\n> \*\*یک نکته:\*\* این توکن/);
  assert.ok(out.includes('`sec."UserRefreshTokens"`') && out.includes('`sec/check`') && out.includes('`Sal.Api`'));
});

test('«۱) …:» followed by bullets is a ### section; bullet keys stay code', () => {
  const out = conv('msg-dashboard');
  assert.match(out, /\n### ۱\) receivable \(مطالبات\)/);
  assert.match(out, /\n### ۲\) commission/);
  assert.match(out, /\n- `dueTodayAmount` \(decimal\): جمعِ/);
  assert.match(out, /\*\*محل:\*\* erpapi، `Services\/Sal\/Sal\.Application\/Process\/Report\/HomeDashboard\/`/);
  assert.ok(out.includes('`fromDate/toDate`') && out.includes('`ReceivableDto`') && out.includes('`erp_front`'));
});

test('standalone short lines become sections; «۱. …» alone becomes ###; commit hash is code', () => {
  const out = conv('msg-warehouse');
  assert.match(out, /\n### ۱\. عملکرد من برای همه\n/);
  assert.match(out, /\n### ۳\. `isLocked`\n/);
  assert.match(out, /\n## تست‌ها\n/);
  assert.match(out, /\n## موضوع باز برای تیم فرانت\n/);
  assert.ok(out.includes('`25a2c12d`') && out.includes('`origin/dev`') && out.includes('`warehouses[]`'));
  assert.match(out, /^سلام، سه اصلاح/);
});
