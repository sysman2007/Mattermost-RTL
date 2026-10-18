const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const O = require('../public/md-preview/office.js');

// Builds a ZIP archive: entries [{ name, data, store?, flags?, size? }].
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const body = e.store ? data : zlib.deflateRawSync(data);
    const name = Buffer.from(e.name);
    const method = e.store ? 0 : 8;
    const size = e.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(e.flags || 0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.flags || 0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...locals, cd, eocd]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

test('reads stored and deflated ZIP entries', async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'سلام', store: true }, { name: 'xl/b.xml', data: '<x>' + 'y'.repeat(5000) + '</x>' }]);
  const entries = O.zipEntries(zip);
  assert.deepEqual([...entries.keys()], ['a.txt', 'xl/b.xml']);
  assert.equal(new TextDecoder().decode(await O.zipRead(entries, 'a.txt')), 'سلام');
  assert.equal((await O.zipRead(entries, 'xl/b.xml')).length, 5007);
  assert.equal(await O.zipRead(entries, 'missing'), null);
});

test('rejects non-ZIP, encrypted and oversized archives', async () => {
  assert.throws(() => O.zipEntries(new ArrayBuffer(10)), /not-zip/);
  assert.throws(() => O.zipEntries(makeZip([{ name: 'x', data: 'x', flags: 1 }])), /encrypted/);
  assert.throws(() => O.zipEntries(makeZip([{ name: 'x', data: 'x', size: 60 * 1024 * 1024 }])), /too-large/);
});

test('a lying size header cannot inflate past the declared size', async () => {
  const entries = O.zipEntries(makeZip([{ name: 'bomb', data: 'z'.repeat(100000), size: 10 }]));
  await assert.rejects(O.zipRead(entries, 'bomb'), /bad-zip/);
});

test('relationship targets resolve against the owning folder', () => {
  assert.equal(O.resolvePart('xl', 'worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
  assert.equal(O.resolvePart('ppt/slides', '../media/image1.png'), 'ppt/media/image1.png');
  assert.equal(O.resolvePart('xl', '/xl/worksheets/sheet2.xml'), 'xl/worksheets/sheet2.xml');
  assert.equal(O.resolvePart('ppt/slides', '../../../../etc/passwd'), 'etc/passwd', 'cannot climb above the archive root');
});

test('Excel cell references and column names', () => {
  assert.deepEqual(O.cellRef('A1'), { col: 0, row: 0 });
  assert.deepEqual(O.cellRef('BC12'), { col: 54, row: 11 });
  assert.equal(O.cellRef('1A'), null);
  assert.equal(O.colName(0), 'A');
  assert.equal(O.colName(25), 'Z');
  assert.equal(O.colName(26), 'AA');
  assert.equal(O.colName(54), 'BC');
});

test('Excel date formats and serials', () => {
  assert.equal(O.isDateFormat(14, null), true);
  assert.equal(O.isDateFormat(0, null), false);
  assert.equal(O.isDateFormat(164, 'yyyy/mm/dd'), true);
  assert.equal(O.isDateFormat(165, '#,##0.00'), false);
  assert.equal(O.isDateFormat(166, '"Day"0'), false, 'quoted letters are not date codes');
  assert.equal(O.excelDate(44927, false), '2023-01-01');
  assert.equal(O.excelDate(44927.5, false), '2023-01-01 12:00');
  assert.equal(O.excelDate(0, true), '1904-01-01');
});

test('Excel numbers drop float noise', () => {
  assert.equal(O.excelNumber('0.30000000000000004'), '0.3');
  assert.equal(O.excelNumber('42'), '42');
  assert.equal(O.excelNumber('abc'), 'abc');
});
