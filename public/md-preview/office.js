// Office previews: .xlsx, .docx, .pptx. Runs inside the sandboxed preview frame
// (no same-origin, strict CSP). Files are ZIP archives of XML; the ZIP is read
// here with the browser's own DecompressionStream, so no third-party code
// touches the bytes except mammoth (BSD-2-Clause) for .docx, whose HTML is
// sanitised before use. Macros and embedded objects are never run or shown.
(function () {
  'use strict';

  // ── Limits (zip bombs, huge workbooks) ──
  const MAX_ENTRIES = 5000;
  const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
  const MAX_ROWS = 2000;
  const MAX_COLS = 200;
  const MAX_SLIDES = 300;
  const MAX_SLIDE_IMAGES = 12;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  // ── ZIP (central directory) ──
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  // Pure: lists the entries of a ZIP archive. Throws on anything malformed.
  function zipEntries(buffer) {
    const b = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not-zip');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    if (count > MAX_ENTRIES) throw new Error('too-many-entries');
    const entries = new Map();
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('bad-zip');
      const flags = u16(b, p + 8);
      const method = u16(b, p + 10);
      const compressed = u32(b, p + 20);
      const size = u32(b, p + 24);
      const nameLen = u16(b, p + 28);
      const extraLen = u16(b, p + 30);
      const commentLen = u16(b, p + 32);
      const local = u32(b, p + 42);
      const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 1) throw new Error('encrypted');
      if (local + 30 > b.length || u32(b, local) !== 0x04034b50) throw new Error('bad-zip');
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
      if (start + compressed > b.length) throw new Error('bad-zip');
      total += size;
      if (size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new Error('too-large');
      entries.set(name, { method, size, data: b.subarray(start, start + compressed) });
    }
    return entries;
  }

  // Inflates one entry; stops at its declared size (a lying header can't blow up memory).
  async function zipRead(entries, name) {
    const e = entries.get(name);
    if (!e) return null;
    if (e.method === 0) return e.data;
    if (e.method !== 8) throw new Error('unsupported-compression');
    const stream = new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const out = new Uint8Array(e.size);
    let off = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (off + value.length > e.size) { await reader.cancel(); throw new Error('bad-zip'); }
      out.set(value, off);
      off += value.length;
    }
    return out.subarray(0, off);
  }

  async function zipText(entries, name) {
    const bytes = await zipRead(entries, name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async function zipXml(entries, name) {
    const text = await zipText(entries, name);
    if (text == null) return null;
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('bad-xml');
    return doc;
  }

  const all = (node, local) => node ? Array.from(node.getElementsByTagNameNS('*', local)) : [];
  const first = (node, local) => all(node, local)[0] || null;
  const attr = (el, name) => (el && (el.getAttribute(name) || el.getAttributeNS && el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name.replace(/^r:/, '')))) || '';

  // Pure: resolves a relationship Target against the folder of the part that owns it.
  function resolvePart(baseDir, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
    const out = [];
    for (const s of parts) {
      if (s === '..') out.pop();
      else if (s && s !== '.') out.push(s);
    }
    return out.join('/');
  }

  async function relationships(entries, relsPath, baseDir) {
    const doc = await zipXml(entries, relsPath);
    const map = new Map();
    for (const r of all(doc, 'Relationship')) {
      if (r.getAttribute('TargetMode') === 'External') continue; // never follow external links
      map.set(r.getAttribute('Id'), resolvePart(baseDir, r.getAttribute('Target') || ''));
    }
    return map;
  }

  // ── Excel ──

  // Pure: "BC12" → { col: 54, row: 11 } (both zero-based).
  function cellRef(ref) {
    const m = /^([A-Z]{1,3})(\d+)$/.exec(ref || '');
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { col: col - 1, row: Number(m[2]) - 1 };
  }

  // Pure: zero-based column index → letters.
  function colName(i) {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // Pure: is this number format a date/time? Built-in ids 14–22 and 45–47, or a
  // custom code with d/m/y/h/s outside quotes, brackets and colour tags.
  function isDateFormat(id, code) {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    if (!code) return false;
    const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
  }

  // Pure: Excel serial → "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".
  function excelDate(serial, date1904) {
    if (!Number.isFinite(serial)) return '';
    let days = Math.floor(serial);
    const frac = serial - days;
    if (!date1904 && days >= 60) days -= 1; // Excel's fictitious 1900-02-29
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const d = new Date(base + days * 86400000);
    const pad = n => String(n).padStart(2, '0');
    let s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const mins = Math.round(frac * 1440);
    if (mins > 0 && mins < 1440) s += ` ${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    return s;
  }

  // Pure: a stored number as people expect to read it (no float noise).
  function excelNumber(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15)));
  }

  const siText = si => all(si, 't').filter(t => !(t.parentNode && t.parentNode.localName === 'rPh')).map(t => t.textContent).join('');

  async function readXlsx(buffer) {
    const entries = zipEntries(buffer);
    const wb = await zipXml(entries, 'xl/workbook.xml');
    if (!wb) throw new Error('not-xlsx');
    const date1904 = /^(1|true)$/i.test((first(wb, 'workbookPr') || { getAttribute: () => '' }).getAttribute('date1904') || '');
    const rels = await relationships(entries, 'xl/_rels/workbook.xml.rels', 'xl');
    const ssDoc = await zipXml(entries, 'xl/sharedStrings.xml');
    const shared = ssDoc ? all(ssDoc, 'si').map(siText) : [];
    const stDoc = await zipXml(entries, 'xl/styles.xml');
    const fmtCodes = new Map(all(stDoc, 'numFmt').map(f => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode')]));
    const xfs = first(stDoc, 'cellXfs');
    const dateStyle = xfs ? Array.from(xfs.children).map(xf => {
      const id = Number(xf.getAttribute('numFmtId') || 0);
      return isDateFormat(id, fmtCodes.get(id));
    }) : [];

    const sheets = [];
    for (const s of all(wb, 'sheet')) {
      const name = s.getAttribute('name') || `Sheet${sheets.length + 1}`;
      const target = rels.get(attr(s, 'r:id'));
      const doc = target ? await zipXml(entries, target) : null;
      const rows = [];
      let truncatedRows = false;
      let truncatedCols = false;
      let width = 0;
      for (const row of all(doc, 'row')) {
        const r = Number(row.getAttribute('r') || rows.length + 1) - 1;
        if (r >= MAX_ROWS) { truncatedRows = true; break; }
        let next = 0;
        for (const c of all(row, 'c')) {
          const ref = cellRef(c.getAttribute('r'));
          const col = ref ? ref.col : next;
          next = col + 1;
          if (col >= MAX_COLS) { truncatedCols = true; continue; }
          const t = c.getAttribute('t') || 'n';
          const v = first(c, 'v');
          let text = '';
          let num = false;
          if (t === 's') text = shared[Number(v && v.textContent)] || '';
          else if (t === 'inlineStr') text = siText(first(c, 'is'));
          else if (t === 'b') text = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
          else if (t === 'str' || t === 'e') text = v ? v.textContent : '';
          else if (v) {
            const style = Number(c.getAttribute('s') || 0);
            if (dateStyle[style]) text = excelDate(Number(v.textContent), date1904);
            else { text = excelNumber(v.textContent); num = true; }
          }
          if (!text) continue;
          while (rows.length <= r) rows.push([]);
          rows[r][col] = { text, num };
          width = Math.max(width, col + 1);
        }
      }
      sheets.push({ name, rows, width, truncatedRows, truncatedCols });
    }
    return sheets;
  }

  // ── PowerPoint ──
  const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function readPptx(buffer) {
    const entries = zipEntries(buffer);
    const pres = await zipXml(entries, 'ppt/presentation.xml');
    if (!pres) throw new Error('not-pptx');
    const rels = await relationships(entries, 'ppt/_rels/presentation.xml.rels', 'ppt');
    const slides = [];
    const ids = all(pres, 'sldId');
    for (const sid of ids.slice(0, MAX_SLIDES)) {
      const path = rels.get(attr(sid, 'r:id'));
      const doc = path ? await zipXml(entries, path) : null;
      if (!doc) continue;
      const dir = path.split('/').slice(0, -1).join('/');
      const file = path.split('/').pop();
      const srels = await relationships(entries, `${dir}/_rels/${file}.rels`, dir);
      let title = '';
      const blocks = [];
      for (const sp of all(doc, 'sp')) {
        const ph = first(sp, 'ph');
        const type = ph ? ph.getAttribute('type') : '';
        const paras = all(sp, 'p').filter(p => p.namespaceURI && /drawingml/.test(p.namespaceURI))
          .map(p => ({ text: all(p, 't').map(t => t.textContent).join(''), level: Number((first(p, 'pPr') || { getAttribute: () => 0 }).getAttribute('lvl') || 0) }))
          .filter(p => p.text.trim());
        if (!paras.length) continue;
        if (!title && (type === 'title' || type === 'ctrTitle')) title = paras.map(p => p.text).join(' ');
        else blocks.push(paras);
      }
      for (const tbl of all(doc, 'tbl')) {
        blocks.push({ table: all(tbl, 'tr').map(tr => all(tr, 'tc').map(tc => all(tc, 't').map(t => t.textContent).join(''))) });
      }
      const images = [];
      for (const blip of all(doc, 'blip')) {
        if (images.length >= MAX_SLIDE_IMAGES) break;
        const target = srels.get(attr(blip, 'r:embed'));
        const ext = target ? target.split('.').pop().toLowerCase() : '';
        const e = target && entries.get(target);
        if (!IMAGE_TYPES[ext] || !e || e.size > MAX_IMAGE_BYTES) continue;
        const bytes = await zipRead(entries, target);
        images.push(`data:${IMAGE_TYPES[ext]};base64,${base64(bytes)}`);
      }
      slides.push({ title, blocks, images });
    }
    return { slides, total: ids.length };
  }

  // ── Word (mammoth) and HTML sanitising ──
  const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'a', 'img', 'br', 'blockquote', 'pre', 'code', 'span', 'hr']);

  // Keeps only safe tags/attributes: links http(s)/mailto/#, images data:image (raster).
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const walk = node => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) continue;
        if (child.nodeType !== 1) { child.remove(); continue; }
        const tag = child.localName;
        if (!ALLOWED.has(tag)) {
          if (/^(script|style|iframe|object|embed|svg|math|form|link|meta)$/.test(tag)) { child.remove(); continue; }
          walk(child);
          child.replaceWith(...Array.from(child.childNodes));
          continue;
        }
        for (const a of Array.from(child.attributes)) {
          const v = a.value;
          const keep = (tag === 'a' && a.name === 'href' && /^(https?:|mailto:|#)/i.test(v.trim())) ||
            (tag === 'img' && a.name === 'src' && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(v)) ||
            (tag === 'img' && a.name === 'alt') ||
            ((tag === 'td' || tag === 'th') && /^(colspan|rowspan)$/.test(a.name) && /^\d{1,3}$/.test(v)) ||
            (a.name === 'id' && /^[\w-]{1,64}$/.test(v));
          if (!keep) child.removeAttribute(a.name);
        }
        if (tag === 'a' && /^https?:|^mailto:/i.test(child.getAttribute('href') || '')) {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        walk(child);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('script'));
      document.head.appendChild(s);
    });
  }

  async function readDocx(buffer, base) {
    if (!window.mammoth) await loadScript(`${base}vendor/mammoth.browser.min.js`);
    const result = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
    return sanitize(result.value || '');
  }

  const api = { zipEntries, zipRead, resolvePart, cellRef, colName, isDateFormat, excelDate, excelNumber, sanitize, readXlsx, readPptx, readDocx };
  if (typeof window !== 'undefined') window.MMRTLOffice = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
