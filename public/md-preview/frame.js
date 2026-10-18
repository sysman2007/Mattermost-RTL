// Mattermost RTL — Markdown preview renderer.
// Runs inside a sandboxed iframe (opaque origin: no cookies, no Mattermost API,
// no access to the parent page). The parent posts the file text once; this
// script renders it with per-block Persian/English direction, PrismJS
// highlighting and Mermaid diagrams.
//
// Markdown parsing and the Persian-label Mermaid tuning are adapted from
// Maestro Markdown Viewer (Apache-2.0), with security changes for rendering
// files uploaded by other users: raw HTML is reduced to an allowlist, link and
// image URLs are limited to safe schemes, and Mermaid runs with
// securityLevel 'strict'.
(() => {
  'use strict';

  const BASE = ((typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '').replace(/[^/]*$/, '');
  const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const unescapeHtml = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));

  // ── URL policy ──
  function safeHref(raw) {
    const h = unescapeHtml(raw).trim();
    if (h.startsWith('#')) return h;
    return /^(https?:|mailto:)/i.test(h) ? h : null;
  }
  function safeImgSrc(raw) {
    const s = unescapeHtml(raw).trim();
    return /^https?:/i.test(s) || /^data:image\/(png|gif|jpe?g|webp);/i.test(s) ? s : null;
  }

  // ── raw HTML lines: allowlist of layout tags with dir/align/lang only ──
  const HTML_BLOCK = /^\s*(?:<\/?[a-zA-Z][^>]*>\s*)+$/;
  const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'br', 'hr', 'center', 'details', 'summary', 'sub', 'sup', 'kbd', 'b', 'i', 'u', 'strong', 'em']);
  const ALLOWED_ATTRS = new Set(['dir', 'align', 'lang']);
  function sanitizeHtmlLine(line) {
    return line.trim().replace(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g, (whole, close, tag, rest) => {
      tag = tag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return escapeHtml(whole);
      if (close) return `</${tag}>`;
      const attrs = [];
      rest.replace(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g, (_, name, __, a, b, c) => {
        name = name.toLowerCase();
        const v = a ?? b ?? c ?? '';
        if (ALLOWED_ATTRS.has(name) && /^[\w-]{1,20}$/.test(v)) attrs.push(` ${name}="${v}"`);
      });
      return `<${tag}${attrs.join('')}>`;
    });
  }

  const slugify = (s, i) => (String(s).replace(/<[^>]+>/g, '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-') || `section-${i}`);

  function inline(md) {
    let s = escapeHtml(md);
    const stash = [];
    const keep = html => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
    s = s.replace(/`([^`]+)`/g, (_, x) => keep(`<code>${x}</code>`));
    s = s.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_, alt, src, title) => {
      const ok = safeImgSrc(src);
      return ok ? keep(`<img src="${escapeHtml(ok)}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy" referrerpolicy="no-referrer">`) : alt;
    });
    s = s.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_, text, href, title) => {
      const h = safeHref(href);
      if (!h) return text;
      const cls = h.startsWith('#') ? ' class="anchor-link"' : '';
      return keep(`<a href="${escapeHtml(h)}"${title ? ` title="${title}"` : ''}${cls}>${text}</a>`);
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/ {2}\n/g, '<br>');
    // Restore repeatedly: a link label may itself contain stashed code.
    for (let n = 0; n < 3 && s.includes('\u0000'); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
    return s;
  }

  const LANG_ALIASES = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', cs: 'csharp', 'c#': 'csharp', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'shell-session', yml: 'yaml', html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', md: 'markdown', mdx: 'markdown', ps1: 'powershell', pwsh: 'powershell', dockerfile: 'docker', 'c++': 'cpp', golang: 'go', rs: 'rust', kt: 'kotlin', bat: 'batch', cmd: 'batch' };

  function parse(md) {
    md = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lines = md.split('\n'), out = [], headings = [];
    const seen = new Map();
    let i = 0, hIndex = 0;
    const pushHeading = (level, text) => {
      hIndex++;
      const base = slugify(text, hIndex), n = seen.get(base) || 0;
      seen.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      headings.push({ level, text: text.replace(/[*_`]/g, ''), id });
      return id;
    };
    const blockStart = /^(#{1,6}\s|```|~~~|>\s?|\s*[-+*]\s+|\s*\d+[.)]\s+)/;
    while (i < lines.length) {
      const l = lines[i];
      if (/^```|^~~~/.test(l)) {
        const fence = l.match(/^(```+|~~~+)\s*([^\s]*)/), mark = fence[1], rawLang = (fence[2] || '').toLowerCase();
        const lang = LANG_ALIASES[rawLang] || rawLang || 'text';
        i++;
        const buf = [];
        while (i < lines.length && !lines[i].startsWith(mark)) buf.push(lines[i++]);
        i++;
        const code = buf.join('\n');
        if (lang === 'mermaid') {
          out.push(`<figure class="mermaid-card"><div class="mermaid-render" data-source="${escapeHtml(encodeURIComponent(code))}"></div><details class="mermaid-source"><summary>Mermaid</summary><pre class="code-scroll"><code class="language-text">${escapeHtml(code)}</code></pre></details></figure>`);
        } else {
          const count = Math.max(1, code.split('\n').length);
          const gutter = Array.from({ length: count }, (_, n) => n + 1).join('\n');
          out.push(`<figure class="code-card"><div class="code-head"><span class="language-label">${escapeHtml(rawLang || 'text')}</span><button type="button" class="copy-code">Copy</button></div><div class="code-body"><pre class="code-gutter" aria-hidden="true">${gutter}</pre><pre class="code-scroll"><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre></div></figure>`);
        }
        continue;
      }
      const h = l.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        const level = h[1].length, text = h[2].replace(/\s+#+\s*$/, '');
        out.push(`<h${level} id="${escapeHtml(pushHeading(level, text))}">${inline(text)}</h${level}>`);
        i++;
        continue;
      }
      if (i + 1 < lines.length && l.trim() && !HTML_BLOCK.test(l) && /^=+\s*$/.test(lines[i + 1])) {
        out.push(`<h1 id="${escapeHtml(pushHeading(1, l))}">${inline(l)}</h1>`); i += 2; continue;
      }
      if (i + 1 < lines.length && l.trim() && !HTML_BLOCK.test(l) && /^-{2,}\s*$/.test(lines[i + 1])) {
        out.push(`<h2 id="${escapeHtml(pushHeading(2, l))}">${inline(l)}</h2>`); i += 2; continue;
      }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (HTML_BLOCK.test(l)) { out.push(sanitizeHtmlLine(l)); i++; continue; }
      if (/^>\s?/.test(l)) {
        const b = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) b.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${b.map(x => `<p>${inline(x)}</p>`).join('')}</blockquote>`);
        continue;
      }
      if (/^\s*[-+*]\s+/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*[-+*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-+*]\s+/, ''));
        out.push(`<ul>${items.map(x => {
          const task = x.match(/^\[( |x|X)\]\s+(.*)$/);
          return task ? `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2])}</li>` : `<li>${inline(x)}</li>`;
        }).join('')}</ul>`);
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push(`<ol>${items.map(x => `<li>${inline(x)}</li>`).join('')}</ol>`);
        continue;
      }
      if (/^\|?.+\|.+\|?\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const split = x => x.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = split(l);
        const aligns = split(lines[i + 1]).map(x => x.startsWith(':') && x.endsWith(':') ? 'center' : x.endsWith(':') ? 'right' : x.startsWith(':') ? 'left' : '');
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(split(lines[i++]));
        const cell = (tag, c, n) => `<${tag}${aligns[n] ? ` style="text-align:${aligns[n]}"` : ''}>${inline(c)}</${tag}>`;
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, n) => cell('td', c, n)).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const p = [l];
      i++;
      while (i < lines.length && lines[i].trim() && !HTML_BLOCK.test(lines[i]) && !blockStart.test(lines[i])) p.push(lines[i++]);
      out.push(`<p>${inline(p.join('\n'))}</p>`);
    }
    return { html: out.join('\n'), headings };
  }

  // ── direction: every block decides for itself (Persian letter → RTL) ──
  function directionize(root) {
    root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,summary').forEach(el => {
      const text = el.textContent.trim();
      if (!text) return;
      el.dir = RTL_RE.test(text) ? 'rtl' : 'ltr';
    });
    root.querySelectorAll('pre,code,kbd').forEach(el => { el.dir = 'ltr'; });
  }

  function highlightCode(root) {
    if (!window.Prism) return;
    root.querySelectorAll('pre code[class*="language-"]').forEach(code => {
      const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1];
      if (!lang || !Prism.languages[lang]) return;
      try { Prism.highlightElement(code, false); } catch (e) { /* leave plain */ }
    });
  }

  // ── Mermaid (loaded only when the file has a diagram) ──
  const cssVar = n => getComputedStyle(document.body).getPropertyValue(n).trim();

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(true);
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = `${BASE}vendor/mermaid.min.js`;
      s.onload = () => resolve(Boolean(window.mermaid));
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  function configureMermaid() {
    const surface = cssVar('--surface'), surface2 = cssVar('--surface2'), text = cssVar('--text'),
      border = cssVar('--border'), accent = cssVar('--accent'), muted = cssVar('--muted'), bg = cssVar('--bg');
    const font = 'system-ui, "Segoe UI", Vazirmatn, Tahoma, sans-serif';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: font,
      fontSize: 15,
      maxTextSize: 200000,
      themeVariables: {
        fontFamily: font, fontSize: '15px',
        background: surface, mainBkg: surface2, primaryColor: surface2, primaryTextColor: text,
        primaryBorderColor: accent, secondaryColor: bg, secondaryTextColor: text, secondaryBorderColor: border,
        tertiaryColor: bg, tertiaryTextColor: text, tertiaryBorderColor: border,
        lineColor: muted, textColor: text, nodeBorder: accent, nodeTextColor: text,
        clusterBkg: bg, clusterBorder: border, titleColor: text,
        edgeLabelBackground: surface, labelBackground: surface, labelColor: text,
        labelTextColor: text, classText: text, stateLabelColor: text,
        actorBkg: surface2, actorBorder: accent, actorTextColor: text,
        noteBkgColor: surface2, noteTextColor: text, noteBorderColor: border,
        transitionColor: muted, altBackground: bg, compositeBackground: bg,
        compositeBorder: border, stateBkg: surface2
      },
      // generous spacing so multi-line Persian labels never collide
      flowchart: { htmlLabels: true, useMaxWidth: true, curve: 'basis', diagramPadding: 18, nodeSpacing: 64, rankSpacing: 92, padding: 18, wrappingWidth: 320 },
      state: { useMaxWidth: true, nodeSpacing: 64, rankSpacing: 92, padding: 14 },
      sequence: { useMaxWidth: true, wrap: true, width: 170 }
    });
  }

  // Mermaid joins label lines with <br>, so a Persian first line flips later
  // mixed lines such as "OwnerId = خریدار". Give each line its own bidi block.
  function isolateLabelLines(svg) {
    const withBr = [...svg.querySelectorAll('foreignObject *')].filter(n => n.querySelector(':scope > br'));
    for (const n of withBr) {
      const parts = [];
      let cur = document.createElement('span');
      for (const child of [...n.childNodes]) {
        if (child.nodeName === 'BR') { parts.push(cur); cur = document.createElement('span'); } else cur.appendChild(child);
      }
      parts.push(cur);
      n.textContent = '';
      for (const p of parts) { p.className = 'mmd-line'; n.appendChild(p); }
    }
  }

  let mermaidSeq = 0;
  async function renderMermaid(root) {
    const targets = [...root.querySelectorAll('.mermaid-render')];
    if (!targets.length) return;
    if (!(await loadMermaid())) {
      targets.forEach(el => { el.closest('.mermaid-card').querySelector('details').open = true; });
      return;
    }
    try { configureMermaid(); } catch (e) { return; }
    for (const el of targets) {
      const source = decodeURIComponent(el.dataset.source || '');
      try {
        const { svg } = await mermaid.render(`mmrtl-mmd-${++mermaidSeq}`, source);
        el.innerHTML = svg;
        const s = el.querySelector('svg');
        if (s) { isolateLabelLines(s); s.style.maxWidth = '100%'; s.style.height = 'auto'; }
      } catch (e) {
        el.closest('.mermaid-card').querySelector('details').open = true;
        el.textContent = String(e && e.message || e).slice(0, 300);
        el.classList.add('diagram-error');
      }
      document.querySelectorAll('body > div[id^="dmmrtl-mmd-"]').forEach(n => n.remove());
    }
  }

  // ── links: anchors scroll in place, external links open in a new tab,
  // nothing ever navigates this frame ──
  function wireLinks(root) {
    root.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a) {
        e.preventDefault();
        const href = a.getAttribute('href') || '';
        if (href.startsWith('#')) {
          let id = href.slice(1);
          try { id = decodeURIComponent(id); } catch (err) { /* keep raw */ }
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (/^(https?:|mailto:)/i.test(href)) {
          window.open(href, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      const btn = e.target.closest('.copy-code');
      if (btn) copyText(btn.closest('.code-card').querySelector('code').textContent, btn);
    });
  }

  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      try { ok = document.execCommand('copy'); } catch (err) { /* blocked */ }
      t.remove();
    }
    const label = btn.textContent;
    btn.textContent = ok ? '✓' : '✗';
    setTimeout(() => { btn.textContent = label; }, 1200);
  }

  async function loadFont(buf) {
    if (!buf || typeof FontFace !== 'function') return;
    try {
      const face = new FontFace('Vazirmatn', buf);
      document.fonts.add(await face.load());
    } catch (e) { /* system fallback */ }
  }

  // ── CSV / TSV ──
  const MAX_TABLE_ROWS = 2000;

  // Delimiter: the candidate that occurs most often (outside quotes) in the
  // first non-empty line. TSV files always use tabs.
  function detectDelimiter(text, ext) {
    if (/^tsv$/i.test(ext || '')) return '\t';
    const line = (text.split('\n').find(l => l.trim()) || '').replace(/"[^"]*"/g, '');
    let best = ',', count = 0;
    for (const d of [',', ';', '\t', '|']) {
      const n = line.split(d).length - 1;
      if (n > count) { best = d; count = n; }
    }
    return best;
  }

  // RFC 4180: quoted fields may contain the delimiter, newlines and "" escapes.
  function parseCsv(text, delim, maxRows = MAX_TABLE_ROWS) {
    text = String(text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', quoted = false, i = 0, truncated = false;
    const endRow = () => {
      row.push(field); field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    };
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { quoted = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++;
        endRow();
        if (rows.length > maxRows) { truncated = true; break; }
        continue;
      }
      field += c; i++;
    }
    if (!truncated && (field !== '' || row.length)) endRow();
    if (rows.length > maxRows) { rows.length = maxRows; truncated = true; }
    return { rows, truncated };
  }

  const NUMERIC = /^[-+]?[\d\u06F0-\u06F9\u0660-\u0669][\d\u06F0-\u06F9\u0660-\u0669,.\u066B\u066C٬٫]*%?$/;

  function renderCsv(text, ext) {
    const delim = detectDelimiter(text, ext);
    const { rows, truncated } = parseCsv(text, delim);
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const [head = [], ...body] = rows;
    const cell = (tag, v) => {
      // Numbers (including Persian digits) stay LTR; otherwise any Persian letter → RTL.
      const isNum = NUMERIC.test(v.trim());
      const dir = !isNum && RTL_RE.test(v) ? 'rtl' : 'ltr';
      return `<${tag} dir="${dir}"${isNum ? ' class="num"' : ''}>${escapeHtml(v)}</${tag}>`;
    };
    const pad = r => r.concat(Array(Math.max(0, cols - r.length)).fill(''));
    const delimName = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delim];
    return `<div class="data-info" dir="ltr">${body.length} rows × ${cols} columns · ${delimName}-separated` +
      (truncated ? ` · <strong>showing the first ${MAX_TABLE_ROWS} rows</strong>` : '') + '</div>' +
      `<div class="table-wrap data-table"><table><thead><tr><th class="rownum">#</th>${pad(head).map(v => cell('th', v)).join('')}</tr></thead>` +
      `<tbody>${body.map((r, n) => `<tr><td class="rownum">${n + 1}</td>${pad(r).map(v => cell('td', v)).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  // ── JSON ──
  const MAX_HIGHLIGHT = 512 * 1024;

  function renderJson(text) {
    text = String(text).replace(/^\uFEFF/, '');
    let value, error = null;
    try { value = JSON.parse(text); } catch (e) { error = e.message; }
    if (error) {
      return `<div class="data-info data-error" dir="ltr">Invalid JSON: ${escapeHtml(error)}</div>` +
        `<figure class="code-card"><div class="code-body"><pre class="code-scroll"><code class="language-text">${escapeHtml(text)}</code></pre></div></figure>`;
    }
    const pretty = JSON.stringify(value, null, 2);
    const kind = Array.isArray(value) ? `array · ${value.length} items` : value && typeof value === 'object' ? `object · ${Object.keys(value).length} keys` : typeof value;
    const lines = pretty.split('\n').length;
    const lang = pretty.length > MAX_HIGHLIGHT ? 'text' : 'json';
    return `<div class="data-info" dir="ltr">${escapeHtml(kind)} · ${lines} lines</div>` +
      `<figure class="code-card"><div class="code-head"><span class="language-label">json</span><button type="button" class="copy-code">Copy</button></div>` +
      `<div class="code-body"><pre class="code-scroll"><code class="language-${lang}">${escapeHtml(pretty)}</code></pre></div></figure>`;
  }

  // ── Source code files (Prism) ──
  const MAX_CODE_HIGHLIGHT = 512 * 1024;

  function renderCode(text, lang, name) {
    text = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const count = Math.max(1, text.split('\n').length);
    const gutter = Array.from({ length: count }, (_, n) => n + 1).join('\n');
    const useLang = text.length > MAX_CODE_HIGHLIGHT || !(window.Prism && Prism.languages[lang]) ? 'text' : lang;
    return `<div class="data-info" dir="ltr">${escapeHtml(lang)} · ${count} lines</div>` +
      `<figure class="code-card"><div class="code-head"><span class="language-label">${escapeHtml(name || lang)}</span><button type="button" class="copy-code">Copy</button></div>` +
      `<div class="code-body"><pre class="code-gutter" aria-hidden="true">${gutter}</pre><pre class="code-scroll"><code class="language-${escapeHtml(useLang)}">${escapeHtml(text)}</code></pre></div></figure>`;
  }

  // ── HTML files: the page itself, with its scripts blocked ──
  // The page is shown in a nested iframe with an empty sandbox (no scripts, no
  // same-origin, no navigation) and a CSP that allows only images, styles and
  // fonts. The CSP meta goes right after the doctype so it applies from the top
  // of the document and doesn't change the parsing mode.
  const HTML_PAGE_CSP = "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:; media-src data: http: https:";

  function htmlSrcdoc(text) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PAGE_CSP}">`;
    const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(text);
    return doctype ? doctype[0] + meta + text.slice(doctype[0].length) : meta + text;
  }

  function renderHtmlFile(text, name) {
    const article = document.createElement('article');
    article.id = 'content';
    article.className = 'html-view';
    const tabs = document.createElement('div');
    tabs.className = 'html-tabs';
    tabs.setAttribute('role', 'tablist');
    const preview = document.createElement('div');
    preview.className = 'html-panel';
    const source = document.createElement('div');
    source.className = 'html-panel';
    source.hidden = true;

    const frame = document.createElement('iframe');
    frame.className = 'html-preview-frame';
    frame.setAttribute('sandbox', '');
    frame.setAttribute('title', name || 'HTML');
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = htmlSrcdoc(text);
    preview.appendChild(frame);
    source.innerHTML = renderCode(text, 'markup', name);

    const tab = (label, panel) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'html-tab';
      b.setAttribute('role', 'tab');
      b.textContent = label;
      b.addEventListener('click', () => {
        for (const [btn, p] of pairs) {
          const on = btn === b;
          btn.setAttribute('aria-selected', String(on));
          btn.classList.toggle('active', on);
          p.hidden = !on;
        }
      });
      return b;
    };
    const pairs = [[tab('پیش‌نمایش HTML', preview), preview], [tab('کد', source), source]];
    pairs[0][0].setAttribute('aria-selected', 'true');
    pairs[0][0].classList.add('active');
    pairs[1][0].setAttribute('aria-selected', 'false');
    tabs.append(pairs[0][0], pairs[1][0]);

    article.append(tabs, preview, source);
    document.body.textContent = '';
    document.body.appendChild(article);
    highlightCode(source);
    wireLinks(article);
  }

  // ── Office (.xlsx, .docx, .pptx): parsed by office.js, loaded only for these files ──
  function loadOffice() {
    if (window.MMRTLOffice) return Promise.resolve(window.MMRTLOffice);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${BASE}office.js`;
      s.onload = () => (window.MMRTLOffice ? resolve(window.MMRTLOffice) : reject(new Error('office')));
      s.onerror = () => reject(new Error('office'));
      document.head.appendChild(s);
    });
  }

  function h(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (v != null) n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  const dirOf = text => (RTL_RE.test(text) ? 'rtl' : 'ltr');

  function xlsxView(O, sheets) {
    const wrap = h('div', {});
    const tabs = h('div', { className: 'office-tabs', role: 'tablist' });
    const panel = h('div', {});
    const show = i => {
      const sh = sheets[i];
      for (const [j, t] of Array.from(tabs.children).entries()) t.setAttribute('aria-selected', String(j === i));
      const cols = Math.max(1, sh.width);
      const info = `${sh.rows.length} rows × ${cols} columns` +
        (sh.truncatedRows ? ' · showing the first 2000 rows' : '') + (sh.truncatedCols ? ' · showing the first 200 columns' : '');
      const head = h('tr', {}, h('th', { className: 'rownum' }, '#'));
      for (let c = 0; c < cols; c++) head.append(h('th', { dir: 'ltr' }, O.colName(c)));
      const body = h('tbody', {});
      sh.rows.forEach((row, r) => {
        const tr = h('tr', {}, h('td', { className: 'rownum' }, String(r + 1)));
        for (let c = 0; c < cols; c++) {
          const cell = row && row[c];
          const td = h('td', cell ? { dir: cell.num ? 'ltr' : dirOf(cell.text), className: cell.num ? 'num' : null } : {});
          if (cell) td.textContent = cell.text;
          tr.append(td);
        }
        body.append(tr);
      });
      panel.replaceChildren(h('div', { className: 'data-info', dir: 'ltr' }, info),
        h('div', { className: 'table-wrap data-table' }, h('table', {}, h('thead', {}, head), body)));
    };
    sheets.forEach((sh, i) => {
      const t = h('button', { type: 'button', role: 'tab', className: 'office-tab', dir: 'auto' }, sh.name);
      t.addEventListener('click', () => show(i));
      tabs.append(t);
    });
    if (sheets.length > 1) wrap.append(tabs);
    wrap.append(panel);
    if (sheets.length) show(0); else panel.append(h('div', { className: 'data-info' }, 'Empty workbook'));
    return wrap;
  }

  function pptxView(deck) {
    const wrap = h('div', { className: 'slides' });
    deck.slides.forEach((sl, i) => {
      const card = h('section', { className: 'slide' }, h('div', { className: 'slide-no', dir: 'ltr' }, `${i + 1} / ${deck.total}`));
      if (sl.title) card.append(h('h2', { dir: dirOf(sl.title) }, sl.title));
      for (const b of sl.blocks) {
        if (b.table) {
          const tb = h('tbody', {});
          for (const row of b.table) tb.append(h('tr', {}, ...row.map(c => h('td', { dir: dirOf(c) }, c))));
          card.append(h('div', { className: 'table-wrap' }, h('table', {}, tb)));
          continue;
        }
        const ul = h('ul', {});
        for (const p of b) ul.append(h('li', { dir: dirOf(p.text), style: p.level ? `margin-inline-start:${Math.min(p.level, 6) * 18}px` : null }, p.text));
        card.append(ul);
      }
      if (sl.images.length) card.append(h('div', { className: 'slide-images' }, ...sl.images.map(src => h('img', { src, alt: '' }))));
      if (!sl.title && !sl.blocks.length && !sl.images.length) card.append(h('p', { className: 'muted' }, 'No text or images on this slide.'));
      wrap.append(card);
    });
    if (deck.total > deck.slides.length) wrap.append(h('div', { className: 'data-info' }, `Showing the first ${deck.slides.length} of ${deck.total} slides`));
    return wrap;
  }

  async function renderOffice(kind, buffer, name) {
    const article = h('article', { id: 'content', className: `data-view office office-${kind}` });
    document.body.replaceChildren(article);
    article.append(h('div', { className: 'data-info office-note' }, 'Content preview: Office layout, fonts and effects may differ. Macros and embedded objects are never run.'));
    try {
      const O = await loadOffice();
      if (kind === 'xlsx') article.append(xlsxView(O, await O.readXlsx(buffer)));
      else if (kind === 'pptx') article.append(pptxView(await O.readPptx(buffer)));
      else {
        const doc = h('div', { className: 'docx' });
        doc.innerHTML = await O.readDocx(buffer, BASE); // sanitised in office.js
        for (const el of doc.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote')) el.setAttribute('dir', 'auto');
        article.append(doc);
        wireLinks(article);
      }
    } catch (err) {
      const msg = { encrypted: 'This file is password-protected.', 'too-large': 'This file is too large to preview.' }[err && err.message] || 'This file could not be previewed. Download it to open it in Office.';
      article.append(h('div', { className: 'office-error', role: 'alert' }, msg));
    }
  }

  async function render({ md, kind, ext, lang, name, theme, font }) {
    document.body.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    await loadFont(font);
    if (kind === 'xlsx' || kind === 'docx' || kind === 'pptx') return renderOffice(kind, md, name);
    if (kind === 'html') return renderHtmlFile(String(md || ''), name);
    if (kind === 'csv' || kind === 'json' || kind === 'code') {
      const article = document.createElement('article');
      article.id = 'content';
      article.className = `data-view data-${kind === 'code' ? 'json' : kind}`;
      article.innerHTML = kind === 'csv' ? renderCsv(String(md || ''), ext) : kind === 'json' ? renderJson(md) : renderCode(md, lang, name);
      document.body.textContent = '';
      document.body.appendChild(article);
      highlightCode(article);
      wireLinks(article);
      return;
    }
    const { html, headings } = parse(String(md || ''));
    const article = document.createElement('article');
    article.id = 'content';
    article.innerHTML = html;
    document.body.textContent = '';
    document.body.appendChild(article);
    directionize(article);
    highlightCode(article);
    wireLinks(article);
    buildToc(headings);
    await renderMermaid(article);
  }

  // Table of contents: a side panel of the headings, closed by default and
  // toggled with the ☰ button. Only shown when the file has 2+ headings.
  function buildToc(headings) {
    if (headings.length < 2) return;
    const toc = document.createElement('nav');
    toc.id = 'toc';
    toc.hidden = true;
    toc.innerHTML = headings.map(h => `<a class="lv${h.level}" href="#${escapeHtml(encodeURIComponent(h.id))}">${escapeHtml(h.text)}</a>`).join('');
    toc.querySelectorAll('a').forEach(a => { a.dir = RTL_RE.test(a.textContent) ? 'rtl' : 'ltr'; });
    const btn = document.createElement('button');
    btn.id = 'toc-toggle';
    btn.type = 'button';
    btn.textContent = '☰';
    btn.title = 'Contents';
    btn.setAttribute('aria-controls', 'toc');
    btn.setAttribute('aria-expanded', 'false');
    const setOpen = open => { toc.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', () => setOpen(toc.hidden));
    toc.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      let id = a.getAttribute('href').slice(1);
      try { id = decodeURIComponent(id); } catch (err) { /* keep raw */ }
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setOpen(false);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !toc.hidden) setOpen(false); });
    // Close on any click outside the panel and its button, and when focus
    // leaves the frame (a click elsewhere in the Mattermost preview window).
    document.addEventListener('pointerdown', e => {
      if (!toc.hidden && !toc.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    });
    window.addEventListener('blur', () => { if (!toc.hidden) setOpen(false); });
    document.body.prepend(btn, toc);
  }

  // Exactly one render per frame: later messages (for example from a page this
  // frame was somehow navigated to) are ignored.
  if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
    let rendered = false;
    window.addEventListener('message', e => {
      if (rendered || e.source !== window.parent || !e.data || e.data.type !== 'mmrtl-md-render') return;
      rendered = true;
      render(e.data);
    });
    window.parent.postMessage({ type: 'mmrtl-md-ready' }, '*');
  }

  if (typeof module === 'object' && module.exports) module.exports = { parse, inline, sanitizeHtmlLine, safeHref, safeImgSrc, detectDelimiter, parseCsv, renderCsv, renderJson, renderCode, htmlSrcdoc };
})();
