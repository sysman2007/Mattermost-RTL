// Mattermost RTL — Mattermost webapp plugin.
// Port of a Chrome extension: Persian-first smart bidi per message,
// hover direction toolbar, RTL/LTR whole page, Persian fonts, collapsible LHS.
(function () {
  'use strict';

  const PLUGIN_ID = 'com.github.sysman2007.mattermost-rtl';
  // Mattermost stores plugin user settings under `pp_<plugin id>` cut to 32
  // characters (the preference category limit).
  const PREF_CATEGORY = `pp_${PLUGIN_ID}`.slice(0, 32);
  let store = null;

  // UI language follows the user's Mattermost language (Settings → Display → Language).
  function locale() {
    const e = store?.getState()?.entities;
    const me = e?.users?.profiles?.[e?.users?.currentUserId];
    return (me?.locale || document.documentElement.lang || 'en').toLowerCase();
  }
  const isFa = () => locale().startsWith('fa');
  const L = (fa, en) => (isFa() ? fa : en);

  const basePath = (window.basename || '').replace(/\/$/, '');

  // Minimal stand-in for the extension APIs the shared code uses.
  const chrome = {
    runtime: { getURL: file => `${basePath}/plugins/${PLUGIN_ID}/public/${file}` },
    storage: {
      local: {
        get(key, cb) {
          let v = null;
          try { v = JSON.parse(localStorage.getItem(`mmrtl:${key}`) || 'null'); } catch (e) { /* ignore */ }
          cb({ [key]: v });
        },
        set(obj) {
          try {
            for (const [k, v] of Object.entries(obj)) localStorage.setItem(`mmrtl:${k}`, JSON.stringify(v));
          } catch (e) { /* storage full or blocked */ }
        }
      },
      onChanged: {
        addListener(fn) {
          addEventListener('storage', e => {
            if (!e.key || !e.key.startsWith('mmrtl:')) return;
            let v = null;
            try { v = JSON.parse(e.newValue || 'null'); } catch (err) { /* ignore */ }
            fn({ [e.key.slice(7)]: { newValue: v } }, 'local');
          });
        }
      }
    }
  };

  const FA_UNICODE = 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C, U+200D';

  const FA_FONTS = {
    vazirmatn: { file: 'fonts/Vazirmatn-Regular.ttf', family: 'mmrtl-fa' },
    iransans: { file: 'fonts/IRANSansWeb.ttf', family: 'mmrtl-fa' },
    yekan: { file: 'fonts/Yekan.ttf', family: 'mmrtl-fa' },
    yekanbakh: { file: 'fonts/YekanBakhFaEn04Regular.ttf', family: 'mmrtl-fa' },
    nastaliq: { file: 'fonts/NotoNastaliqUrdu-Regular.ttf', family: 'mmrtl-fa' },
    tahoma: { file: null, family: 'Tahoma' },
    'site-default': null
  };


  function getStyleContainer() {
    return document.head || document.documentElement;
  }

  const EN_FONTS = {
    'site-default': null,
    'same-as-fa': 'same',
    'segoe-ui': '"Segoe UI"',
    arial: 'Arial',
    tahoma: 'Tahoma',
    verdana: 'Verdana',
    calibri: 'Calibri',
    georgia: 'Georgia'
  };

  // Messages + compose boxes; the rest of the UI is only touched when scope is 'all'.
  const MSG_SCOPE = '.post-message__text, .post-message__text *:not(pre):not(code):not(pre *):not(code *), #post_textbox, #reply_textbox, #edit_textbox';
  const ALL_SCOPE = 'body, body *:not(i):not([class*="icon"]):not(pre):not(code):not(pre *):not(code *)';

  function applyFonts({ faKey, enKey, size, color, scope }) {
    const fa = FA_FONTS[faKey] ?? null;
    let en = EN_FONTS[enKey] ?? null;
    let css = '';
    if (fa?.file) {
      css += `@font-face {
        font-family: "mmrtl-fa";
        src: url("${chrome.runtime.getURL(fa.file)}") format("truetype");
        unicode-range: ${FA_UNICODE};
        font-style: normal; font-weight: 100 900; font-display: swap;
      }
`;
    }
    if (en === 'same') {
      // Same face for Latin text too: register the full font without unicode-range.
      if (fa?.file) {
        css += `@font-face {
          font-family: "mmrtl-all";
          src: url("${chrome.runtime.getURL(fa.file)}") format("truetype");
          font-style: normal; font-weight: 100 900; font-display: swap;
        }
`;
        en = '"mmrtl-all"';
      } else {
        en = fa?.family ? `"${fa.family}"` : null;
      }
    }
    const stack = [];
    if (fa?.family) stack.push(`"${fa.family}"`);
    if (en) stack.push(en);
    if (stack.length) {
      stack.push('"Open Sans"', 'sans-serif');
      css += `${scope === 'messages' ? MSG_SCOPE : ALL_SCOPE} { font-family: ${stack.join(', ')} !important; }
`;
    }
    if (size) {
      css += `${MSG_SCOPE} { font-size: ${size}px !important; }
        .post-message__text p, .post-message__text li { line-height: 1.6 !important; }
`;
    }
    if (color) {
      css += `.post-message__text, .post-message__text *:not(a):not(a *):not(pre):not(code):not(pre *):not(code *):not(.mention-link):not(.mention--highlight) { color: ${color} !important; }
        #post_textbox, #reply_textbox, #edit_textbox { color: ${color} !important; }
`;
    }
    let st = document.getElementById('mmrtl-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'mmrtl-style';
      getStyleContainer().appendChild(st);
    }
    st.textContent = css;
  }

  let pageDir = 'site-default';
  function applyPageDir(dir) {
    pageDir = dir === 'rtl' || dir === 'ltr' ? dir : 'site-default';
    const html = document.documentElement;
    for (const el of [html, document.body]) {
      if (!el) continue;
      if (pageDir === 'site-default') {
        if (el.dataset.mmrtlPageDir) {
          el.setAttribute('dir', el.dataset.mmrtlPageDirOrig || '');
          if (!el.dataset.mmrtlPageDirOrig) el.removeAttribute('dir');
          delete el.dataset.mmrtlPageDir;
          delete el.dataset.mmrtlPageDirOrig;
        }
      } else {
        if (!el.dataset.mmrtlPageDir) el.dataset.mmrtlPageDirOrig = el.getAttribute('dir') || '';
        el.dataset.mmrtlPageDir = pageDir;
        if (el.getAttribute('dir') !== pageDir) el.setAttribute('dir', pageDir);
      }
    }
    let st = document.getElementById('mmrtl-page-dir');
    if (pageDir === 'site-default') { st?.remove(); return; }
    if (!st) {
      st = document.createElement('style');
      st.id = 'mmrtl-page-dir';
      getStyleContainer().appendChild(st);
    }
    st.textContent = `html[data-mmrtl-page-dir], body[data-mmrtl-page-dir] { direction: ${pageDir} !important; }`;
  }

  // Keep the chosen direction if the site (or a late <body>) resets it.
  new MutationObserver(() => {
    if (pageDir === 'site-default') return;
    const html = document.documentElement;
    if (html.getAttribute('dir') !== pageDir || (document.body && document.body.getAttribute('dir') !== pageDir)) {
      applyPageDir(pageDir);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['dir'], childList: true });


  const Bidi = (() => {
    const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
    const LTR_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
    const MSG = '.post-message__text';
    const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, dt, dd, td, th';
    const GROUPS = 'ul, ol, blockquote, table';
    const SKIP = 'pre, code, kbd, samp, .markdown-inline-img, .emoticon';
    const INPUTS = 'textarea';
    const STORE_KEY = 'mmrtlBidiOverrides';
    const MAX_OVERRIDES = 3000;

    let enabled = false;
    let hoverOn = true;
    let started = false;
    let overrides = {};
    let bar = null;
    let current = null;
    let hideTimer = 0;
    const pending = new Set();
    let flushQueued = false;

    function textOf(el) {
      let out = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      });
      let n;
      while ((n = walker.nextNode())) out += n.nodeValue;
      return out;
    }

    function detect(text) {
      if (RTL_RE.test(text)) return 'rtl';
      if (LTR_RE.test(text)) return 'ltr';
      return null;
    }

    function msgKey(msg) {
      const post = msg.closest('[id^="post_"], [id^="rhsPost_"]');
      const id = (msg.id || post?.id || '').replace(/^(postMessageText_|rhsPost_|post_)/, '');
      return id || null;
    }

    function setDir(el, dir, source) {
      if (!dir) {
        el.removeAttribute('dir');
        delete el.dataset.mmrtlDir;
        return;
      }
      if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir);
      el.dataset.mmrtlDir = source;
    }

    function blocksOf(msg) {
      const list = [...msg.querySelectorAll(BLOCKS)].filter(b => !b.closest(SKIP));
      return list.length ? list : [msg];
    }

    function processMessage(msg) {
      if (!enabled || !msg.isConnected) return;
      const key = msgKey(msg);
      const forced = key && overrides[key];
      // Skip unchanged messages so site re-renders can't turn into a feedback loop.
      const sig = `${forced || ''}|${msg.childElementCount}|${msg.textContent.length}`;
      if (msg.dataset.mmrtlSig === sig) return;
      msg.dataset.mmrtlSig = sig;
      msg.classList.add('mmrtl-bidi-msg');
      if (forced) {
        // A manual choice applies to the whole message.
        msg.querySelectorAll('[data-mmrtl-dir]').forEach(el => el !== msg && setDir(el, null));
        setDir(msg, forced, 'user');
        return;
      }
      const blocks = blocksOf(msg);
      for (const block of blocks) {
        if (block !== msg) setDir(block, detect(textOf(block)), 'auto');
      }
      // Containers follow their children: any RTL child makes the list/quote RTL.
      for (const group of msg.querySelectorAll(GROUPS)) {
        if (group.closest(SKIP)) continue;
        const kids = [...group.querySelectorAll('[dir]')];
        const dir = kids.some(k => k.getAttribute('dir') === 'rtl') ? 'rtl'
          : kids.some(k => k.getAttribute('dir') === 'ltr') ? 'ltr' : null;
        setDir(group, dir, 'auto');
      }
      setDir(msg, detect(textOf(msg)), 'auto');
    }

    function clearMessage(msg) {
      delete msg.dataset.mmrtlSig;
      msg.querySelectorAll('[data-mmrtl-dir]').forEach(el => setDir(el, null));
      if (msg.dataset.mmrtlDir) setDir(msg, null);
    }

    function processInput(el) {
      if (!enabled || el.closest(SKIP)) return;
      const dir = detect(el.value || '') || (el.value ? el.getAttribute('dir') || 'rtl' : 'rtl');
      if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir);
      el.classList.add('mmrtl-bidi-input');
    }

    function queue(root) {
      if (!root || root.nodeType !== 1) {
        root = root?.parentElement;
        if (!root) return;
      }
      if (root.matches?.(INPUTS)) processInput(root);
      root.querySelectorAll?.(INPUTS).forEach(processInput);
      const own = root.closest(MSG);
      if (own) pending.add(own);
      else root.querySelectorAll?.(MSG).forEach(m => pending.add(m));
      if (!flushQueued) {
        flushQueued = true;
        requestAnimationFrame(flush);
      }
    }

    function flush() {
      flushQueued = false;
      const items = [...pending];
      pending.clear();
      items.forEach(processMessage);
      if (current && !current.isConnected) hideBar(true);
    }

    function processAll() {
      document.querySelectorAll(MSG).forEach(processMessage);
      document.querySelectorAll(INPUTS).forEach(processInput);
    }

    // ── Hover toolbar ──
    const ICONS = {
      rtl: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8"/></svg>',
      ltr: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8"/></svg>',
      auto: '<svg viewBox="0 0 16 16"><path d="M3.5 13 8 3l4.5 10M5.2 9.5h5.6"/></svg>',
      md: '<svg viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M4 10V6l1.75 2L7.5 6v4M11 6v4m-1.5-1.5L11 10l1.5-1.5"/></svg>'
    };
    let onMarkdown = null;
    const setMarkdownAction = fn => { onMarkdown = fn; };

    function injectCSS() {
      if (document.getElementById('mmrtl-bidi-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-bidi-style';
      st.textContent = `
        .mmrtl-bidi-msg[dir], .mmrtl-bidi-msg [dir] { text-align: start !important; }
        /* dir attribute alone loses to site CSS that sets direction (e.g. on lists). */
        .mmrtl-bidi-msg[dir="rtl"], .mmrtl-bidi-msg [dir="rtl"] { direction: rtl !important; }
        .mmrtl-bidi-msg[dir="ltr"], .mmrtl-bidi-msg [dir="ltr"] { direction: ltr !important; }
        .mmrtl-bidi-msg li[dir] { text-align: start !important; }
        .mmrtl-bidi-input[dir] { text-align: start !important; }
        .mmrtl-bidi-input[dir="rtl"] { direction: rtl !important; }
        .mmrtl-bidi-input[dir="ltr"] { direction: ltr !important; }
        .post-message__text ul[dir], .post-message__text ol[dir] { padding-inline-start: 1.6em; padding-inline-end: 0; }
        .post-message__text blockquote[dir="rtl"] {
          border-left: 0 !important; border-right: 4px solid rgba(var(--center-channel-color-rgb, 63,67,80), .16);
          padding-left: 0; padding-right: 12px; margin-left: 0;
        }
        .post-message__text code { unicode-bidi: isolate; direction: ltr; }
        .post-message__text a, .post-message__text .mention-link { unicode-bidi: isolate; }
        #mmrtl-bidi-bar {
          position: fixed; z-index: 2147483000; display: flex; flex-direction: column; gap: 2px;
          padding: 3px; border-radius: 8px; direction: ltr;
          background: rgba(30, 35, 48, .72); backdrop-filter: blur(4px);
          box-shadow: 0 2px 8px rgba(0,0,0,.18);
          opacity: 0; pointer-events: none; transition: opacity .15s ease;
        }
        #mmrtl-bidi-bar.show { opacity: .38; pointer-events: auto; }
        #mmrtl-bidi-bar.show:hover { opacity: 1; }
        #mmrtl-bidi-bar button {
          all: unset; box-sizing: border-box; width: 20px; height: 20px; border-radius: 5px;
          display: flex; align-items: center; justify-content: center; cursor: pointer; color: #cbd5e1;
        }
        #mmrtl-bidi-bar button:hover { background: rgba(255,255,255,.12); color: #fff; }
        #mmrtl-bidi-bar button.on { background: linear-gradient(135deg,#5b6af8,#a855f7); color: #fff; }
        #mmrtl-bidi-bar svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
      `;
      (document.head || document.documentElement).appendChild(st);
    }

    function ensureBar() {
      if (bar) return bar;
      bar = document.createElement('div');
      bar.id = 'mmrtl-bidi-bar';
      bar.setAttribute('role', 'toolbar');
      bar.innerHTML = `
        <button type="button" data-dir="rtl" title="راست‌به‌چپ (RTL)">${ICONS.rtl}</button>
        <button type="button" data-dir="ltr" title="چپ‌به‌راست (LTR)">${ICONS.ltr}</button>
        <button type="button" data-dir="auto" title="خودکار">${ICONS.auto}</button>
        <button type="button" data-act="md" title="${L('نمایش و دانلود به‌صورت Markdown', 'View and download as Markdown')}">${ICONS.md}</button>`;
      bar.addEventListener('mousedown', e => e.preventDefault());
      bar.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn || !current) return;
        e.stopPropagation();
        if (btn.dataset.act === 'md') { onMarkdown?.(current); return; }
        choose(current, btn.dataset.dir);
      });
      bar.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      bar.addEventListener('mouseleave', () => hideBar());
      document.documentElement.appendChild(bar);
      return bar;
    }

    function refreshButtons() {
      if (!bar || !current) return;
      const mode = current.dataset.mmrtlDir === 'user' ? current.getAttribute('dir') : 'auto';
      bar.querySelectorAll('button[data-dir]').forEach(b => b.classList.toggle('on', b.dataset.dir === mode));
      const md = bar.querySelector('[data-act="md"]');
      if (md) md.hidden = !onMarkdown;
    }

    function placeBar() {
      if (!bar || !current) return;
      const r = current.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return hideBar(true);
      const w = bar.offsetWidth || 26;
      const h = bar.offsetHeight || 70;
      // Sit in the avatar column, just below the avatar, so name/avatar stay visible.
      const post = current.closest('.post');
      const col = post?.querySelector('.post__img');
      const avatar = col?.querySelector('img, .Avatar, .profile-icon, button');
      let left, top;
      if (col) {
        const c = col.getBoundingClientRect();
        left = c.left + c.width / 2 - w / 2;
        const av = avatar?.getBoundingClientRect();
        top = av && av.height ? Math.max(av.bottom + 6, r.top) : r.top;
      } else {
        left = r.left - w - 8;
        if (left < 4) left = Math.min(r.right + 8, innerWidth - w - 4);
        top = r.top;
      }
      left = Math.max(4, Math.min(left, innerWidth - w - 4));
      top = Math.max(4, Math.min(top, innerHeight - h - 4));
      bar.style.left = `${left}px`;
      bar.style.top = `${top}px`;
    }

    function showBar(block) {
      clearTimeout(hideTimer);
      ensureBar();
      current = block;
      refreshButtons();
      placeBar();
      bar.classList.add('show');
    }

    function hideBar(now) {
      clearTimeout(hideTimer);
      const doHide = () => { bar?.classList.remove('show'); current = null; };
      if (now) doHide(); else hideTimer = setTimeout(doHide, 350);
    }

    function choose(msg, dir) {
      const key = msgKey(msg);
      if (key) {
        if (dir === 'auto') delete overrides[key];
        else overrides[key] = dir;
        const keys = Object.keys(overrides);
        if (keys.length > MAX_OVERRIDES) keys.slice(0, keys.length - MAX_OVERRIDES).forEach(k => delete overrides[k]);
        chrome.storage.local.set({ [STORE_KEY]: overrides });
      } else if (dir !== 'auto') {
        setDir(msg, dir, 'user');
      }
      delete msg.dataset.mmrtlSig;
      processMessage(msg);
      refreshButtons();
      placeBar();
    }

    function onOver(e) {
      if (!enabled || !hoverOn) return;
      if (bar && bar.contains(e.target)) return;
      const msg = e.target.closest?.(MSG);
      if (msg) {
        if (msg !== current) showBar(msg); else clearTimeout(hideTimer);
      } else if (current) {
        hideBar();
      }
    }

    function start() {
      if (started) return;
      started = true;
      injectCSS();
      new MutationObserver(records => {
        if (!enabled) return;
        for (const rec of records) {
          if (bar && (rec.target === bar || bar.contains(rec.target))) continue;
          if (rec.type === 'characterData') queue(rec.target);
          else {
            queue(rec.target);
            rec.addedNodes.forEach(n => n.nodeType === 1 && queue(n));
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

      document.addEventListener('input', e => {
        if (e.target.matches?.(INPUTS)) processInput(e.target);
      }, true);
      document.addEventListener('keyup', e => {
        if (e.target.matches?.(INPUTS)) processInput(e.target);
      }, true);
      document.addEventListener('paste', e => {
        if (e.target.matches?.(INPUTS)) setTimeout(() => processInput(e.target));
      }, true);
      setInterval(() => {
        const el = document.activeElement;
        if (enabled && el?.matches?.(INPUTS)) processInput(el);
      }, 400);
      document.addEventListener('focusin', e => {
        if (e.target.matches?.(INPUTS)) processInput(e.target);
      }, true);
      document.addEventListener('mouseover', onOver, true);
      addEventListener('scroll', () => current && placeBar(), true);
      addEventListener('resize', () => current && placeBar());

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[STORE_KEY]) {
          overrides = changes[STORE_KEY].newValue || {};
          document.querySelectorAll(MSG).forEach(m => delete m.dataset.mmrtlSig);
          if (enabled) document.querySelectorAll(MSG).forEach(processMessage);
        }
      });
    }

    function configure(opts) {
      const wasEnabled = enabled;
      enabled = !!opts.enabled;
      hoverOn = !!opts.hover;
      if (!enabled) {
        if (wasEnabled) document.querySelectorAll(MSG).forEach(clearMessage);
        hideBar(true);
        return;
      }
      if (!hoverOn) hideBar(true);
      chrome.storage.local.get(STORE_KEY, r => {
        overrides = r[STORE_KEY] || {};
        start();
        processAll();
      });
    }

    return { configure, setMarkdownAction };
  })();

  // ── Collapsible left sidebar (Mattermost): click the header logo to toggle.
  // Desktop only and starts open; at mobile width Mattermost's own hamburger
  // menu is left in charge. A manual toggle holds until the viewport crosses
  // the breakpoint.

  const Sidebar = (() => {
    const LOGO = '#global-header [class^="ProductBranding"], #global-header [class*=" ProductBranding"], #global-header [class*="StyledLogo"]';
    const mq = matchMedia('(max-width: 768px)');
    let manual = null;
    let started = false;

    function render() {
      const collapsed = manual ?? mq.matches;
      document.documentElement.classList.toggle('mmrtl-lhs-collapsed', collapsed);
      document.documentElement.classList.toggle('mmrtl-lhs-open', !collapsed);
    }

    function injectCSS() {
      if (document.getElementById('mmrtl-lhs-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-lhs-style';
      st.textContent = `
        #global-header [class^="ProductBranding"], #global-header [class*=" ProductBranding"] { cursor: pointer; }
        /* Desktop only: at mobile width Mattermost switches .main-wrapper to a
           single "main" grid area and runs its own off-canvas sidebar, so a
           three-column override there squeezes the channel view to 0px. */
        @media (min-width: 769px) {
          html.mmrtl-lhs-collapsed:not(.mmrtl-lhs-disabled) #SidebarContainer { display: none !important; }
          html.mmrtl-lhs-collapsed:not(.mmrtl-lhs-disabled) .main-wrapper { grid-template-columns: 0 minmax(0, 1fr) auto !important; }
        }`;
      (document.head || document.documentElement).appendChild(st);
    }

    function start() {
      if (started) return;
      started = true;
      injectCSS();
      render();
      mq.addEventListener('change', () => { manual = null; render(); });
      // Capture phase so the click toggles the sidebar instead of opening the product menu.
      document.addEventListener('click', e => {
        const logo = e.target.closest?.(LOGO);
        if (!logo || document.documentElement.classList.contains('mmrtl-lhs-disabled')) return;
        e.preventDefault();
        e.stopPropagation();
        manual = !document.documentElement.classList.contains('mmrtl-lhs-collapsed');
        render();
      }, true);
      document.addEventListener('mouseover', e => {
        const logo = e.target.closest?.(LOGO);
        if (logo && !logo.title) logo.title = 'باز/بستن منوی کناری';
      }, true);
    }

    return { start };
  })();


  function applyCodeBlocksLTR(root = document) {
    root.querySelectorAll?.('pre, code, kbd, samp, .monaco-editor, .cm-editor, .CodeMirror').forEach(el => {
      el.style.direction = 'ltr';
      el.style.textAlign = 'left';
    });
  }


  // ── Settings: per-user preferences from Settings → Mattermost RTL (defaults below).
  const DEFAULTS = { bidi: 'smart', hover: 'on', page_dir: 'auto', fa_font: 'vazirmatn', en_font: 'site-default', font_scope: 'all', font_size: 'site-default', text_color: 'site-default', sidebar_toggle: 'on', timestamp: 'full', fa_fix: 'on', context_menu: 'on', md_preview: 'on', data_preview: 'on', md_export: 'on', read_receipts: 'on', paste_as_file: 'on', code_preview: 'on', code_paste: 'on', office_preview: 'on', reply_click: 'off', folders_view: 'panel' };
  let last = '';
  let sidebarOn = false;
  let mdExportOn = true;

  function readSettings() {
    const prefs = store?.getState()?.entities?.preferences?.myPreferences || {};
    const out = { ...DEFAULTS };
    for (const name of Object.keys(DEFAULTS)) {
      const p = prefs[`${PREF_CATEGORY}--${name}`];
      if (p && p.value) out[name] = p.value;
    }
    return out;
  }

  function applySettings() {
    const s = readSettings();
    const sig = JSON.stringify(s) + locale();
    if (sig === last) return;
    last = sig;
    applyFonts({
      faKey: s.fa_font,
      enKey: s.en_font,
      size: s.font_size === 'site-default' ? null : Number.parseInt(s.font_size, 10),
      color: /^#[0-9a-f]{6}$/i.test(s.text_color) ? s.text_color : null,
      scope: s.font_scope
    });
    // 'auto': Persian UI language → whole page RTL (sidebar, avatar and name on the right).
    const dir = s.page_dir === 'auto' ? (isFa() ? 'rtl' : 'site-default') : s.page_dir;
    applyPageDir(dir);
    RtlMirror.configure(dir === 'rtl');
    ResizeFlip.configure(dir === 'rtl');
    Bidi.configure({ enabled: s.bidi === 'smart', hover: s.hover !== 'off' });
    const off = s.sidebar_toggle !== 'on';
    document.documentElement.classList.toggle('mmrtl-lhs-disabled', off);
    if (!sidebarOn) { sidebarOn = true; Sidebar.start(); }
    Stamps.configure(s.timestamp === 'full');
    FaFix.configure(s.fa_fix === 'on');
    ContextMenu.configure(s.context_menu === 'on');
    MdPreview.configure({ markdown: s.md_preview === 'on', data: s.data_preview === 'on', code: s.code_preview === 'on', office: s.office_preview === 'on' });
    mdExportOn = s.md_export === 'on';
    Bidi.setMarkdownAction(mdExportOn ? MdExport.open : null);
    ReadReceipts.configure(s.read_receipts === 'on');
    ReplyClick.configure(s.reply_click);
    Folders.configure({ page: s.folders_view === 'page' });
    PasteAsFile.configure(s.paste_as_file === 'on', s.code_paste === 'on');
    applyCodeBlocksLTR();
  }

  const radio = (name, title, helpText, options) => ({
    name, title, helpText, type: 'radio', default: DEFAULTS[name],
    options: options.map(([value, text]) => ({ value, text }))
  });

  // ── «ارسال به…»: send a copy of any post (text + attachments) to a user or channel.
  // Mattermost's native forward is public-channels only; this posts a quoted copy
  // with the original author and time, re-uploading attachments to the target.
  const Forward = (() => {
    const api = path => `${basePath}/api/v4${path}`;
    let overlay = null;

    function csrf() {
      const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }

    async function call(method, path, body, isForm) {
      const headers = { 'X-Requested-With': 'XMLHttpRequest' };
      if (method !== 'GET') headers['X-CSRF-Token'] = csrf();
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(api(path), {
        method, headers, credentials: 'include',
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined
      });
      if (!res.ok) {
        let msg = `${res.status}`;
        try { msg = (await res.json()).message || msg; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      return res;
    }
    const json = async (method, path, body) => (await call(method, path, body)).json();

    function state() { return store.getState().entities; }

    function displayName(u) {
      if (!u) return '';
      const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
      return full ? `${full} (@${u.username})` : `@${u.username}`;
    }

    async function search(term) {
      const e = state();
      const teamId = e.teams.currentTeamId;
      const meId = e.users.currentUserId;
      const t = term.trim().toLowerCase();
      const out = [];
      if (t.length >= 1) {
        const users = await json('POST', '/users/search', { term: t, allow_inactive: false, limit: 15 });
        for (const u of users) {
          if (u.id === meId || u.is_bot && u.delete_at) continue;
          out.push({ kind: 'user', id: u.id, label: displayName(u) });
        }
      }
      const chans = Object.values(e.channels.channels || {})
        .filter(c => (c.type === 'O' || c.type === 'P') && c.team_id === teamId && !c.delete_at)
        .filter(c => !t || c.display_name.toLowerCase().includes(t) || c.name.includes(t))
        .slice(0, 10);
      for (const c of chans) out.push({ kind: 'channel', id: c.id, label: `${c.type === 'P' ? '🔒' : '#'} ${c.display_name}` });
      return out;
    }

    async function targetChannelId(target) {
      if (target.kind === 'channel') return target.id;
      const meId = state().users.currentUserId;
      const ch = await json('POST', '/channels/direct', [meId, target.id]);
      return ch.id;
    }

    async function copyFiles(fileIds, channelId, progress) {
      const ids = [];
      const infos = state().files?.files || {};
      for (let i = 0; i < fileIds.length; i++) {
        progress(L(`انتقال فایل ${i + 1} از ${fileIds.length}…`, `Copying file ${i + 1} of ${fileIds.length}…`));
        const id = fileIds[i];
        let name = infos[id]?.name;
        if (!name) {
          try { name = (await json('GET', `/files/${id}/info`)).name; } catch (e) { name = `file-${i + 1}`; }
        }
        const blob = await (await call('GET', `/files/${id}`)).blob();
        const form = new FormData();
        form.append('channel_id', channelId);
        form.append('files', blob, name);
        const up = await (await call('POST', '/files', form, true)).json();
        ids.push(...up.file_infos.map(f => f.id));
      }
      return ids;
    }

    function buildMessage(post, note) {
      const e = state();
      const author = e.users.profiles[post.user_id];
      const when = new Date(post.create_at).toLocaleString(isFa() ? 'fa-IR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const quoted = (post.message || '').split('\n').map(l => `> ${l}`).join('\n');
      let msg = '';
      if (note.trim()) msg += `${note.trim()}\n\n`;
      msg += `**↪ ${L('ارسال‌شده از', 'Forwarded from')} ${author ? '@' + author.username : L('کاربر', 'a user')}** · ${when}`;
      if (post.message) msg += `\n${quoted}`;
      return msg;
    }

    async function send(post, target, note, progress) {
      progress(L('آماده‌سازی…', 'Preparing…'));
      const channelId = await targetChannelId(target);
      const fileIds = post.file_ids?.length ? await copyFiles(post.file_ids, channelId, progress) : [];
      progress(L('ارسال پیام…', 'Sending…'));
      await json('POST', '/posts', { channel_id: channelId, message: buildMessage(post, note), file_ids: fileIds });
    }

    function injectCSS() {
      if (document.getElementById('mmrtl-fwd-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-fwd-style';
      st.textContent = `
        #mmrtl-fwd { position: fixed; inset: 0; z-index: 2147483100; background: rgba(0,0,0,.45);
          display: flex; align-items: center; justify-content: center; padding: 16px; }
        #mmrtl-fwd .box { width: min(480px, 100%); max-height: 90vh; overflow: auto; text-align: start;
          background: var(--center-channel-bg, #fff); color: var(--center-channel-color, #3f4350);
          border-radius: 12px; box-shadow: 0 20px 32px rgba(0,0,0,.25); padding: 20px; font-size: 14px; }
        #mmrtl-fwd h3 { margin: 0 0 12px; font-size: 18px; font-weight: 600; }
        #mmrtl-fwd .preview { border-inline-start: 3px solid rgba(var(--center-channel-color-rgb, 63,67,80), .2);
          padding: 6px 10px; margin-bottom: 12px; opacity: .8; white-space: pre-wrap; max-height: 120px; overflow: auto; unicode-bidi: plaintext; }
        #mmrtl-fwd input, #mmrtl-fwd textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px;
          border: 1px solid rgba(var(--center-channel-color-rgb, 63,67,80), .24); background: transparent; color: inherit;
          font: inherit; margin-bottom: 8px; unicode-bidi: plaintext; }
        #mmrtl-fwd ul { list-style: none; margin: 0 0 8px; padding: 0; max-height: 200px; overflow: auto; }
        #mmrtl-fwd li { padding: 7px 10px; border-radius: 6px; cursor: pointer; unicode-bidi: plaintext; }
        #mmrtl-fwd li:hover, #mmrtl-fwd li.sel { background: rgba(var(--button-bg-rgb, 28,88,217), .12); }
        #mmrtl-fwd .chosen { margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
        #mmrtl-fwd .chip { background: rgba(var(--button-bg-rgb, 28,88,217), .12); border-radius: 12px; padding: 2px 10px;
          font-size: 12px; cursor: pointer; unicode-bidi: plaintext; }
        #mmrtl-fwd .chip:hover { background: rgba(var(--error-text-color-rgb, 210,75,78), .16); }
        #mmrtl-fwd .row { display: flex; gap: 8px; justify-content: flex-start; margin-top: 8px; align-items: center; }
        #mmrtl-fwd button { border: 0; border-radius: 6px; padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer; }
        #mmrtl-fwd .ok { background: var(--button-bg, #1c58d9); color: var(--button-color, #fff); }
        #mmrtl-fwd .ok:disabled { opacity: .5; cursor: default; }
        #mmrtl-fwd .cancel { background: rgba(var(--center-channel-color-rgb, 63,67,80), .08); color: inherit; }
        #mmrtl-fwd .status { font-size: 12px; opacity: .8; }
        #mmrtl-fwd .err { color: var(--error-text, #d24b4e); }`;
      (document.head || document.documentElement).appendChild(st);
    }

    function el(tag, props = {}, text) {
      const n = document.createElement(tag);
      Object.assign(n, props);
      if (text != null) n.textContent = text;
      return n;
    }

    function close() { overlay?.remove(); overlay = null; }

    function open(postId) {
      const post = state().posts.posts[postId];
      if (!post) return;
      injectCSS();
      close();
      const targets = new Map();
      let timer = 0;

      overlay = el('div', { id: 'mmrtl-fwd' });
      const box = el('div', { className: 'box', role: 'dialog' });
      box.dir = isFa() ? 'rtl' : 'ltr';
      box.append(el('h3', {}, L('ارسال به…', 'Send to…')));
      const files = post.file_ids?.length || 0;
      box.append(el('div', { className: 'preview' },
        (post.message || '').slice(0, 400) + (files ? `\n📎 ${files} ${L('فایل پیوست', 'attachment(s)')}` : '')));
      const input = el('input', { placeholder: L('جستجوی کاربر یا کانال (چند گیرنده مجاز است)…', 'Search users or channels (multiple allowed)…'), autocomplete: 'off' });
      const list = el('ul');
      const chosen = el('div', { className: 'chosen' });
      const note = el('textarea', { rows: 2, placeholder: L('یادداشت (اختیاری)', 'Note (optional)') });
      const status = el('span', { className: 'status' });
      const ok = el('button', { className: 'ok', disabled: true }, L('ارسال', 'Send'));
      const cancel = el('button', { className: 'cancel' }, L('انصراف', 'Cancel'));
      const row = el('div', { className: 'row' });
      row.append(ok, cancel, status);
      box.append(input, list, chosen, note, row);
      overlay.append(box);
      document.body.append(overlay);
      input.focus();

      function renderChosen() {
        chosen.replaceChildren();
        if (targets.size) {
          chosen.append(el('span', {}, `${L('گیرندگان', 'To')}: `));
          for (const [key, it] of targets) {
            const chip = el('span', { className: 'chip', title: L('حذف', 'Remove') }, `${it.label} ✕`);
            chip.addEventListener('click', () => { targets.delete(key); renderChosen(); refresh(); });
            chosen.append(chip);
          }
        }
        ok.disabled = !targets.size;
      }

      async function refresh() {
        try {
          const items = await search(input.value);
          list.replaceChildren(...items.map(it => {
            const li = el('li', {}, it.label);
            const key = `${it.kind}:${it.id}`;
            if (targets.has(key)) li.classList.add('sel');
            li.addEventListener('click', () => {
              if (targets.has(key)) targets.delete(key); else targets.set(key, it);
              li.classList.toggle('sel', targets.has(key));
              renderChosen();
            });
            return li;
          }));
        } catch (err) {
          status.className = 'status err';
          status.textContent = `${L('خطا در جستجو', 'Search failed')}: ${err.message}`;
        }
      }
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
      refresh();

      cancel.addEventListener('click', close);
      overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
      overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
      ok.addEventListener('click', async () => {
        if (!targets.size) return;
        ok.disabled = true;
        status.className = 'status';
        const all = [...targets.values()];
        const failed = [];
        for (let i = 0; i < all.length; i++) {
          const prefix = all.length > 1 ? `(${i + 1}/${all.length}) ` : '';
          try {
            await send(post, all[i], note.value, t => { status.textContent = prefix + t; });
            targets.delete(`${all[i].kind}:${all[i].id}`);
          } catch (err) {
            failed.push(`${all[i].label}: ${err.message}`);
          }
        }
        renderChosen();
        if (!failed.length) {
          status.textContent = L('✓ ارسال شد', '✓ Sent');
          setTimeout(close, 900);
        } else {
          // Sent ones were removed from the list, so «ارسال» retries only the failures.
          status.className = 'status err';
          status.textContent = `${L('ارسال نشد', 'Not sent')}: ${failed.join(' — ')}`;
          ok.disabled = false;
          refresh();
        }
      });
    }

    return { open };
  })();

  // ── Full date next to each post's time (Mattermost shows only the time and
  // keeps the date in a hover tooltip). The date goes in a data attribute and is
  // drawn with ::before, so React's own <time> content is never touched.
  const Stamps = (() => {
    let on = false;
    const SEL = '.post__header time.post__time[datetime]';

    function injectCSS() {
      if (document.getElementById('mmrtl-stamp-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-stamp-style';
      st.textContent = `html.mmrtl-full-time ${SEL}[data-mmrtl-date]::before { content: attr(data-mmrtl-date); }`;
      (document.head || document.documentElement).appendChild(st);
    }

    function label(dt) {
      const d = new Date(dt);
      if (Number.isNaN(d.getTime())) return '';
      const fa = isFa();
      const date = new Intl.DateTimeFormat(fa ? 'fa-IR' : 'en-US', { dateStyle: 'medium' }).format(d);
      return fa ? `${date}، ` : `${date}, `;
    }

    function apply() {
      if (!on) return;
      const loc = locale();
      for (const t of document.querySelectorAll(SEL)) {
        const key = `${t.getAttribute('datetime')}|${loc}`;
        if (t.dataset.mmrtlKey === key) continue;
        t.dataset.mmrtlKey = key;
        t.dataset.mmrtlDate = label(t.getAttribute('datetime'));
      }
    }

    function configure(enabled) {
      on = enabled;
      injectCSS();
      document.documentElement.classList.toggle('mmrtl-full-time', on);
      apply();
    }

    return { configure, apply };
  })();

  // ── Persian typing fixes in compose boxes: Arabic ي/ك → ی/ک, Arabic-Indic
  // digits → Persian digits, and the half-space (ZWNJ) in «می/نمی» and «ها».
  // Every replacement keeps the text length, so the caret never jumps.
  // Code spans and fenced blocks are left untouched.
  const FaFix = (() => {
    let on = false;
    let busy = false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const FA = 'آ-ی';
    const MI = new RegExp(`(^|[\\s\\u200c(«"])(ن?می) (?=[${FA}])`, 'g');
    const HA = new RegExp(`([${FA}]) (ها|های|هایی|هایم|هایت|هایش|هایمان|هایتان|هایشان)(?=$|[\\s.,،؛:!?؟)»"])`, 'g');

    function fixText(t) {
      return t
        .replace(/ي/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) + 0x90))
        .replace(MI, '$1$2‌')
        .replace(HA, '$1‌$2');
    }

    function fix(value) {
      // Odd indexes are code (```fenced``` or `inline`), even ones are prose.
      return value.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`?)/).map((part, i) => (i % 2 ? part : fixText(part))).join('');
    }

    function onInput(e) {
      const el = e.target;
      if (!on || busy || !(el instanceof HTMLTextAreaElement)) return;
      const v = el.value;
      const nv = fix(v);
      if (nv === v || nv.length !== v.length) return;
      const { selectionStart: a, selectionEnd: b } = el;
      // Native setter + input event so React's controlled textarea picks it up.
      setter.call(el, nv);
      el.setSelectionRange(a, b);
      busy = true;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } finally { busy = false; }
    }

    let started = false;
    function configure(enabled) {
      on = enabled;
      if (!started) {
        started = true;
        document.addEventListener('input', onInput, true);
      }
    }

    return { configure };
  })();

  // ── RTL mirror: Mattermost positions much of its UI with physical left/right
  // (RHS drawer `right: 0`, editor actions, search clear button, sidebar
  // margins, text-align: left…), which `dir="rtl"` alone doesn't flip. This
  // reads every CSS rule on the page and emits a mirrored copy scoped to
  // html[dir="rtl"] (the rtlcss idea, done at runtime so styled-components and
  // other plugins' rules are covered too).
  const RtlMirror = (() => {
    const PAIRS = [
      ['left', 'right'],
      ['margin-left', 'margin-right'],
      ['padding-left', 'padding-right'],
      ['border-left-width', 'border-right-width'],
      ['border-left-style', 'border-right-style'],
      ['border-left-color', 'border-right-color'],
      ['border-top-left-radius', 'border-top-right-radius'],
      ['border-bottom-left-radius', 'border-bottom-right-radius']
    ];
    const DEF = {
      left: 'auto', right: 'auto',
      'margin-left': '0', 'margin-right': '0',
      'padding-left': '0', 'padding-right': '0',
      'border-left-width': 'medium', 'border-right-width': 'medium',
      'border-left-style': 'none', 'border-right-style': 'none',
      'border-left-color': 'currentcolor', 'border-right-color': 'currentcolor',
      'border-top-left-radius': '0', 'border-top-right-radius': '0',
      'border-bottom-left-radius': '0', 'border-bottom-right-radius': '0'
    };
    const SWAP_VALUE = ['text-align', 'float', 'clear'];
    const OWN = /^mmrtl-/;
    const OUT_ID = 'mmrtl-rtl-mirror';
    // Fixes a generic mirror can't infer: directional icons (send, drafts), and
    // a side that only got its value from a less specific rule.
    const RTL_EXTRA = `
      html[dir="rtl"] i[class*="icon-send"],
      html[dir="rtl"] .splitSendButton svg,
      html[dir="rtl"] .SendMessageButton svg { display: inline-block; transform: scaleX(-1); }
      html[dir="rtl"] #post_textbox, html[dir="rtl"] #reply_textbox, html[dir="rtl"] #edit_textbox,
      html[dir="rtl"] .AdvancedTextEditor textarea.custom-textarea { padding-right: 16px !important; }`;

    let on = false;
    let lastCount = -1;
    let timer = 0;
    let queued = false;

    // Split a selector list on top-level commas (not inside :is(), :not()…).
    function splitSelectors(sel) {
      const out = [];
      let depth = 0;
      let cur = '';
      for (const ch of sel) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur);
      return out.map(s => s.trim()).filter(Boolean);
    }

    function scope(sel) {
      return splitSelectors(sel).map(s => {
        if (/^html(?![\w-])/.test(s)) return s.replace(/^html/, 'html[dir="rtl"]');
        if (/^:root(?![\w-])/.test(s)) return s.replace(/^:root/, ':root[dir="rtl"]');
        return `html[dir="rtl"] ${s}`;
      }).join(', ');
    }

    function mirrorDecls(style) {
      const decls = [];
      for (const [a, b] of PAIRS) {
        const va = style.getPropertyValue(a);
        const vb = style.getPropertyValue(b);
        if (!va && !vb) continue;
        if (va === vb) continue;
        const imp = style.getPropertyPriority(a) || style.getPropertyPriority(b) ? ' !important' : '';
        decls.push(`${a}: ${vb || DEF[a]}${imp}`, `${b}: ${va || DEF[b]}${imp}`);
      }
      for (const p of SWAP_VALUE) {
        const v = style.getPropertyValue(p);
        if (v === 'left' || v === 'right') {
          const imp = style.getPropertyPriority(p) ? ' !important' : '';
          decls.push(`${p}: ${v === 'left' ? 'right' : 'left'}${imp}`);
        }
      }
      const tf = style.getPropertyValue('transform');
      const flipped = tf && flipTransform(tf);
      if (flipped) decls.push(`transform: ${flipped}${style.getPropertyPriority('transform') ? ' !important' : ''}`);
      return decls;
    }

    // Negate the horizontal part of translate()/translateX()/translate3d(),
    // e.g. the mobile off-canvas sidebar's translate3d(-290px, 0, 0). Paired
    // with the left↔right swap this keeps centring tricks like
    // `left: 50%; transform: translateX(-50%)` correct.
    function negate(x) {
      if (/^[+-]?0(\.0+)?([a-z%]*)$/i.test(x)) return null;
      if (/^(calc|var|min|max|clamp)\(/i.test(x)) return `calc(-1 * ${x})`;
      return x.startsWith('-') ? x.slice(1) : `-${x.replace(/^\+/, '')}`;
    }

    // Any rule with a translate is re-emitted, even a zero one, so state rules
    // like `.move--right { translate3d(0, 0, 0) }` keep winning over the
    // (now more specific) mirrored base rule.
    function flipTransform(value) {
      let found = false;
      const out = value.replace(/\b(translateX|translate3d|translate)\(\s*((?:calc|var|min|max|clamp)\([^()]*(?:\([^()]*\)[^()]*)*\)|[^,()\s]+)/gi, (m, fn, x) => {
        found = true;
        const n = negate(x);
        return n === null ? m : `${fn}(${n}`;
      });
      return found ? out : null;
    }

    function walk(rules, out) {
      for (const r of rules) {
        if (r.type === CSSRule.STYLE_RULE) {
          const sel = r.selectorText;
          if (!sel || sel.includes('[dir') || sel.includes(':dir(') || sel.includes('mmrtl')) continue;
          const decls = mirrorDecls(r.style);
          if (decls.length) out.push(`${scope(sel)} { ${decls.join('; ')}; }`);
        } else if (r.type === CSSRule.MEDIA_RULE || r.type === CSSRule.SUPPORTS_RULE) {
          const inner = [];
          walk(r.cssRules, inner);
          if (inner.length) {
            const kw = r.type === CSSRule.MEDIA_RULE ? '@media' : '@supports';
            out.push(`${kw} ${r.conditionText || r.media?.mediaText} { ${inner.join('\n')} }`);
          }
        } else if (r.cssRules && r.type !== CSSRule.KEYFRAMES_RULE) {
          walk(r.cssRules, out);
        }
      }
    }

    function sheets() {
      return [...document.styleSheets].filter(sh => !OWN.test(sh.ownerNode?.id || ''));
    }

    function ruleCount() {
      let n = 0;
      for (const sh of sheets()) {
        try { n += sh.cssRules.length; } catch (e) { /* cross-origin sheet */ }
      }
      return n;
    }

    function build() {
      const count = ruleCount();
      if (count === lastCount) return;
      lastCount = count;
      const out = [];
      for (const sh of sheets()) {
        let rules;
        try { rules = sh.cssRules; } catch (e) { continue; }
        walk(rules, out);
      }
      let st = document.getElementById(OUT_ID);
      if (!st) {
        st = document.createElement('style');
        st.id = OUT_ID;
      }
      // Keep it last so equal-specificity ties go to the mirror.
      (document.head || document.documentElement).appendChild(st);
      st.textContent = `${out.join('\n')}\n${RTL_EXTRA}`;
    }

    function schedule() {
      if (!on || queued) return;
      queued = true;
      setTimeout(() => { queued = false; if (on) build(); }, 300);
    }

    function configure(enabled) {
      if (enabled === on) return;
      on = enabled;
      if (on) {
        lastCount = -1;
        build();
        // styled-components insert rules via CSSOM without DOM mutations, so poll the rule count too.
        timer = setInterval(schedule, 3000);
      } else {
        clearInterval(timer);
        document.getElementById(OUT_ID)?.remove();
      }
    }

    return { configure, schedule };
  })();

  // ── Resize flip: Mattermost's LHS/RHS resize handles compute the new width
  // from horizontal mouse movement assuming LTR placement. Once the page is
  // mirrored the panels swap sides, so a drag moves the splitter the wrong way.
  // While a drag that started on a resize handle is in progress, reflect the
  // pointer's X coordinates around the drag start point before Mattermost's
  // listeners see them.
  // ── Right-click menu on posts: opens Mattermost's own "…" (dot) menu at the
  // cursor, with the hover-bar buttons (recent reactions, add reaction, reply,
  // apps…) as a row on top. Nothing is re-implemented: every entry clicks the
  // native control, so permissions, plugin items and shortcuts stay Mattermost's.
  // The browser's own menu is kept for links, images, media, code, inputs,
  // selected text, and Shift+right-click.
  const ContextMenu = (() => {
    let on = false;
    const NATIVE = 'a, img, video, audio, canvas, svg image, input, textarea, select, [contenteditable="true"], pre, code, ' +
      '.file-preview, .post-image, .post-image__column, .file-attachment, .markdown-inline-img, .attachment__image';

    // Pure: menu position for a click at (x, y), kept inside the viewport.
    // In RTL the menu opens to the left of the cursor, like native RTL menus.
    function placeMenu(x, y, w, h, vw, vh, rtl) {
      const M = 4;
      let left = rtl ? x - w : x;
      if (left + w > vw - M) left = x - w;
      if (left < M) left = Math.min(x, vw - w - M);
      let top = y;
      if (top + h > vh - M) top = y - h;
      if (top < M) top = Math.max(M, vh - h - M);
      return { left: Math.max(M, left), top: Math.max(M, top) };
    }

    function wantsNative(e) {
      if (e.shiftKey) return true;
      if (e.target.closest?.(NATIVE)) return true;
      const sel = window.getSelection?.();
      return Boolean(sel && !sel.isCollapsed && sel.toString().trim());
    }

    const nextFrame = () => new Promise(r => requestAnimationFrame(r));

    async function waitFor(fn, frames = 20) {
      for (let i = 0; i < frames; i++) {
        const v = fn();
        if (v) return v;
        await nextFrame();
      }
      return null;
    }

    function closeMenu(list) {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }

    // Copies of the hover-bar buttons; each forwards the click to the original,
    // which stays mounted while the dot menu is open.
    function quickBar(bar, dotBtn, list) {
      const row = document.createElement('div');
      row.className = 'mmrtl-cm-quick';
      row.setAttribute('role', 'group');
      for (const orig of bar.querySelectorAll('button')) {
        if (orig === dotBtn || dotBtn.contains(orig) || orig.disabled) continue;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'mmrtl-cm-btn';
        copy.innerHTML = orig.innerHTML;
        copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
        const label = orig.getAttribute('aria-label') || '';
        if (label) { copy.title = label; copy.setAttribute('aria-label', label); }
        copy.addEventListener('click', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          orig.click();
          closeMenu(list);
        });
        row.appendChild(copy);
      }
      return row.childElementCount ? row : null;
    }

    async function onContextMenu(e) {
      if (!on || e.defaultPrevented || wantsNative(e)) return;
      const post = e.target.closest?.('.post');
      if (!post || post.querySelector('textarea') || e.target.closest('.post-menu')) return;
      const bar = post.querySelector('.post-menu');
      // The dot ("…") menu only: the Apps button's id also contains "_button_".
      const dotBtn = bar?.querySelector('button[data-testid^="PostDotMenu-Button-"]') ||
        [...(bar?.querySelectorAll('button[aria-haspopup="true"]') || [])].find(b => /^[A-Z_]+_button_[a-z0-9]+$/.test(b.id));
      if (!dotBtn) return; // no menu for this post (system/ephemeral/failed) → browser menu
      e.preventDefault();
      const { clientX: x, clientY: y } = e;
      dotBtn.click();

      const menuId = dotBtn.getAttribute('aria-controls') || dotBtn.id.replace('_button_', '_dropdown_');
      const list = await waitFor(() => document.getElementById(menuId));
      if (!list || list.closest('.menuModal')) return; // mobile layout: leave the modal sheet alone
      const paper = list.closest('.MuiPaper-root, .MuiPopover-paper') || list.parentElement;
      if (!paper) return;

      const row = quickBar(bar, dotBtn, list);
      if (row) paper.insertBefore(row, paper.firstChild);
      await nextFrame(); // let MUI finish its own anchor positioning first, then override it

      const rtl = document.documentElement.dir === 'rtl';
      const { left, top } = placeMenu(x, y, paper.offsetWidth, paper.offsetHeight, innerWidth, innerHeight, rtl);
      paper.style.left = `${left}px`;
      paper.style.top = `${top}px`;
      paper.style.transformOrigin = `${rtl ? 'right' : 'left'} top`;
    }

    function injectCSS() {
      if (document.getElementById('mmrtl-cm-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-cm-style';
      st.textContent = `
        .mmrtl-cm-quick { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px 8px; border-bottom: 1px solid rgba(var(--center-channel-color-rgb), 0.12); }
        .mmrtl-cm-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; height: 32px; padding: 0 4px; border: 0; border-radius: 4px; background: transparent; color: rgba(var(--center-channel-color-rgb), 0.64); cursor: pointer; }
        .mmrtl-cm-btn:hover, .mmrtl-cm-btn:focus-visible { background: rgba(var(--center-channel-color-rgb), 0.08); color: rgba(var(--center-channel-color-rgb), 0.8); }`;
      (document.head || document.documentElement).appendChild(st);
    }

    function configure(enabled) {
      if (enabled === on) return;
      on = enabled;
      if (on) { injectCSS(); document.addEventListener('contextmenu', onContextMenu, true); }
      else document.removeEventListener('contextmenu', onContextMenu, true);
    }

    return { configure, placeMenu };
  })();

  // Opens a message's reply thread on a single or double click (user setting).
  // It presses the message's own reply button, so Mattermost opens the thread.
  const ReplyClick = (() => {
    let mode = 'off';
    const SKIP = 'a, button, input, textarea, select, label, img, video, audio, canvas, pre, code, [contenteditable="true"], [role="button"], ' +
      '.post-menu, .post__header, .post-reaction-list, .post-image, .file-preview, .file-attachment, .attachment, .emoticon, .post-preview, .mmrtl-cm-quick';
    const nextFrame = () => new Promise(r => requestAnimationFrame(r));

    // The center-channel message ID for a click that should open the thread, or null.
    function postIdFor(e, dbl) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return null;
      const post = e.target.closest?.('.post');
      if (!post || !/^post_[a-z0-9]+$/.test(post.id) || post.classList.contains('post--system')) return null;
      if (e.target.closest(SKIP) || post.querySelector('textarea')) return null;
      if (!dbl) {
        const sel = window.getSelection?.();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return null;
      }
      return post.id.slice(5);
    }

    // Presses the reply button of a message in the center channel; the hover
    // bar is rendered on hover, so the message is hovered first if needed.
    async function openThread(pid, frames = 20) {
      for (let i = 0; i < frames; i++) {
        const btn = document.getElementById(`CENTER_commentIcon_${pid}`);
        if (btn) { btn.click(); return true; }
        const post = document.getElementById(`post_${pid}`);
        if (post) for (const type of ['mouseover', 'mouseenter', 'mousemove']) post.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' }));
        await nextFrame();
      }
      return false;
    }

    function onClick(e) {
      const pid = mode === 'single' && postIdFor(e, false);
      if (pid) openThread(pid, 4);
    }
    function onDblClick(e) {
      const pid = mode === 'double' && postIdFor(e, true);
      if (!pid) return;
      window.getSelection?.()?.removeAllRanges();
      openThread(pid, 4);
    }

    function configure(value) {
      const next = value === 'single' || value === 'double' ? value : 'off';
      if (next === mode) return;
      if (mode === 'off') { document.addEventListener('click', onClick); document.addEventListener('dblclick', onDblClick); }
      mode = next;
      if (mode === 'off') { document.removeEventListener('click', onClick); document.removeEventListener('dblclick', onDblClick); }
    }

    return { configure, openThread };
  })();

  const ResizeFlip = (() => {
    const CURSORS = new Set(['col-resize', 'ew-resize', 'e-resize', 'w-resize']);
    const DOWN = ['mousedown', 'pointerdown'];
    const MOVE = ['mousemove', 'pointermove', 'mouseup', 'pointerup'];
    // pointerup precedes mouseup, so the drag ends on mouseup to flip both.
    const END = ['mouseup', 'pointercancel', 'blur'];
    const X_PROPS = ['clientX', 'pageX', 'screenX', 'x'];
    let on = false;
    let start = null; // { clientX, pageX, screenX, x } at drag start

    function isHandle(t) {
      return t instanceof Element && CURSORS.has(getComputedStyle(t).cursor);
    }

    function onDown(e) {
      start = null;
      if (e.button !== 0 || document.documentElement.getAttribute('dir') !== 'rtl') return;
      if (!isHandle(e.target)) return;
      start = {};
      for (const k of X_PROPS) start[k] = e[k];
    }

    function onMove(e) {
      if (!start) return;
      for (const k of X_PROPS) {
        Object.defineProperty(e, k, { value: 2 * start[k] - e[k], configurable: true });
      }
      if (typeof e.movementX === 'number') {
        Object.defineProperty(e, 'movementX', { value: -e.movementX, configurable: true });
      }
    }

    function onEnd() { start = null; }

    function configure(enabled) {
      if (enabled === on) return;
      on = enabled;
      const fn = on ? addEventListener : removeEventListener;
      for (const t of DOWN) fn(t, onDown, true);
      for (const t of MOVE) fn(t, onMove, true);
      for (const t of END) fn(t, onEnd, false);
      start = null;
    }

    return { configure };
  })();

  // ── File preview: .md/.markdown/.mdx attachments open rendered (Persian-aware
  // direction, code highlighting, Mermaid); .csv/.tsv as a table and .json
  // pretty-printed, instead of as raw text.
  // The file is rendered inside a sandboxed iframe with an opaque origin and a
  // strict CSP, so a hostile file can't reach the session, cookies or API.
  // The parent fetches the text with the user's session and posts it once.
  const MdPreview = (() => {
    const KINDS = { md: 'markdown', markdown: 'markdown', mdx: 'markdown', csv: 'csv', tsv: 'csv', json: 'json' };
    // Office files are read as bytes and parsed inside the frame (office.js).
    const OFFICE = { xlsx: 'xlsx', docx: 'docx', pptx: 'pptx' };
    const MAX_OFFICE_BYTES = 25 * 1024 * 1024;
    // Source files → Prism language (only languages bundled in vendor/prism.js).
    const CODE = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', tsx: 'tsx',
      py: 'python', cs: 'csharp', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
      go: 'go', rs: 'rust', php: 'php', rb: 'ruby', kt: 'kotlin', kts: 'kotlin', swift: 'swift', sql: 'sql',
      yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
      sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
      html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', csproj: 'markup', config: 'markup',
      css: 'css', scss: 'css', less: 'css', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
      dockerfile: 'docker', regex: 'regex'
    };
    const MAX_BYTES = 2 * 1024 * 1024;
    const DIR = () => `${basePath}/plugins/${PLUGIN_ID}/public/md-preview/`;
    const enabled = { markdown: true, data: true, code: true, office: true };
    let fontBytes = null;

    const extOf = fileInfo => {
      const ext = String(fileInfo?.extension || '').toLowerCase();
      // «Dockerfile» has no extension.
      return ext || (/^dockerfile$/i.test(fileInfo?.name || '') ? 'dockerfile' : '');
    };
    // HTML files open as the rendered page (scripts blocked); the frame has a
    // tab to see the source with Prism.
    const kindOf = fileInfo => {
      const ext = extOf(fileInfo);
      if (ext === 'html' || ext === 'htm') return 'html';
      if (OFFICE[ext]) return OFFICE[ext];
      return KINDS[ext] || (CODE[ext] ? 'code' : null);
    };
    const canPreview = fileInfo => {
      const kind = kindOf(fileInfo);
      if (kind === 'markdown') return enabled.markdown;
      if (kind === 'code' || kind === 'html') return enabled.code;
      if (OFFICE[kind]) return enabled.office;
      return Boolean(kind) && enabled.data;
    };

    function theme() {
      const rgb = getComputedStyle(document.body).getPropertyValue('--center-channel-bg-rgb').split(',').map(Number);
      if (rgb.length !== 3 || rgb.some(Number.isNaN)) return 'light';
      return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) < 128 ? 'dark' : 'light';
    }

    function srcdoc() {
      const base = `${location.origin}${DIR()}`;
      const csp = [
        "default-src 'none'",
        `script-src ${base}`,
        `style-src ${base} 'unsafe-inline'`, // Mermaid writes inline styles into its SVGs
        'img-src https: http: data:',
        'font-src data:'
      ].join('; ');
      return `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
        `<meta name="referrer" content="no-referrer">` +
        `<link rel="stylesheet" href="${base}frame.css">` +
        `<script src="${base}vendor/prism.js"></script><script src="${base}frame.js"></script>` +
        `</head><body></body></html>`;
    }

    async function loadFont() {
      if (fontBytes) return fontBytes.slice(0);
      try {
        const res = await fetch(`${basePath}/plugins/${PLUGIN_ID}/public/fonts/Vazirmatn-Regular.ttf`, { credentials: 'same-origin' });
        if (res.ok) fontBytes = await res.arrayBuffer();
      } catch (e) { /* frame falls back to system fonts */ }
      return fontBytes ? fontBytes.slice(0) : null;
    }

    // Text for most kinds; an ArrayBuffer for Office files.
    async function loadText(fileInfo) {
      const office = Boolean(OFFICE[kindOf(fileInfo)]);
      if (fileInfo.size > (office ? MAX_OFFICE_BYTES : MAX_BYTES)) throw new Error('too-large');
      const res = await fetch(fileInfo.url || `${basePath}/api/v4/files/${encodeURIComponent(fileInfo.id)}`, {
        credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (!res.ok) throw new Error(String(res.status));
      return office ? res.arrayBuffer() : res.text();
    }

    function Component(props) {
      const React = window.React;
      const { useEffect, useRef, useState, createElement: h } = React;
      const frameRef = useRef(null);
      const [error, setError] = useState(null);
      const fileInfo = props.fileInfo;

      useEffect(() => {
        let alive = true;
        let sent = false;
        const data = Promise.all([loadText(fileInfo), loadFont()]);
        data.catch(e => { if (alive) setError(e.message === 'too-large' ? 'too-large' : 'load'); });
        const onMessage = async e => {
          const win = frameRef.current?.contentWindow;
          if (sent || !win || e.source !== win || e.data?.type !== 'mmrtl-md-ready') return;
          sent = true; // one render per frame; never re-send the file
          try {
            const [md, font] = await data;
            const transfer = [font, md instanceof ArrayBuffer ? md : null].filter(Boolean);
            if (alive) win.postMessage({ type: 'mmrtl-md-render', md, kind: kindOf(fileInfo), ext: fileInfo.extension, lang: CODE[extOf(fileInfo)], name: fileInfo.name, theme: theme(), font }, '*', transfer);
          } catch (err) { /* error state already set */ }
        };
        window.addEventListener('message', onMessage);
        return () => { alive = false; window.removeEventListener('message', onMessage); };
      }, [fileInfo.id]);

      if (error) {
        return h('div', { className: 'mmrtl-md-error', dir: 'auto' }, error === 'too-large'
          ? (OFFICE[kindOf(fileInfo)]
            ? L('این فایل برای پیش‌نمایش بزرگ است (بیش از ۲۵ مگابایت). آن را دانلود کنید.', 'This file is too large to preview (over 25 MB). Download it instead.')
            : L('این فایل برای پیش‌نمایش بزرگ است (بیش از ۲ مگابایت). آن را دانلود کنید.', 'This file is too large to preview (over 2 MB). Download it instead.'))
          : L('بارگذاری فایل ممکن نشد.', 'The file could not be loaded.'));
      }
      return h('iframe', {
        ref: frameRef,
        className: 'mmrtl-md-frame',
        title: fileInfo.name,
        sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
        referrerPolicy: 'no-referrer',
        srcDoc: srcdoc()
      });
    }

    function injectCSS(doc = document) {
      if (doc.getElementById('mmrtl-md-style')) return;
      const st = doc.createElement('style');
      st.id = 'mmrtl-md-style';
      st.textContent = `
        .mmrtl-md-frame { display: block; width: min(1100px, 92vw); height: calc(100vh - 140px); border: 0; border-radius: 8px; background: transparent; }
        .mmrtl-md-error { padding: 32px; color: rgba(var(--center-channel-color-rgb), 0.8); background: var(--center-channel-bg); border-radius: 8px; }`;
      (doc.head || doc.documentElement).appendChild(st);
    }

    function register(registry) {
      if (typeof registry.registerFilePreviewComponent !== 'function' || !window.React) return;
      injectCSS();
      registry.registerFilePreviewComponent(canPreview, Component);
    }

    function configure({ markdown, data, code, office }) { enabled.markdown = markdown; enabled.data = data; enabled.code = code; enabled.office = office !== false; }

    // A preview frame for Markdown text that's already in memory (no file fetch).
    function createFrame(md) {
      injectCSS();
      const frame = document.createElement('iframe');
      frame.className = 'mmrtl-md-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
      frame.referrerPolicy = 'no-referrer';
      frame.srcdoc = srcdoc();
      let sent = false;
      const onMessage = async e => {
        if (!frame.isConnected) { window.removeEventListener('message', onMessage); return; }
        if (sent || e.source !== frame.contentWindow || e.data?.type !== 'mmrtl-md-ready') return;
        sent = true;
        window.removeEventListener('message', onMessage);
        const font = await loadFont();
        frame.contentWindow?.postMessage({ type: 'mmrtl-md-render', md, kind: 'markdown', theme: theme(), font }, '*', font ? [font] : []);
      };
      window.addEventListener('message', onMessage);
      return frame;
    }

    // A preview frame for an attachment outside Mattermost's preview modal
    // (folder views). win is the window the frame is shown in (pop-out aware).
    function createFileFrame(fileInfo, win = window) {
      injectCSS(win.document);
      const frame = win.document.createElement('iframe');
      frame.className = 'mmrtl-md-frame';
      frame.title = fileInfo.name;
      frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
      frame.referrerPolicy = 'no-referrer';
      frame.srcdoc = srcdoc();
      const data = Promise.all([loadText(fileInfo), loadFont()]);
      const fail = e => {
        const box = win.document.createElement('div');
        box.className = 'mmrtl-md-error';
        box.dir = 'auto';
        box.textContent = e && e.message === 'too-large'
          ? L('این فایل برای پیش‌نمایش بزرگ است. آن را دانلود کنید.', 'This file is too large to preview. Download it instead.')
          : L('بارگذاری فایل ممکن نشد.', 'The file could not be loaded.');
        frame.replaceWith(box);
      };
      data.catch(fail);
      let sent = false;
      const onMessage = async e => {
        if (!frame.isConnected) { win.removeEventListener('message', onMessage); return; }
        if (sent || e.source !== frame.contentWindow || e.data?.type !== 'mmrtl-md-ready') return;
        sent = true;
        win.removeEventListener('message', onMessage);
        try {
          const [md, font] = await data;
          const transfer = [font, md instanceof ArrayBuffer ? md : null].filter(Boolean);
          frame.contentWindow?.postMessage({ type: 'mmrtl-md-render', md, kind: kindOf(fileInfo), ext: fileInfo.extension, lang: CODE[extOf(fileInfo)], name: fileInfo.name, theme: theme(), font }, '*', transfer);
        } catch (err) { /* fail() already replaced the frame */ }
      };
      win.addEventListener('message', onMessage);
      return frame;
    }

    return { register, configure, canPreview, createFrame, createFileFrame };
  })();

  // ── Message → Markdown: the «MD» button on the hover bar turns a post into a
  // clean Markdown document (rule-based, no network), previews it in the
  // sandboxed preview frame, and offers copy / download as .md.
  const MdExport = (() => {
    const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
    const SEP = /^\s*([═=─━_*~#-])\1{4,}\s*$/;
    const NUMBERED = /^\s*([0-9۰-۹]+)[).]\s+(.*)$/;
    const BULLET = /^(\s*)[-*•]\s+(.*)$/;
    const SECTION = /^(بخش|فاز|مرحله|گام|Part|Section|Phase|Step)\s+\S+?\s*[):.\-–]/i;
    const ALREADY_MD = /^(#{1,6}\s|```|~~~|\|.*\|\s*$|>\s)/m;

    const toAsciiDigits = s => s.replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d)));
    const indentOf = s => s.match(/^\s*/)[0].length;
    const isBlank = s => !s.trim();

    // Wrap code-like tokens in backticks, outside existing code spans and URLs.
    function codeSpans(line) {
      return line.split(/(`[^`]*`|https?:\/\/\S+)/).map((part, i) => {
        if (i % 2) return part;
        return part
          .replace(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/{}.:\-]+)/g, '`$1 $2`')
          .replace(/(^|[\s(«])((?:\/[\w{}.\-]+){2,}\/?)(?=$|[\s)»،,.:;])/g, (m, pre, p) => `${pre}\`${p}\``)
          .replace(/(^|[\s(«])((?:[A-Za-z_][\w-]*\/)+[\w.\-]+\.(?:cs|ts|tsx|js|jsx|json|md|py|go|java|sql|yml|yaml|xml|sh|css|html))(?=$|[\s)»،,:;])/g, (m, pre, p) => `${pre}\`${p}\``)
          .replace(/(^|[\s(«])((?:[A-Za-z_][\w.\-]*\/){2,}[\w.\-]*)(?=$|[\s)»،,:;])/g, (m, pre, p) => `${pre}\`${p}\``)
          .replace(/(^|[^\w`"/])([A-Za-z_]\w*(?:\.(?:"[^"\s]+"|[A-Za-z_]\w*))+)(?![\w`(])/g, (m, pre, id) => /[A-Z_"]/.test(id) && !/^(e\.g|i\.e|etc)\b/i.test(id) ? `${pre}\`${id}\`` : m)
          .replace(/(^|[\s(«])([a-z]+[A-Z]\w*(?:\/|\.\.)[a-z]+[A-Z]\w*)(?=$|[\s)»،,.:;])/g, '$1`$2`')
          .replace(/(^|[\s(«])([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ir|io|net|org|local|dev|internal))(?=$|[\s)»،,:;]|\.\s|\.$)/g, '$1`$2`')
          .replace(/(^|[\s(«])([a-z][a-z0-9]*(?:-[a-z0-9]+){2,})(?=$|[\s)»،,:;]|\.(?!\w))/g, '$1`$2`')
          .replace(/(^|[\s(«])([a-z][\w-]*\/[a-z][\w-]*)(?=$|[\s)»،,:;]|\.(?!\w))/g, '$1`$2`')
          .replace(/(^|[^\w`"/.])([a-z]+[A-Z]\w*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*){1,}|[a-z]+_[a-z_0-9]+)(?![\w`])/g, '$1`$2`')
          .replace(/(^|[\s(«])"([A-Za-z0-9_./:\-]+)"(?=$|[\s)»،,.:;|])/g, '$1`"$2"`')
          .replace(/(^|[\s(«])([\w-]+\.(?:md|cs|ts|tsx|js|jsx|json|py|go|java|sql|yml|yaml|xml|sh|csv|env|txt|log))(?=$|[\s)»،,:;])/g, '$1`$2`')
          .replace(/(^|[\s(«])([A-Za-z]\w*__\w+|[a-z]\w*\[\])(?=$|[\s)»،,.:;])/g, '$1`$2`')
          .replace(/(^|[\s(«])((?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40})(?=$|[\s)»،,.:;])/g, '$1`$2`');
      }).join('');
    }

    // «کلید: مقدار» — a short label (≤ 4 words, no code/parens/URL) before a colon.
    const KV = /^([^\s:`()«»][^:`()«»]{0,34}?)\s*[:：]\s+(\S.*)$/;
    const kvOf = t => {
      const m = t.match(KV);
      if (!m || m[1].trim().split(/\s+/).length > 4 || /^\d+$/.test(m[1].trim()) || /https?$/i.test(m[1])) return null;
      return { key: m[1].trim(), value: m[2] };
    };
    // A line that only introduces what follows: ends with a colon, no value.
    const isLabel = t => /[:：]$/.test(t) && t.length <= 90 && !/^[-*•]\s/.test(t);
    const boldKey = t => {
      const kv = kvOf(t);
      return kv ? `**${kv.key}:** ${codeSpans(kv.value)}` : codeSpans(t);
    };
    const ENDS_SENTENCE = /[.!?؟؛،,]$/;

    // Collect a {…}/[…] block: from `i` until the brackets balance.
    function takeBracketBlock(lines, i) {
      let depth = 0;
      const out = [];
      for (let j = i; j < lines.length; j++) {
        const t = lines[j].replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '');
        for (const c of t) {
          if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') depth--;
        }
        out.push(lines[j]);
        if (depth <= 0) return { block: out, next: j + 1 };
        if (out.length > 200) break;
      }
      return null;
    }

    function dedent(lines) {
      const ind = Math.min(...lines.filter(l => l.trim()).map(indentOf));
      return lines.map(l => l.slice(Number.isFinite(ind) ? ind : 0));
    }

    function convertBody(text) {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const out = [];
      const emit = s => out.push(s);
      const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
      const nextContent = from => { for (let k = from; k < lines.length; k++) if (!isBlank(lines[k])) return k; return -1; };
      let inFence = false;
      let listContext = false;
      let bulletIndents = [];

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
        if (/^(```|~~~)/.test(t)) { inFence = !inFence; emit(raw); continue; }
        if (inFence) { emit(raw); continue; }
        if (!t) { blank(); listContext = false; bulletIndents = []; continue; }

        // ═══ / ─── separators; a line framed by two separators is a section title.
        if (SEP.test(t)) {
          const k = nextContent(i + 1);
          const k2 = k >= 0 ? nextContent(k + 1) : -1;
          if (k >= 0 && k2 >= 0 && SEP.test(lines[k2].trim()) && lines[k].trim().length <= 120) {
            blank(); emit('---'); blank(); emit(`## ${codeSpans(lines[k].trim())}`); blank();
            i = k2;
          } else { blank(); emit('---'); blank(); }
          listContext = false;
          continue;
        }

        // JSON-like or code-like bracket blocks → fenced code.
        if (/^[{[]/.test(t)) {
          const got = takeBracketBlock(lines, i);
          if (got && got.block.length > 1) {
            const looksJson = /"[^"]+"\s*:/.test(got.block.join('\n'));
            blank(); emit('```' + (looksJson ? 'jsonc' : 'text')); dedent(got.block).forEach(emit); emit('```'); blank();
            i = got.next - 1;
            continue;
          }
        }

        if (/^(?:⚠|❗|❌|(?:نکته|توجه|هشدار|Note|Warning)\s*[:：])/u.test(t) && indentOf(raw) < 2 && !listContext) {
          blank(); emit(`> ${boldKey(t)}`); blank();
          continue;
        }

        if (SECTION.test(t) && t.length <= 160) { blank(); emit(`## ${codeSpans(t)}`); blank(); listContext = false; continue; }

        // «۱) …» — a section heading when it introduces indented/structured content, else a list item.
        const num = t.match(NUMBERED);
        if (num && indentOf(raw) < 2) {
          const k = nextContent(i + 1);
          const introducesBlock = k >= 0 && k === i + 1 && (indentOf(lines[k]) >= 2 || /^[{[]/.test(lines[k].trim()) || BULLET.test(lines[k]));
          // «۱. عنوان» standing alone between blank lines, followed by prose → heading
          const standalone = (i === 0 || isBlank(lines[i - 1])) && k > i + 1 && t.length <= 70 && !ENDS_SENTENCE.test(t) && !NUMBERED.test(lines[k]);
          if ((introducesBlock || standalone) && t.length <= 160) {
            blank(); emit(`### ${codeSpans(t)}`); blank(); listContext = false;
          } else {
            emit(`${toAsciiDigits(num[1])}. ${codeSpans(num[2])}`); listContext = true;
          }
          continue;
        }

        const bul = raw.match(BULLET);
        if (bul) {
          // Nest only when this bullet is indented deeper than the one before it.
          const ind = bul[1].length;
          if (!listContext) bulletIndents = [];
          while (bulletIndents.length && ind < bulletIndents[bulletIndents.length - 1]) bulletIndents.pop();
          if (!bulletIndents.length || ind > bulletIndents[bulletIndents.length - 1]) bulletIndents.push(ind);
          const depth = '  '.repeat(Math.min(bulletIndents.length - 1, 2));
          emit(`${depth}- ${boldKey(bul[2])}`); listContext = true;
          continue;
        }

        // Standalone short line between blank lines → section heading («تست‌ها»، «علت 401:»).
        if ((i === 0 || isBlank(lines[i - 1])) && i + 1 < lines.length && isBlank(lines[i + 1]) && nextContent(i + 1) >= 0 &&
            t.length <= 60 && !ENDS_SENTENCE.test(t) && !kvOf(t)) {
          blank(); emit(`## ${codeSpans(t.replace(/\s*[:：]$/, ''))}`); blank(); listContext = false;
          continue;
        }

        // A block of consecutive «key: value» / «label:» lines → a bulleted list with bold keys;
        // lines after a label (until the next label or blank line) nest under it.
        {
          let j = i;
          const block = [];
          while (j < lines.length && !isBlank(lines[j]) && !BULLET.test(lines[j]) && !SEP.test(lines[j].trim())) block.push(lines[j++].trim());
          const structured = block.filter(l => kvOf(l) || isLabel(l)).length;
          if (block.length >= 2 && structured >= Math.max(2, Math.ceil(block.length * 0.6))) {
            blank();
            let nested = false;
            for (const l of block) {
              if (isLabel(l) && !kvOf(l)) { emit(`- **${codeSpans(l.replace(/\s*[:：]$/, ''))}:**`); nested = true; continue; }
              emit(`${nested ? '  ' : ''}- ${boldKey(l)}`);
            }
            blank(); listContext = false;
            i = j - 1;
            continue;
          }
          // A label followed directly by plain lines → bold label + bullets.
          if (isLabel(t) && block.length >= 3 && block.slice(1).every(l => !isLabel(l) && l.length <= 140)) {
            blank(); emit(`**${codeSpans(t.replace(/\s*[:：]$/, ''))}:**`); blank();
            block.slice(1).forEach(l => emit(`- ${boldKey(l)}`));
            blank(); listContext = false;
            i = j - 1;
            continue;
          }
        }

        // Indented continuation under a list item.
        if (listContext && indentOf(raw) >= 2) { emit(`  ${codeSpans(t)}`); continue; }

        // Plain text: keep the author's line breaks; «کلید: …» gets a bold key.
        const prev = out[out.length - 1];
        if (prev && !/^(#|---|```|>|- |\s*\d+\. )/.test(prev) && prev !== '') out[out.length - 1] = `${prev}  `;
        if (isLabel(t) && !kvOf(t)) emit(`**${codeSpans(t.replace(/\s*[:：]$/, ''))}:**`);
        else if (/^(یک )?(نکته|توجه|هشدار)\s*[:：]/.test(t)) { blank(); emit(`> ${boldKey(t)}`); blank(); }
        else emit(boldKey(t));
        listContext = false;
      }
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    // Pure: post text + metadata → Markdown document.
    function toMarkdown(text, meta = {}) {
      text = String(text || '').trim();
      let body = ALREADY_MD.test(text) ? text : convertBody(text);
      const head = [];
      // A short first line that reads as a title becomes the H1 (instead of being repeated).
      // A section heading that opens the message is really its title.
      if (/^## /.test(body) && !/^# /m.test(body)) body = body.slice(1);
      const lines = body.split('\n');
      const first = lines[0] || '';
      if (!/^#{1,2}\s/.test(first) && first.length <= 80 && !/[.!?؟:،,]\s*$/.test(first) && lines[1] === '' && lines.slice(2).some(l => l.trim()) && !/^(- |\d+\. |>|```)/.test(first)) {
        head.push(`# ${first.replace(/\s+$/, '')}`, '');
        body = lines.slice(2).join('\n');
      }
      const info = metaLine(meta);
      if (info) head.push(info, '');
      return `${head.length ? `${head.join('\n')}\n` : ''}${body}\n`;
    }

    function metaLine(meta = {}) {
      const info = [
        meta.author && `**نویسنده:** ${meta.author}`,
        meta.channel && `**کانال:** ${meta.channel}`,
        meta.date && `**تاریخ:** ${meta.date}`
      ].filter(Boolean);
      return info.length ? `> ${info.join(' · ')}` : '';
    }

    // AI output + the same metadata line, placed after its H1 when it has one.
    function withMeta(md, meta) {
      const info = metaLine(meta);
      if (!info) return `${md.trim()}\n`;
      const lines = md.trim().split('\n');
      if (/^# /.test(lines[0])) return `${lines[0]}\n\n${info}\n\n${lines.slice(1).join('\n').trim()}\n`;
      return `${info}\n\n${md.trim()}\n`;
    }

    // ── AI («هوشمند») conversion: the plugin server calls LiteLLM; the browser
    // only sends the post ID (no text, no key).
    const AI_API = () => `${basePath}/plugins/${PLUGIN_ID}/api/v1/ai`;
    let aiStatus = null;
    let aiStatusAt = 0;

    function csrfToken() {
      const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }

    function aiEnabled() {
      if (!aiStatus || Date.now() - aiStatusAt > 5 * 60 * 1000) {
        aiStatusAt = Date.now();
        aiStatus = fetch(`${AI_API()}/status`, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
          .then(r => (r.ok ? r.json() : { enabled: false }))
          .then(j => Boolean(j.enabled))
          .catch(() => false);
      }
      return aiStatus;
    }

    const AI_ERRORS = {
      rate_limited: ['تعداد درخواست‌های شما زیاد است؛ کمی بعد دوباره امتحان کنید.', 'Too many requests; try again shortly.'],
      busy: ['مدل الان مشغول است؛ چند لحظه بعد دوباره امتحان کنید.', 'The model is busy; try again in a moment.'],
      timeout: ['پاسخ مدل طول کشید؛ نسخهٔ ساده نمایش داده می‌شود.', 'The model took too long; showing the simple version.'],
      too_long: ['پیام برای تبدیل هوشمند بلند است؛ نسخهٔ ساده نمایش داده می‌شود.', 'The message is too long for AI conversion; showing the simple version.'],
      disabled: ['تبدیل هوشمند غیرفعال شده است.', 'AI conversion is turned off.']
    };

    async function aiConvert(postId) {
      const res = await fetch(`${AI_API()}/markdown`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ post_id: postId })
      });
      let j = {};
      try { j = await res.json(); } catch (e) { /* non-JSON error */ }
      if (!res.ok || !j.markdown) {
        const [fa, en] = AI_ERRORS[j.error] || ['تبدیل هوشمند ممکن نشد؛ نسخهٔ ساده نمایش داده می‌شود.', 'AI conversion failed; showing the simple version.'];
        throw new Error(L(fa, en));
      }
      return j;
    }

    function titleFrom(text) {
      const line = String(text || '').split('\n').map(l => l.replace(/[#*`>═=─_~]+/g, '').trim()).find(Boolean) || 'message';
      return line.length > 70 ? line.slice(0, 70).replace(/\s+\S*$/, '') : line;
    }

    // ZWNJ becomes a space: browsers turn it into "_" in download names.
    const fileName = title => `${title.replace(/[\\/:*?"<>|\u0000-\u001f\u200c…]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[\s.]+$/, '') || 'message'}.md`;

    // ── UI ──
    let overlay = null;

    function postFor(msgEl) {
      const holder = msgEl.closest('[id^="post_"], [id^="rhsPost_"], [id^="searchResult_"]');
      const m = (holder?.id || '').match(/_([a-z0-9]{26})$/);
      return m ? store.getState().entities.posts.posts[m[1]] : null;
    }

    function metaFor(post) {
      const e = store.getState().entities;
      const u = e.users.profiles[post.user_id];
      const ch = e.channels.channels[post.channel_id];
      const date = new Intl.DateTimeFormat(isFa() ? 'fa-IR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(post.create_at));
      return {
        author: u ? `@${u.username}` : '',
        channel: ch && ch.type !== 'D' && ch.type !== 'G' ? `~${ch.display_name || ch.name}` : '',
        date
      };
    }

    function close() {
      overlay?.remove();
      overlay = null;
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

    function download(md, name) {
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function open(msgEl) {
      const post = msgEl && postFor(msgEl);
      if (!post || !post.message) return;
      close();
      injectCSS();
      const title = titleFrom(post.message);
      const meta = metaFor(post);
      // One document per mode; edits in the source tab stay with their mode.
      const docs = { simple: toMarkdown(post.message, meta), ai: null };
      let mode = 'simple';
      let tab = 'preview';
      let aiBusy = false;

      overlay = document.createElement('div');
      overlay.className = 'mmrtl-mdx';
      overlay.dir = isFa() ? 'rtl' : 'ltr';
      overlay.innerHTML = `
        <div class="mmrtl-mdx__box" role="dialog" aria-modal="true">
          <div class="mmrtl-mdx__head">
            <strong class="mmrtl-mdx__title" dir="auto"></strong>
            <div class="mmrtl-mdx__tabs mmrtl-mdx__modes" role="tablist" hidden>
              <button type="button" data-mode="simple" class="on">${L('ساده', 'Simple')}</button>
              <button type="button" data-mode="ai">${L('هوشمند (AI)', 'Smart (AI)')}</button>
            </div>
            <div class="mmrtl-mdx__tabs" role="tablist">
              <button type="button" data-tab="preview" class="on">${L('پیش‌نمایش', 'Preview')}</button>
              <button type="button" data-tab="source">${L('متن Markdown', 'Markdown source')}</button>
            </div>
            <button type="button" data-act="copy">${L('کپی', 'Copy')}</button>
            <button type="button" data-act="download" class="primary">${L('دانلود .md', 'Download .md')}</button>
            <button type="button" data-act="close" aria-label="${L('بستن', 'Close')}">✕</button>
          </div>
          <div class="mmrtl-mdx__note" hidden></div>
          <div class="mmrtl-mdx__body"></div>
        </div>`;
      overlay.querySelector('.mmrtl-mdx__title').textContent = fileName(title);
      const body = overlay.querySelector('.mmrtl-mdx__body');
      const note = overlay.querySelector('.mmrtl-mdx__note');
      const source = document.createElement('textarea');
      source.className = 'mmrtl-mdx__source';
      source.dir = 'auto';
      source.spellcheck = false;
      source.addEventListener('input', () => { docs[mode] = source.value; });

      const setNote = (text, kind) => {
        note.hidden = !text;
        note.textContent = text || '';
        note.dataset.kind = kind || '';
      };
      const current = () => docs[mode] ?? docs.simple;
      const render = () => {
        overlay.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
        overlay.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
        body.textContent = '';
        if (aiBusy && mode === 'ai') {
          const wait = document.createElement('div');
          wait.className = 'mmrtl-mdx__wait';
          wait.textContent = L('در حال تبدیل با AI… (ممکن است چند ثانیه طول بکشد)', 'Converting with AI… (this can take a few seconds)');
          body.appendChild(wait);
          return;
        }
        source.value = current();
        body.appendChild(tab === 'source' ? source : MdPreview.createFrame(current()));
      };

      async function useAi() {
        mode = 'ai';
        if (docs.ai) {
          setNote(L('تولیدشده با AI؛ پیش از استفاده بررسی کنید.', 'Generated by AI; review before use.'), 'ai');
          return render();
        }
        if (aiBusy) return render();
        aiBusy = true;
        setNote('', '');
        render();
        try {
          const j = await aiConvert(post.id);
          docs.ai = withMeta(j.markdown, meta);
          setNote(j.truncated
            ? L('تولیدشده با AI؛ خروجی به سقف طول رسید و ممکن است ناقص باشد.', 'Generated by AI; output hit the length limit and may be incomplete.')
            : L('تولیدشده با AI؛ پیش از استفاده بررسی کنید.', 'Generated by AI; review before use.'), j.truncated ? 'warn' : 'ai');
        } catch (err) {
          mode = 'simple';
          setNote(err.message, 'warn');
        } finally {
          aiBusy = false;
          if (overlay) render();
        }
      }

      aiEnabled().then(on => {
        const modes = overlay?.querySelector('.mmrtl-mdx__modes');
        if (modes) modes.hidden = !on;
      });

      overlay.addEventListener('click', e => {
        if (e.target === overlay) return close();
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.tab) { tab = btn.dataset.tab; render(); }
        else if (btn.dataset.mode === 'ai') useAi();
        else if (btn.dataset.mode === 'simple') { mode = 'simple'; setNote('', ''); render(); }
        else if (btn.dataset.act === 'close') close();
        else if (btn.dataset.act === 'download') download(current(), fileName(title));
        else if (btn.dataset.act === 'copy') {
          navigator.clipboard?.writeText(current()).then(() => {
            const label = btn.textContent;
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = label; }, 1200);
          }).catch(() => {});
        }
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      render();
    }

    function injectCSS() {
      if (document.getElementById('mmrtl-mdx-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-mdx-style';
      st.textContent = `
        .mmrtl-mdx { position: fixed; inset: 0; z-index: 2147483001; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); }
        .mmrtl-mdx__box { display: flex; flex-direction: column; width: min(1100px, 94vw); height: min(860px, 92vh); background: var(--center-channel-bg); color: var(--center-channel-color); border-radius: 10px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
        .mmrtl-mdx__head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid rgba(var(--center-channel-color-rgb), .12); }
        .mmrtl-mdx__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mmrtl-mdx__head button { border: 1px solid rgba(var(--center-channel-color-rgb), .16); background: transparent; color: inherit; border-radius: 6px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 13px; }
        .mmrtl-mdx__head button:hover { background: rgba(var(--center-channel-color-rgb), .08); }
        .mmrtl-mdx__head button.primary { background: var(--button-bg); color: var(--button-color); border-color: transparent; }
        .mmrtl-mdx__tabs { display: flex; gap: 2px; }
        .mmrtl-mdx__tabs button.on { background: rgba(var(--button-bg-rgb), .12); color: var(--button-bg); border-color: rgba(var(--button-bg-rgb), .4); }
        .mmrtl-mdx__body { flex: 1; min-height: 0; display: flex; }
        .mmrtl-mdx__modes[hidden] { display: none; }
        .mmrtl-mdx__note { padding: 6px 14px; font-size: 12.5px; background: rgba(var(--button-bg-rgb), .08); color: var(--center-channel-color); border-bottom: 1px solid rgba(var(--center-channel-color-rgb), .08); }
        .mmrtl-mdx__note[data-kind="warn"] { background: rgba(var(--away-indicator-rgb, 255, 188, 66), .18); }
        .mmrtl-mdx__wait { flex: 1; display: flex; align-items: center; justify-content: center; color: rgba(var(--center-channel-color-rgb), .64); }
        .mmrtl-mdx__body iframe { flex: 1; width: 100%; height: 100%; border: 0; }
        .mmrtl-mdx__source { flex: 1; margin: 0; padding: 16px; border: 0; resize: none; background: transparent; color: inherit; font: 13.5px/1.7 Consolas, "Cascadia Code", monospace; unicode-bidi: plaintext; }`;
      (document.head || document.documentElement).appendChild(st);
    }

    return { open, close, toMarkdown, titleFrom, fileName };
  })();

  // ── Read receipts («تیک دیده‌شدن»): ✓ sent, ✓✓ seen, under the user's own
  // posts in the current channel. Server side decides who may see what: the
  // admin turns it on, every user gets a one-time notice first, and only
  // «seen / not seen» per post comes back — never view times.
  // ── Shared message folders («پوشه‌ها»). Talks to /api/v1/folders; the server
  // decides everything (membership, approvals, limits). A 404 with code
  // "disabled" means the admin hasn't turned the feature on.
  // Inserts or refreshes a <style> by id. version changes on every release, so an
  // upgraded plugin replaces the old rules even if the page was not reloaded.
  const STYLE_VERSION = '2.8.1';
  function upsertStyle(doc, id, css) {
    let st = doc.getElementById(id);
    if (st && st.dataset.v === STYLE_VERSION) return;
    if (!st) {
      st = doc.createElement('style');
      st.id = id;
      (doc.head || doc.documentElement).appendChild(st);
    }
    st.dataset.v = STYLE_VERSION;
    st.textContent = css;
  }

  const Folders = (() => {
    const API = () => `${basePath}/plugins/${PLUGIN_ID}/api/v1/folders`;
    const V4 = path => `${basePath}/api/v4${path}`;
    const names = new Map(); // user id → display name, filled from /users/ids
    const listeners = new Set(); // called after any change (sidebar refresh)
    let overlay = null;
    let box = null;
    let selection = []; // message IDs to add (from a message menu or multi-select)
    let rhs = null;     // { showRHSPlugin, hideRHSPlugin } when the right-hand panel is registered
    let host = null;    // the panel's (or page's) element while it is open
    let hostKind = null; // 'rhs' or 'page'
    let pageMode = false; // user setting: open folders in the center area
    let pageRoute = false; // the center-area route is registered
    let pop = null;     // open ⋮ / right-click menu
    let pending = null; // view to render once the panel mounts
    let scope = null;   // { label, match(folder) } when opened from a conversation header
    // Where the panel component should portal Mattermost's editor (or null).
    let editorSlot = null;
    const editorSubs = new Set();
    function setEditor(slot) {
      if (slot === editorSlot) return;
      editorSlot = slot;
      for (const fn of editorSubs) { try { fn(slot); } catch (e) { /* ignore */ } }
    }

    class FolderApiError extends Error {
      constructor(status, code) { super(code); this.status = status; this.code = code; }
    }

    function csrf() {
      const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }

    async function request(url, method, body) {
      const headers = { 'X-Requested-With': 'XMLHttpRequest' };
      if (method !== 'GET') headers['X-CSRF-Token'] = csrf();
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new FolderApiError(res.status, data.error || 'store_failed');
      return data;
    }
    const call = async (method, path = '', body) => {
      const data = await request(`${API()}${path}`, method, body);
      if (method !== 'GET') for (const fn of listeners) { try { fn(); } catch (e) { /* ignore */ } }
      return data;
    };

    const state = () => store.getState().entities;

    function displayName(u) {
      const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
      return full ? `${full} (@${u.username})` : `@${u.username}`;
    }

    function nameOf(uid) {
      if (uid === state().users.currentUserId) return L('شما', 'You');
      return names.get(uid) || L('کاربر', 'User');
    }

    // Loads display names for IDs we don't know yet (other members of a folder).
    async function loadNames(ids) {
      const missing = [...new Set(ids.filter(Boolean))].filter(id => !names.has(id));
      if (!missing.length) return;
      try {
        const res = await fetch(V4('/users/ids'), {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf() },
          body: JSON.stringify(missing)
        });
        if (!res.ok) return;
        for (const u of await res.json()) names.set(u.id, displayName(u));
      } catch (e) { /* names stay generic */ }
    }

    // Children are strings (text nodes) or nodes; never HTML.
    function el(tag, props = {}, ...kids) {
      const n = document.createElement(tag);
      Object.assign(n, props);
      for (const k of kids) {
        if (k == null) continue;
        n.append(k instanceof Node ? k : document.createTextNode(String(k)));
      }
      return n;
    }

    const kindLabels = () => ({
      personal: L('شخصی', 'Personal'), contact: L('مخاطب', 'Contact'),
      shared: L('اشتراکی', 'Shared'), group: L('گروهی', 'Group')
    });
    const errorLabels = () => ({
      disabled: L('این قابلیت توسط مدیر سیستم فعال نشده است.', 'This feature is not enabled by your administrator.'),
      not_found: L('پوشه یا پیام پیدا نشد.', 'Not found.'),
      invalid_state: L('این کار در وضعیت فعلی پوشه ممکن نیست.', 'Not possible in the folder’s current state.'),
      forbidden: L('اجازهٔ این کار را ندارید.', 'You are not allowed to do this.'),
      limit_reached: L('به سقف مجاز رسیده‌اید.', 'A limit has been reached.'),
      busy: L('سرور مشغول است؛ دوباره تلاش کنید.', 'The server is busy; try again.'),
      bad_request: L('اطلاعات وارد‌شده معتبر نیست.', 'The input is not valid.'),
      store_failed: L('خطا در ذخیرهٔ اطلاعات.', 'Could not save.')
    });

    function errorNode(err) {
      const text = err instanceof FolderApiError
        ? (errorLabels()[err.code] || errorLabels().store_failed)
        : L('خطای شبکه.', 'Network error.');
      return el('div', { className: 'err', role: 'alert' }, text);
    }

    // Styles go into the document the view is rendered in: the main window, or
    // the separate window when the user pops the right-hand panel out.
    function injectCSS(doc = document) {
      upsertStyle(doc, 'mmrtl-folders-style', `
        .mmrtl-folders { --mf-line: rgba(var(--center-channel-color-rgb), .12); --mf-soft: rgba(var(--center-channel-color-rgb), .05); --mf-muted: rgba(var(--center-channel-color-rgb), .64); color: var(--center-channel-color); font-size: 14px; line-height: 1.45; }
        .mmrtl-folders.overlay { position: fixed; inset: 0; z-index: 2147483002; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
        .mmrtl-folders .box { overflow: auto; padding: 16px 20px 20px; border-radius: 12px; background: var(--center-channel-bg); }
        .mmrtl-folders.overlay .box { width: min(560px, 94vw); max-height: 86vh; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
        .mmrtl-folders.rhs { height: 100%; overflow: auto; background: var(--center-channel-bg); }
        .mmrtl-folders.rhs .box { padding: 12px 16px 20px; border-radius: 0; }
        .mmrtl-folders.page { grid-column: 1 / span 2; grid-row: 1 / -1; min-width: 0; height: 100%; width: 100%; overflow: auto; background: var(--center-channel-bg); }
        .mmrtl-folders.page .box { max-width: 920px; margin: 0 auto; padding: 16px 24px 32px; border-radius: 0; }
        .mmrtl-folders.fmenu { position: fixed; z-index: 2147483004; min-width: 190px; max-width: 300px; padding: 6px 0; border: 1px solid var(--mf-line); border-radius: 8px; background: var(--center-channel-bg); box-shadow: 0 8px 24px rgba(0,0,0,.18); }
        .mmrtl-folders.fmenu button { display: block; width: 100%; padding: 8px 16px; border: 0; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; }
        .mmrtl-folders.fmenu button:hover, .mmrtl-folders.fmenu button:focus-visible { background: var(--mf-soft); outline: none; }
        .mmrtl-folders.fmenu button.danger { color: var(--error-text, #d24b4e); }
        .mmrtl-folders .kebab { flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 4px; background: transparent; color: var(--mf-muted); font-size: 18px; line-height: 1; cursor: pointer; }
        .mmrtl-folders .kebab:hover, .mmrtl-folders .kebab:focus-visible, .mmrtl-folders .kebab[aria-expanded="true"] { background: var(--mf-soft); color: inherit; }
        .mmrtl-folders .msgcard { position: relative; }
        .mmrtl-folders .msgcard > .msghead { padding-inline-end: 28px; }
        .mmrtl-folders .msgcard > .kebab { position: absolute; top: 6px; inset-inline-end: 6px; opacity: 0; }
        .mmrtl-folders .msgcard:hover > .kebab, .mmrtl-folders .msgcard > .kebab:focus-visible { opacity: 1; }
        .mmrtl-folders .top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .mmrtl-folders .top h3 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mmrtl-folders .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 4px; border: 1px solid var(--mf-line); background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .mmrtl-folders .btn:hover { background: var(--mf-soft); }
        .mmrtl-folders .btn.primary { background: var(--button-bg); color: var(--button-color); border-color: transparent; }
        .mmrtl-folders .btn.primary:hover { filter: brightness(1.08); }
        .mmrtl-folders .btn.danger { color: var(--error-text); border-color: rgba(var(--error-text-color-rgb, 210,75,78), .45); }
        .mmrtl-folders .btn.small { height: 26px; padding: 0 10px; font-size: 12px; }
        .mmrtl-folders .btn.block { width: 100%; height: 40px; font-size: 14px; }
        .mmrtl-folders .btn:disabled { opacity: .45; cursor: default; filter: none; }
        .mmrtl-folders .icon-btn { width: 32px; padding: 0; border-color: transparent; font-size: 16px; }
        .mmrtl-folders .section { margin: 18px 0 8px; font-size: 12px; font-weight: 600; color: var(--mf-muted); }
        .mmrtl-folders .list { display: flex; flex-direction: column; gap: 6px; }
        .mmrtl-folders .folder { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border: 1px solid var(--mf-line); border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; }
        .mmrtl-folders button.folder:hover { background: var(--mf-soft); border-color: rgba(var(--button-bg-rgb), .5); }
        .mmrtl-folders .ficon { flex: none; width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; background: rgba(var(--button-bg-rgb), .1); }
        .mmrtl-folders .ftext { flex: 1 1 auto; min-width: 0; }
        .mmrtl-folders .fname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mmrtl-folders .fmeta { margin-top: 2px; font-size: 12px; color: var(--mf-muted); }
        .mmrtl-folders .tag { display: inline-block; margin-inline-start: 6px; padding: 0 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: rgba(var(--away-indicator-rgb, 255,188,66), .22); }
        .mmrtl-folders .chev { flex: none; opacity: .45; }
        .mmrtl-folders .banner { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; background: rgba(var(--button-bg-rgb), .08); }
        .mmrtl-folders .banner.warn { background: rgba(var(--away-indicator-rgb, 255,188,66), .16); }
        .mmrtl-folders .banner.ok { background: rgba(var(--online-indicator-rgb, 6,214,160), .14); }
        .mmrtl-folders .banner .row { display: flex; gap: 8px; margin-top: 8px; }
        .mmrtl-folders .err { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; color: var(--error-text); background: rgba(var(--error-text-color-rgb, 210,75,78), .08); }
        .mmrtl-folders .empty { padding: 24px 12px; border: 1px dashed var(--mf-line); border-radius: 8px; text-align: center; color: var(--mf-muted); }
        .mmrtl-folders .kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
        .mmrtl-folders .kind { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 12px; border: 1px solid var(--mf-line); border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; }
        .mmrtl-folders .kind:hover { background: var(--mf-soft); }
        .mmrtl-folders .kind[aria-checked="true"] { border-color: var(--button-bg); box-shadow: inset 0 0 0 1px var(--button-bg); background: rgba(var(--button-bg-rgb), .06); }
        .mmrtl-folders .kind .ki { font-size: 20px; }
        .mmrtl-folders .kind .kt { font-weight: 600; }
        .mmrtl-folders .kind .kd { font-size: 12px; color: var(--mf-muted); }
        .mmrtl-folders .field { display: flex; flex-direction: column; gap: 6px; margin-top: 18px; }
        .mmrtl-folders .field > label, .mmrtl-folders .field > .label { font-size: 13px; font-weight: 600; }
        .mmrtl-folders .hint { font-size: 12px; color: var(--mf-muted); }
        .mmrtl-folders .input { height: 36px; padding: 0 12px; border-radius: 4px; border: 1px solid rgba(var(--center-channel-color-rgb), .16); background: var(--center-channel-bg); color: inherit; font: inherit; }
        .mmrtl-folders .input:focus { outline: none; border-color: var(--button-bg); box-shadow: 0 0 0 1px var(--button-bg); }
        .mmrtl-folders .counter { align-self: flex-end; font-size: 11px; color: var(--mf-muted); }
        .mmrtl-folders .hits { border: 1px solid var(--mf-line); border-radius: 6px; overflow: hidden; }
        .mmrtl-folders .hits:empty { display: none; }
        .mmrtl-folders .hit { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; }
        .mmrtl-folders .hit:hover, .mmrtl-folders .hit:focus-visible { background: var(--mf-soft); outline: none; }
        .mmrtl-folders .people { display: flex; flex-wrap: wrap; gap: 6px; }
        .mmrtl-folders .person { display: inline-flex; align-items: center; gap: 6px; padding-block: 3px; padding-inline: 4px 10px; border-radius: 14px; background: var(--mf-soft); font-size: 13px; }
        .mmrtl-folders .person .x { border: 0; background: transparent; color: inherit; cursor: pointer; opacity: .6; padding: 0 2px; font: inherit; }
        .mmrtl-folders .person.wait { opacity: .7; }
        .mmrtl-folders .avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: none; background: var(--mf-soft); }
        .mmrtl-folders .avatar.lg { width: 32px; height: 32px; }
        .mmrtl-folders .actions { display: flex; gap: 8px; margin-top: 22px; }
        .mmrtl-folders .msgs { display: flex; flex-direction: column; gap: 10px; }
        .mmrtl-folders .msgcard { padding: 10px 12px; border: 1px solid var(--mf-line); border-radius: 8px; }
        .mmrtl-folders .msghead { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .mmrtl-folders .msghead .who { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mmrtl-folders .msghead .where, .mmrtl-folders .msghead .when { font-size: 12px; color: var(--mf-muted); white-space: nowrap; }
        .mmrtl-folders .msghead .grow { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
        .mmrtl-folders .msgbody { position: relative; margin-top: 8px; overflow: hidden; overflow-wrap: anywhere; }
        .mmrtl-folders .msgbody.clamp { max-height: 220px; }
        .mmrtl-folders .msgbody.clamp::after { content: ''; position: absolute; inset: auto 0 0 0; height: 44px; background: linear-gradient(rgba(var(--center-channel-bg-rgb), 0), var(--center-channel-bg)); }
        .mmrtl-folders .msgbody .code { margin: 6px 0; border: 1px solid var(--mf-line); border-radius: 6px; overflow: hidden; direction: ltr; }
        .mmrtl-folders .msgbody .code-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 4px 3px 10px; font-size: 11px; color: var(--mf-muted); background: var(--mf-soft); }
        .mmrtl-folders [hidden] { display: none !important; }
        .mmrtl-folders .msgbody .code pre code { display: block; padding: 0; border: 0; background: none; color: inherit; font: inherit; white-space: inherit; }
        .mmrtl-folders .msgbody .code pre { margin: 0; padding: 8px 10px; overflow: auto; white-space: pre; border: 0; border-radius: 0; background: transparent; font-family: Menlo, Consolas, "Courier New", monospace; font-size: 12px; line-height: 1.55; text-align: left; unicode-bidi: isolate; }
        .mmrtl-folders .msgbody p { margin: 0 0 6px; }
        .mmrtl-folders .msgfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
        .mmrtl-folders .msgfoot .added { flex: 1 1 auto; font-size: 11px; color: var(--mf-muted); }
        .mmrtl-folders .more { border: 0; background: transparent; padding: 4px 0 0; color: var(--link-color); cursor: pointer; font: inherit; font-size: 12px; }
        .mmrtl-folders .msgcard.note { border-style: dashed; }
        .mmrtl-folders .files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .mmrtl-folders .files .thumb { display: block; width: 96px; height: 96px; border-radius: 6px; overflow: hidden; border: 1px solid var(--mf-line); }
        .mmrtl-folders .files .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .mmrtl-folders .files .file { display: flex; align-items: center; gap: 8px; max-width: 100%; padding: 6px 10px; border: 1px solid var(--mf-line); border-radius: 6px; color: inherit; text-decoration: none; font-size: 13px; }
        .mmrtl-folders .files .file:hover { background: var(--mf-soft); }
        .mmrtl-folders .files .fname2 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
        .mmrtl-folders .files .fsize { color: var(--mf-muted); font-size: 11px; white-space: nowrap; }
        .mmrtl-folders .files .filerow { display: inline-flex; align-items: stretch; max-width: 100%; }
        .mmrtl-folders .files .filerow .file { border-start-end-radius: 0; border-end-end-radius: 0; min-width: 0; }
        .mmrtl-folders .files .fdl { display: inline-flex; align-items: center; padding: 0 10px; border: 1px solid var(--mf-line); border-inline-start: 0; border-start-end-radius: 6px; border-end-end-radius: 6px; color: var(--mf-muted); text-decoration: none; }
        .mmrtl-folders .files .fdl:hover { background: var(--mf-soft); color: inherit; }
        .mmrtl-folders.viewer { position: fixed; inset: 0; z-index: 2147483005; display: flex; flex-direction: column; background: rgba(0,0,0,.86); color: #fff; }
        .mmrtl-folders.viewer .vbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; }
        .mmrtl-folders.viewer .vtitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .mmrtl-folders.viewer .vbtn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: 0; border-radius: 4px; background: transparent; color: #fff; font-size: 18px; text-decoration: none; cursor: pointer; }
        .mmrtl-folders.viewer .vbtn:hover, .mmrtl-folders.viewer .vbtn:focus-visible { background: rgba(255,255,255,.16); }
        .mmrtl-folders.viewer .vstage { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0 56px 24px; }
        .mmrtl-folders.viewer .vimg, .mmrtl-folders.viewer .vmedia { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; }
        .mmrtl-folders.viewer .mmrtl-md-frame { width: min(1100px, 100%); height: 100%; }
        .mmrtl-folders.viewer .vnone { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 32px 40px; border-radius: 8px; background: var(--center-channel-bg); color: var(--center-channel-color); }
        .mmrtl-folders.viewer .vnone .ficon2 { font-size: 40px; }
        .mmrtl-folders.viewer .vnav { position: absolute; top: 50%; width: 40px; height: 56px; margin-top: -28px; border: 0; border-radius: 6px; background: rgba(255,255,255,.12); color: #fff; font-size: 28px; cursor: pointer; }
        .mmrtl-folders.viewer .vnav:hover { background: rgba(255,255,255,.24); }
        .mmrtl-folders.viewer .vnav.prev { inset-inline-start: 8px; }
        .mmrtl-folders.viewer .vnav.next { inset-inline-end: 8px; }
        .mmrtl-folders.viewer [hidden] { display: none !important; }
        .mmrtl-folders .reactions { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 8px; }
        .mmrtl-folders .rchip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border: 1px solid transparent; border-radius: 4px; background: rgba(var(--center-channel-color-rgb), .08); color: rgba(var(--center-channel-color-rgb), .72); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
        .mmrtl-folders .rchip:hover { background: rgba(var(--center-channel-color-rgb), .16); }
        .mmrtl-folders .rchip.mine { border-color: var(--button-bg); background: rgba(var(--button-bg-rgb), .08); color: var(--button-bg); }
        .mmrtl-folders .rchip.add { width: 28px; justify-content: center; background: transparent; font-size: 16px; color: rgba(var(--center-channel-color-rgb), .56); }
        .mmrtl-folders .rchip.add:hover { background: rgba(var(--center-channel-color-rgb), .08); }
        .mmrtl-folders .rchip:disabled { cursor: default; }
        .mmrtl-folders .rpicker { display: flex; gap: 2px; padding: 4px; border: 1px solid var(--mf-line); border-radius: 8px; background: var(--center-channel-bg); box-shadow: 0 4px 12px rgba(0,0,0,.12); }
        .mmrtl-folders .rpicker button { border: 0; background: transparent; font-size: 18px; width: 30px; height: 30px; border-radius: 6px; cursor: pointer; }
        .mmrtl-folders .rpicker button:hover { background: var(--mf-soft); }
        .mmrtl-folders .rerr { font-size: 12px; color: var(--error-text); }
        .mmrtl-folders .composer { display: flex; flex-direction: column; gap: 8px; margin: 14px 0 6px; }
        .mmrtl-folders .composer-head { display: flex; align-items: center; justify-content: flex-start; }
        .mmrtl-folders .mm-editor { min-height: 48px; }
        /* Mattermost's editor outside its own layout: drop its 24px side gutters
           and the textarea resize grip, and frame it like the folder box. */
        .mmrtl-folders .mm-editor .AdvancedTextEditor { padding: 0 !important; }
        .mmrtl-folders .mm-editor .AdvancedTextEditor__body { border: 1px solid rgba(var(--center-channel-color-rgb), .16) !important; border-radius: 4px !important; box-shadow: none !important; }
        .mmrtl-folders .mm-editor .AdvancedTextEditor__body:focus-within { border-color: rgba(var(--center-channel-color-rgb), .32) !important; box-shadow: inset 0 0 0 1px rgba(var(--center-channel-color-rgb), .16) !important; }
        .mmrtl-folders .mm-editor textarea { resize: none !important; }
        .mmrtl-folders .mm-editor .AdvancedTextEditor__footer { padding: 2px 0 0 !important; min-height: 0; }
        .mmrtl-folders .mm-editor .postBoxIndicator { padding: 0 !important; }
        .mmrtl-folders .icon-fallback { display: none; }
        .mmrtl-folders .mmbox { position: relative; display: flex; flex-direction: column; border: 1px solid rgba(var(--center-channel-color-rgb), .16); border-radius: 4px; background: var(--center-channel-bg); }
        .mmrtl-folders .mmbox:focus-within { border-color: rgba(var(--center-channel-color-rgb), .32); box-shadow: inset 0 0 0 1px rgba(var(--center-channel-color-rgb), .16); }
        .mmrtl-folders .mmbox.drop { border-color: var(--button-bg); background: rgba(var(--button-bg-rgb), .04); }
        .mmrtl-folders .mmbox-text { min-height: 44px; max-height: 220px; padding: 12px 16px 6px; border: 0; outline: none; resize: none !important; background: transparent; color: inherit; font: inherit; font-size: 14px; line-height: 20px; }
        .mmrtl-folders .mmbox-files { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px; }
        .mmrtl-folders .mmbox-files:empty { display: none; }
        .mmrtl-folders .mmbox-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 6px 4px 10px; border: 1px solid var(--mf-line); border-radius: 4px; font-size: 12px; }
        .mmrtl-folders .mmbox-chip .n { min-width: 0; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mmrtl-folders .mmbox-chip .s { color: var(--mf-muted); }
        .mmrtl-folders .mmbox-chip .x { border: 0; background: transparent; color: inherit; opacity: .6; cursor: pointer; font: inherit; }
        .mmrtl-folders .mmbox-bar { display: flex; align-items: center; gap: 2px; padding: 4px 8px 6px; }
        .mmrtl-folders .mmbox-bar .grow { flex: 1 1 auto; }
        .mmrtl-folders .mmbox-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-radius: 4px; background: transparent; color: rgba(var(--center-channel-color-rgb), .64); font-size: 18px; cursor: pointer; }
        .mmrtl-folders .mmbox-btn:hover { background: rgba(var(--center-channel-color-rgb), .08); color: rgba(var(--center-channel-color-rgb), .8); }
        .mmrtl-folders .mmbox-btn:disabled { opacity: .4; cursor: default; }
        .mmrtl-folders .mmbox-send { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-radius: 4px; background: var(--button-bg); color: var(--button-color); font-size: 18px; cursor: pointer; }
        .mmrtl-folders .mmbox-send:disabled { background: rgba(var(--center-channel-color-rgb), .08); color: rgba(var(--center-channel-color-rgb), .32); cursor: default; }
        .mmrtl-folders [dir="rtl"] .mmbox-send .icon, .mmrtl-folders .box[dir="rtl"] .mmbox-send .icon { transform: scaleX(-1); }
        .mmrtl-folders .mmbox-emoji { position: absolute; bottom: 44px; inset-inline-start: 8px; z-index: 5; flex-wrap: wrap; max-width: 260px; }
        .mmrtl-folders .jump { position: sticky; bottom: 12px; z-index: 4; display: block; margin: 10px auto 0; height: 32px; padding: 0 16px; border: 0; border-radius: 16px; background: var(--button-bg); color: var(--button-color); font: inherit; font-size: 13px; font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,.2); cursor: pointer; }
        .mmrtl-folders .composer.drop { border-color: var(--button-bg); background: rgba(var(--button-bg-rgb), .05); }
        .mmrtl-folders .composer .section { margin: 0; }
        .mmrtl-folders .composer textarea { height: auto; min-height: 72px; padding: 8px 12px; resize: vertical; }
        .mmrtl-folders .row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
        .mmrtl-folders .tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .mmrtl-folders .seg { display: inline-flex; border: 1px solid var(--mf-line); border-radius: 4px; overflow: hidden; }
        .mmrtl-folders .seg button { height: 26px; padding: 0 10px; border: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
        .mmrtl-folders .seg button[aria-checked="true"] { background: rgba(var(--button-bg-rgb), .12); color: var(--button-bg); font-weight: 600; }
        .mmrtl-folders .footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--mf-line); }`);
    }

    const KIND_ICON = { personal: '📁', contact: '👤', shared: '👥', group: '👪' };
    const kindDescriptions = () => ({
      personal: L('فقط خودتان می‌بینید', 'Only you can see it'),
      contact: L('فقط خودتان؛ مرتبط با یک نفر', 'Only you; about one person'),
      shared: L('شما و یک نفر دیگر، با تأیید او', 'You and one other person, after they accept'),
      group: L('تا ۸ نفر، با تأیید همهٔ اعضا', 'Up to 8 people, after everyone accepts')
    });

    const avatar = (uid, cls = 'avatar') => el('img', { className: cls, src: V4(`/users/${encodeURIComponent(uid)}/image`), alt: '', loading: 'lazy' });
    const confirmIn = msg => ((host && host.ownerDocument.defaultView) || window).confirm(msg);

    function onKey(e) { if (e.key === 'Escape' && overlay) { e.stopPropagation(); close(); } }

    function close() {
      if (host && hostKind === 'page') {
        const history = window.WebappUtils && window.WebappUtils.browserHistory;
        if (history && typeof history.goBack === 'function' && window.history.length > 1) history.goBack();
        else { const t = currentTeam(); if (t) navigate(`/${t.name}`); }
        return;
      }
      if (host && rhs) {
        store.dispatch(rhs.hideRHSPlugin);
        return;
      }
      document.removeEventListener('keydown', onKey, true);
      overlay?.remove();
      overlay = null;
      box = null;
    }

    // Starts a new view; back (optional) adds a back button.
    function dialog(title, back) {
      setEditor(null);
      box = el('div', { className: 'box', role: 'dialog' });
      box.setAttribute('aria-modal', 'true');
      box.dir = isFa() ? 'rtl' : 'ltr';
      const top = el('div', { className: 'top' });
      if (back) {
        const b = el('button', { type: 'button', className: 'btn icon-btn', title: L('بازگشت', 'Back'), onclick: back }, isFa() ? '→' : '←');
        b.setAttribute('aria-label', L('بازگشت', 'Back'));
        top.append(b);
      }
      top.append(el('h3', {}, title));
      if (!host || hostKind === 'page') top.append(el('button', { type: 'button', className: 'btn icon-btn', title: L('بستن', 'Close'), onclick: close }, '✕'));
      box.append(top);
      if (host) {
        host.replaceChildren(box);
        return box;
      }
      if (!overlay) {
        overlay = el('div', { id: 'mmrtl-folders', className: 'mmrtl-folders overlay' });
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
        document.body.append(overlay);
        document.addEventListener('keydown', onKey, true);
      }
      overlay.replaceChildren(box);
      return box;
    }

    // Renders a view in the right-hand panel (opening it), or in the overlay.
    function show(view) {
      injectCSS();
      const t = pageMode && pageRoute && currentTeam();
      if (t) {
        if (host && hostKind === 'page') { view(); return; }
        pending = view;
        navigate(`/${t.name}/${PLUGIN_ID}/folders`);
        return;
      }
      if (rhs && store) {
        if (host) view(); else pending = view;
        store.dispatch(rhs.showRHSPlugin);
        return;
      }
      view();
    }

    // The panel component calls these when it mounts / unmounts.
    function attach(node, kind = 'rhs') {
      injectCSS(node.ownerDocument);
      host = node;
      hostKind = kind;
      const view = pending || (() => showList());
      pending = null;
      view();
    }
    function detach(node) { if (host === node) { host = null; hostKind = null; closePop(); } }

    const currentTeam = () => { const e = state(); return e.teams?.teams?.[e.teams?.currentTeamId] || null; };
    function navigate(path) {
      const history = window.WebappUtils && window.WebappUtils.browserHistory;
      if (history && typeof history.push === 'function') history.push(path);
      else location.assign(`${basePath}${path}`);
    }

    // A small menu (⋮ button or right-click) at (x, y). items: { label, run, danger } or null.
    function closePop() {
      if (!pop) return;
      const { node, off } = pop;
      pop = null;
      off();
      node.remove();
    }
    function popMenu(x, y, items) {
      closePop();
      const doc = (host && host.ownerDocument) || document;
      const win = doc.defaultView || window;
      injectCSS(doc);
      const node = el('div', { className: 'mmrtl-folders fmenu', role: 'menu' });
      node.dir = isFa() ? 'rtl' : 'ltr';
      for (const it of items.filter(Boolean)) {
        const b = el('button', { type: 'button', role: 'menuitem', className: it.danger ? 'danger' : '' }, it.label);
        b.onclick = () => { closePop(); it.run(); };
        node.append(b);
      }
      doc.body.append(node);
      const at = ContextMenu.placeMenu(x, y, node.offsetWidth, node.offsetHeight, win.innerWidth, win.innerHeight, node.dir === 'rtl');
      node.style.left = `${at.left}px`;
      node.style.top = `${at.top}px`;
      const outside = e => { if (!node.contains(e.target)) closePop(); };
      const key = e => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } };
      doc.addEventListener('mousedown', outside, true);
      doc.addEventListener('keydown', key, true);
      win.addEventListener('blur', closePop);
      pop = { node, off: () => { doc.removeEventListener('mousedown', outside, true); doc.removeEventListener('keydown', key, true); win.removeEventListener('blur', closePop); } };
      node.querySelector('button')?.focus();
    }
    const menuAt = (btn, items) => {
      const r = btn.getBoundingClientRect();
      popMenu(isFa() ? r.right : r.left, r.bottom + 2, items);
    };

    // From a message menu: id is the message to add.
    function open(id) {
      selection = id ? [id] : [];
      scope = null;
      show(() => showList());
    }

    // Several messages chosen with multi-select.
    function openMany(ids) {
      selection = [...new Set(ids)];
      scope = null;
      show(() => showList());
    }

    function openFolder(id) {
      selection = [];
      show(() => showFolder(id));
    }

    function openCreate() {
      selection = [];
      scope = null;
      show(() => showCreate());
    }

    // From a conversation button: only the folders that belong to it.
    // DM → folders with that person; group message → folders with exactly its members.
    async function openForChannel(channel) {
      selection = [];
      scope = null;
      const me = state().users.currentUserId;
      if (channel?.type === 'D') {
        const other = String(channel.name || '').split('__').find(id => id !== me) || me;
        if (other === me) {
          scope = { label: L('شما', 'You'), match: f => f.kind === 'personal' };
        } else {
          await loadNames([other]);
          scope = { label: nameOf(other), person: other, match: f => f.contact === other || [...f.members, ...(f.invitees || [])].includes(other) };
        }
      } else if (channel?.type === 'G') {
        try {
          const res = await fetch(V4(`/channels/${encodeURIComponent(channel.id)}/members?per_page=200`), {
            credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }
          });
          const ids = res.ok ? (await res.json()).map(m => m.user_id) : [];
          if (ids.length) {
            const want = [...new Set(ids)].sort().join(',');
            const key = f => [...new Set([...f.members, ...(f.invitees || [])])].sort().join(',');
            scope = { label: channel.display_name || L('گروه', 'Group'), match: f => (f.kind === 'group' || f.kind === 'shared') && key(f) === want };
          }
        } catch (e) { /* no scope: show every folder */ }
      }
      show(() => showList());
    }

    function statusTag(f) {
      if (f.status === 'pending') return el('span', { className: 'tag' }, L('در انتظار تأیید', 'Waiting for approval'));
      if (f.status === 'deleting') return el('span', { className: 'tag' }, L('درخواست حذف', 'Deletion requested'));
      return null;
    }

    function folderSubtitle(f) {
      const K = kindLabels();
      const me = state().users.currentUserId;
      if (f.kind === 'contact') return `${K.contact} · ${nameOf(f.contact)}`;
      if (f.kind === 'shared') {
        const other = [...f.members, ...(f.invitees || [])].find(id => id !== me);
        return `${K.shared} · ${other ? nameOf(other) : ''}`;
      }
      if (f.kind === 'group') return `${K.group} · ${f.members.length + (f.invitees || []).length} ${L('نفر', 'people')}`;
      return K.personal;
    }

    // Folder list. notice/error show at the top after a change.
    async function showList(notice, error) {
      const b = dialog(L('پوشه‌ها', 'Folders'));
      const add = el('button', { type: 'button', className: 'btn primary small' }, `+ ${L('پوشهٔ جدید', 'New folder')}`);
      add.onclick = () => showCreate();
      b.querySelector('.top').append(add);
      if (notice) b.append(el('div', { className: 'banner ok', role: 'status' }, notice));
      if (error) b.append(errorNode(error));
      let folders;
      try {
        ({ folders } = await call('GET'));
      } catch (e) {
        add.remove();
        b.append(e.code === 'disabled' ? el('div', { className: 'banner' }, errorLabels().disabled) : errorNode(e));
        return;
      }
      await loadNames(folders.flatMap(f => [f.owner, f.contact, ...f.members, ...(f.invitees || [])]));
      if (scope) {
        const all = el('button', { type: 'button', className: 'btn small' }, L('همهٔ پوشه‌ها', 'All folders'));
        all.onclick = () => { scope = null; showList(); };
        const bar = el('div', { className: 'banner' }, L(`پوشه‌های مربوط به ${scope.label}`, `Folders with ${scope.label}`));
        bar.append(el('div', { className: 'row' }, all));
        b.append(bar);
        folders = folders.filter(scope.match);
      }
      if (selection.length) {
        b.append(el('div', { className: 'banner' }, selection.length === 1
          ? L('پوشه‌ای را باز کنید تا پیام انتخاب‌شده را به آن اضافه کنید.', 'Open a folder to add the selected message to it.')
          : L(`پوشه‌ای را باز کنید تا ${selection.length} پیام انتخاب‌شده را به آن اضافه کنید.`, `Open a folder to add the ${selection.length} selected messages to it.`)));
      }

      const invites = folders.filter(f => f.role === 'invitee');
      const mine = folders.filter(f => f.role !== 'invitee');

      if (invites.length) {
        b.append(el('div', { className: 'section' }, L(`دعوت‌ها (${invites.length})`, `Invitations (${invites.length})`)));
        const list = el('div', { className: 'list' });
        for (const f of invites) {
          const ok = el('button', { type: 'button', className: 'btn primary small' }, L('پذیرش', 'Accept'));
          const no = el('button', { type: 'button', className: 'btn small' }, L('رد', 'Decline'));
          ok.onclick = () => runThenList(() => call('POST', `/${f.id}/approve`), L('پوشه پذیرفته شد.', 'Folder accepted.'));
          no.onclick = () => runThenList(() => call('POST', `/${f.id}/reject`), L('دعوت رد شد.', 'Invitation declined.'));
          list.append(el('div', { className: 'folder' },
            el('div', { className: 'ficon' }, KIND_ICON[f.kind]),
            el('div', { className: 'ftext' }, el('div', { className: 'fname' }, f.name), el('div', { className: 'fmeta' }, L(`دعوت از ${nameOf(f.owner)}`, `From ${nameOf(f.owner)}`))),
            ok, no));
        }
        b.append(list);
      }

      const groups = [
        [L('شخصی', 'Personal'), mine.filter(f => f.kind === 'personal')],
        [L('با افراد', 'With people'), mine.filter(f => f.kind === 'contact' || f.kind === 'shared')],
        [L('گروهی', 'Group'), mine.filter(f => f.kind === 'group')]
      ];
      if (!mine.length) {
        b.append(el('div', { className: 'empty' }, scope ? L('پوشه‌ای برای این گفتگو نیست.', 'No folders for this conversation.') : L('هنوز پوشه‌ای ندارید. با «پوشهٔ جدید» شروع کنید.', 'No folders yet. Start with “New folder”.')));
      }
      for (const [label, list] of groups) {
        if (!list.length) continue;
        b.append(el('div', { className: 'section' }, label));
        const wrap = el('div', { className: 'list' });
        for (const f of list) {
          const row = el('button', { type: 'button', className: 'folder' },
            el('div', { className: 'ficon' }, KIND_ICON[f.kind]),
            el('div', { className: 'ftext' }, el('div', { className: 'fname' }, f.name, statusTag(f)), el('div', { className: 'fmeta' }, folderSubtitle(f))),
            el('span', { className: 'chev', 'aria-hidden': 'true' }, isFa() ? '‹' : '›'));
          row.onclick = () => showFolder(f.id);
          wrap.append(row);
        }
        b.append(wrap);
      }
    }

    // Runs a change, then re-renders the list (showing the error if it failed).
    async function runThenList(fn, okText) {
      try {
        await fn();
        await showList(okText);
      } catch (e) {
        await showList(undefined, e);
      }
    }

    // New-folder screen: type cards, name with counter, people picker with avatars.
    function showCreate() {
      const K = kindLabels();
      const D = kindDescriptions();
      const b = dialog(L('پوشهٔ جدید', 'New folder'), () => showList());
      const limits = { personal: [0, 0], contact: [1, 1], shared: [1, 1], group: [2, 7] };
      const chosen = new Set();
      let kind = 'personal';
      if (scope?.person) { kind = 'shared'; chosen.add(scope.person); }

      const kinds = el('div', { className: 'kinds', role: 'radiogroup' });
      kinds.setAttribute('aria-label', L('نوع پوشه', 'Folder type'));
      const cards = {};
      for (const k of ['personal', 'contact', 'shared', 'group']) {
        const card = el('button', { type: 'button', className: 'kind', role: 'radio' },
          el('span', { className: 'ki', 'aria-hidden': 'true' }, KIND_ICON[k]), el('span', { className: 'kt' }, K[k]), el('span', { className: 'kd' }, D[k]));
        card.onclick = () => {
          if (kind === k) return;
          kind = k;
          const [, max] = limits[k];
          while (chosen.size > max) chosen.delete([...chosen].pop());
          sync();
        };
        cards[k] = card;
        kinds.append(card);
      }

      const nameField = el('div', { className: 'field' });
      const name = el('input', { type: 'text', className: 'input', id: 'mmrtl-folder-name', maxLength: 60, placeholder: L('مثلاً: اسکریپت‌های دیتابیس', 'e.g. Database scripts'), dir: 'auto' });
      const counter = el('span', { className: 'counter' });
      nameField.append(el('label', { htmlFor: 'mmrtl-folder-name' }, L('نام پوشه', 'Folder name')), name, counter);

      const peopleField = el('div', { className: 'field' });
      const peopleLabel = el('div', { className: 'label' });
      const peopleHint = el('div', { className: 'hint' });
      const picked = el('div', { className: 'people' });
      const search = el('input', { type: 'text', className: 'input', placeholder: L('نام یا نام کاربری را جستجو کنید…', 'Search by name or username…'), dir: 'auto' });
      search.setAttribute('aria-label', L('جستجوی کاربر', 'Search people'));
      const hits = el('div', { className: 'hits', role: 'listbox' });
      peopleField.append(peopleLabel, picked, search, hits, peopleHint);

      const err = el('div', {});
      const create = el('button', { type: 'button', className: 'btn primary block' }, L('ایجاد پوشه', 'Create folder'));
      const cancel = el('button', { type: 'button', className: 'btn block' }, L('انصراف', 'Cancel'));
      cancel.onclick = () => showList();

      function renderPicked() {
        picked.replaceChildren(...[...chosen].map(id => {
          const x = el('button', { type: 'button', className: 'x', title: L('حذف', 'Remove') }, '✕');
          x.setAttribute('aria-label', L(`حذف ${nameOf(id)}`, `Remove ${nameOf(id)}`));
          x.onclick = () => { chosen.delete(id); sync(); };
          return el('span', { className: 'person' }, avatar(id), nameOf(id), x);
        }));
      }

      function sync() {
        for (const [k, card] of Object.entries(cards)) card.setAttribute('aria-checked', String(k === kind));
        const [min, max] = limits[kind];
        peopleField.hidden = max === 0;
        peopleLabel.textContent = kind === 'contact' ? L('مخاطب', 'Contact') : L('اعضا', 'Members');
        peopleHint.textContent = kind === 'contact' ? L('مخاطب این پوشه را نمی‌بیند.', 'The contact will not see this folder.')
          : kind === 'shared' ? L('بعد از پذیرش او ساخته می‌شود.', 'Created once they accept.')
          : L(`۲ تا ۷ نفر به‌جز شما؛ بعد از پذیرش همه ساخته می‌شود. (${chosen.size}/${max})`, `2 to 7 people besides you; created once everyone accepts. (${chosen.size}/${max})`);
        search.hidden = chosen.size >= max;
        if (search.hidden) hits.replaceChildren();
        renderPicked();
        const n = name.value.trim().length;
        counter.textContent = `${name.value.length}/60`;
        create.disabled = !n || chosen.size < min || chosen.size > max;
      }
      name.oninput = sync;

      let timer = 0;
      search.oninput = () => {
        clearTimeout(timer);
        const term = search.value.trim();
        if (!term) { hits.replaceChildren(); return; }
        timer = setTimeout(async () => {
          try {
            const res = await fetch(V4('/users/search'), {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf() },
              body: JSON.stringify({ term, allow_inactive: false, limit: 8 })
            });
            const users = res.ok ? await res.json() : [];
            const me = state().users.currentUserId;
            const found = users.filter(u => u.id !== me && !u.is_bot && !chosen.has(u.id));
            hits.replaceChildren(...found.map(u => {
              names.set(u.id, displayName(u));
              const pick = el('button', { type: 'button', className: 'hit', role: 'option' }, avatar(u.id, 'avatar lg'), displayName(u));
              pick.onclick = () => {
                if (chosen.size >= limits[kind][1]) return;
                chosen.add(u.id);
                search.value = '';
                hits.replaceChildren();
                sync();
                search.focus();
              };
              return pick;
            }));
            if (!found.length) hits.replaceChildren(el('div', { className: 'hit', style: 'cursor:default' }, L('کسی پیدا نشد.', 'No one found.')));
          } catch (e) { hits.replaceChildren(); }
        }, 250);
      };

      create.onclick = async () => {
        create.disabled = true;
        err.replaceChildren();
        const body = { kind, name: name.value.trim() };
        const ids = [...chosen];
        if (kind === 'contact') body.contact_user_id = ids[0];
        else if (kind !== 'personal') body.member_ids = ids;
        try {
          const f = await call('POST', '', body);
          if (f.status === 'pending') await showList(L('درخواست ساخت پوشه برای اعضا فرستاده شد. بعد از پذیرش، پوشه فعال می‌شود.', 'The request was sent. The folder becomes active once accepted.'));
          else await showFolder(f.id, L('پوشه ساخته شد.', 'Folder created.'));
        } catch (e) {
          err.replaceChildren(errorNode(e));
          create.disabled = false;
        }
      };

      b.append(el('div', { className: 'field' }, el('div', { className: 'label' }, L('نوع پوشه', 'Folder type')), kinds), nameField, peopleField, err,
        el('div', { className: 'actions' }, create, cancel));
      sync();
      name.focus();
    }

    // Pure: splits message text into Markdown text and fenced code blocks
    // (``` or ~~~, closed by a fence of the same character, at least as long).
    // An unclosed fence runs to the end, as in Mattermost.
    function splitFences(text) {
      if (!text) return [];
      const parts = [];
      let buf = [];
      let code = null;
      const flush = () => { if (buf.length) { parts.push({ type: 'text', value: buf.join('\n') }); buf = []; } };
      for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
        if (code) {
          const t = line.trim();
          if (t.length >= code.fence.length && t === code.fence[0].repeat(t.length)) {
            parts.push({ type: 'code', lang: code.lang, value: code.lines.join('\n') });
            code = null;
          } else {
            code.lines.push(line);
          }
          continue;
        }
        const m = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
        if (m) {
          flush();
          code = { fence: m[1], lang: m[2] || '', lines: [] };
          continue;
        }
        buf.push(line);
      }
      if (code) parts.push({ type: 'code', lang: code.lang, value: code.lines.join('\n') });
      flush();
      return parts;
    }

    // Markdown text as Mattermost formats it (bold, links, mentions, inline code).
    function formatted(text) {
      const node = el('div', { className: 'post-message__text', dir: 'auto' });
      const fmt = window.PostUtils && window.PostUtils.formatText;
      if (typeof fmt === 'function') {
        try {
          const e = state();
          const team = e.teams?.teams?.[e.teams?.currentTeamId];
          node.innerHTML = fmt(text, { siteURL: `${location.origin}${basePath}`, team, markdown: true, atMentions: true, mentionHighlight: false });
          for (const a of node.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
          return node;
        } catch (err) { /* plain text below */ }
      }
      node.textContent = text;
      node.style.whiteSpace = 'pre-wrap';
      return node;
    }

    function codeBlock(part) {
      const copy = el('button', { type: 'button', className: 'btn small' }, L('کپی', 'Copy'));
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(part.value); copy.textContent = L('کپی شد ✓', 'Copied ✓'); } catch (e) { copy.textContent = L('کپی نشد', 'Copy failed'); }
        setTimeout(() => { copy.textContent = L('کپی', 'Copy'); }, 1500);
      };
      return el('div', { className: 'code' },
        el('div', { className: 'code-head' }, el('span', {}, part.lang || L('کد', 'code')), copy),
        el('pre', { dir: 'ltr' }, el('code', {}, part.value)));
    }

    // Message body: text through Mattermost's formatter, code blocks in our own box.
    function renderMessage(text) {
      const body = el('div', { className: 'msgbody', dir: 'auto' });
      for (const part of splitFences(text)) {
        if (part.type === 'code') body.append(codeBlock(part));
        else if (part.value.trim()) body.append(formatted(part.value));
      }
      return body;
    }

    function channelLabel(cid) {
      const ch = state().channels?.channels?.[cid];
      if (!ch) return '';
      if (ch.type === 'D') return L('پیام مستقیم', 'Direct message');
      if (ch.type === 'G') return ch.display_name || L('پیام گروهی', 'Group message');
      return `${ch.type === 'P' ? '🔒' : '#'} ${ch.display_name}`;
    }

    function goToPost(pid) {
      const e = state();
      const team = e.teams?.teams?.[e.teams?.currentTeamId];
      if (!team) return;
      const path = `/${team.name}/pl/${pid}`;
      const history = window.WebappUtils && window.WebappUtils.browserHistory;
      if (history && typeof history.push === 'function') history.push(path);
      else location.assign(`${basePath}${path}`);
    }

    const when = ms => new Date(ms).toLocaleString(isFa() ? 'fa-IR' : undefined, { dateStyle: 'medium', timeStyle: 'short' });

    // Emoji names Mattermost uses → the character. Anything else shows as :name:.
    const EMOJI = {
      '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', heart: '❤️', joy: '😂', smile: '😄', tada: '🎉',
      eyes: '👀', white_check_mark: '✅', heavy_check_mark: '✔️', pray: '🙏', fire: '🔥', rocket: '🚀',
      thinking_face: '🤔', ok_hand: '👌', clap: '👏', star: '⭐', warning: '⚠️', x: '❌', bulb: '💡', memo: '📝'
    };
    const QUICK_EMOJI = ['+1', 'heart', 'joy', 'tada', 'eyes', 'white_check_mark', 'pray', 'fire'];
    const glyph = name => EMOJI[name] || `:${name}:`;

    function humanSize(n) {
      if (!n && n !== 0) return '';
      const u = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
    }

    function fileIcon(ext) {
      const e = String(ext || '').toLowerCase();
      if (/^(pdf)$/.test(e)) return '📕';
      if (/^(zip|rar|7z|gz|tar)$/.test(e)) return '🗜️';
      if (/^(xls|xlsx|csv|ods)$/.test(e)) return '📊';
      if (/^(doc|docx|odt|rtf|txt|md)$/.test(e)) return '📄';
      if (/^(sql|js|ts|py|cs|java|go|sh|ps1|json|yml|yaml|xml|html|css)$/.test(e)) return '💻';
      if (/^(mp4|mov|webm|mkv)$/.test(e)) return '🎬';
      if (/^(mp3|wav|ogg|m4a)$/.test(e)) return '🎵';
      return '📎';
    }

    // Attachments: images as thumbnails (open the preview), other files as a
    // download chip. Mattermost serves them and checks channel access itself.
    // fi.url: a note's file served by the plugin (no separate preview/thumbnail).
    const fileUrl = (fi, suffix = '') => (fi.url
      ? (suffix === '?download=1' ? `${fi.url}?download=1` : fi.url)
      : V4(`/files/${encodeURIComponent(fi.id)}${suffix}`));
    const isImageFile = fi => fi.has_preview_image || /^image\//.test(fi.mime_type || '');
    const mediaKind = fi => (/^video\/(mp4|webm|ogg)$/.test(fi.mime_type || '') ? 'video' : /^audio\//.test(fi.mime_type || '') ? 'audio' : null);

    // Opens an attachment like Mattermost's file preview: images, video and
    // audio directly; Markdown, data, code, HTML and Office files in the
    // plugin's sandboxed preview frame; anything else offers a download.
    function openViewer(files, index) {
      const doc = (host && host.ownerDocument) || document;
      const win = doc.defaultView || window;
      injectCSS(doc);
      let i = index;
      const shade = el('div', { className: 'mmrtl-folders viewer', role: 'dialog' });
      shade.setAttribute('aria-modal', 'true');
      shade.dir = isFa() ? 'rtl' : 'ltr';
      const title = el('div', { className: 'vtitle', dir: 'auto' });
      const dl = el('a', { className: 'vbtn', title: L('دانلود', 'Download') }, '⤓');
      dl.setAttribute('aria-label', L('دانلود', 'Download'));
      const x = el('button', { type: 'button', className: 'vbtn', title: L('بستن', 'Close') }, '✕');
      x.setAttribute('aria-label', L('بستن', 'Close'));
      const prev = el('button', { type: 'button', className: 'vnav prev', title: L('قبلی', 'Previous') }, isFa() ? '›' : '‹');
      const next = el('button', { type: 'button', className: 'vnav next', title: L('بعدی', 'Next') }, isFa() ? '‹' : '›');
      const stage = el('div', { className: 'vstage' });
      shade.append(el('div', { className: 'vbar' }, title, dl, x), stage, prev, next);
      const close = () => { doc.removeEventListener('keydown', onKey, true); shade.remove(); };
      const onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.stopPropagation(); go((e.key === 'ArrowRight') !== isFa() ? 1 : -1); }
      };
      const go = step => { const n = i + step; if (n >= 0 && n < files.length) { i = n; render(); } };
      const render = () => {
        const fi = files[i];
        title.textContent = `${fi.name} · ${humanSize(fi.size)}`;
        dl.href = fileUrl(fi, '?download=1');
        dl.setAttribute('download', fi.name);
        prev.hidden = i === 0;
        next.hidden = i === files.length - 1;
        const media = mediaKind(fi);
        let view;
        if (isImageFile(fi)) view = el('img', { className: 'vimg', src: fileUrl(fi, '/preview'), alt: fi.name });
        else if (media) { view = el(media, { className: 'vmedia', src: fileUrl(fi), controls: true }); view.preload = 'metadata'; }
        else if (MdPreview.canPreview(fi)) view = MdPreview.createFileFrame(fi, win);
        else {
          const get = el('a', { className: 'btn primary', href: fileUrl(fi, '?download=1') }, L('دانلود فایل', 'Download file'));
          get.setAttribute('download', fi.name);
          view = el('div', { className: 'vnone' }, el('div', { className: 'ficon2', 'aria-hidden': 'true' }, fileIcon(fi.extension)),
            el('div', {}, L('برای این نوع فایل پیش‌نمایشی وجود ندارد.', 'No preview is available for this file type.')), get);
        }
        stage.replaceChildren(view);
      };
      x.onclick = close;
      prev.onclick = () => go(-1);
      next.onclick = () => go(1);
      shade.addEventListener('mousedown', e => { if (e.target === shade || e.target === stage) close(); });
      doc.addEventListener('keydown', onKey, true);
      doc.body.append(shade);
      render();
      x.focus();
    }

    function attachmentList(files) {
      const wrap = el('div', { className: 'files' });
      (files || []).forEach((fi, index) => {
        const open = e => {
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // new tab / save as stay native
          e.preventDefault();
          openViewer(files, index);
        };
        if (isImageFile(fi)) {
          const a = el('a', { className: 'thumb', href: fileUrl(fi, '/preview'), target: '_blank', rel: 'noopener noreferrer', title: fi.name },
            el('img', { src: fileUrl(fi, '/thumbnail'), alt: fi.name, loading: 'lazy' }));
          a.addEventListener('click', open);
          wrap.append(a);
        } else {
          const a = el('a', { className: 'file', href: fileUrl(fi, '?download=1'), title: fi.name },
            el('span', { className: 'ficon2', 'aria-hidden': 'true' }, fileIcon(fi.extension)),
            el('span', { className: 'fname2', dir: 'auto' }, fi.name),
            el('span', { className: 'fsize' }, humanSize(fi.size)));
          a.addEventListener('click', open);
          const dl = el('a', { className: 'fdl', href: fileUrl(fi, '?download=1'), title: L('دانلود', 'Download') }, '⤓');
          dl.setAttribute('download', fi.name);
          dl.setAttribute('aria-label', L(`دانلود ${fi.name}`, `Download ${fi.name}`));
          wrap.append(el('span', { className: 'filerow' }, a, dl));
        }
      });
      return wrap;
    }

    // Adds or removes the user's reaction. A saved conversation message uses
    // Mattermost's own reactions (seen in the conversation too); a folder-only
    // note keeps its reactions in the folder.
    async function setReaction(folderId, it, name, add) {
      const me = state().users.currentUserId;
      if (it.kind === 'note') {
        const data = add
          ? await call('POST', `/${folderId}/notes/${it.id}/reactions`, { emoji_name: name })
          : await call('DELETE', `/${folderId}/notes/${it.id}/reactions/${encodeURIComponent(name)}`);
        return data.reactions || {};
      }
      const headers = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf() };
      const res = add
        ? await fetch(V4('/reactions'), { method: 'POST', credentials: 'include', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: me, post_id: it.post_id, emoji_name: name }) })
        : await fetch(V4(`/users/${encodeURIComponent(me)}/posts/${encodeURIComponent(it.post_id)}/reactions/${encodeURIComponent(name)}`), { method: 'DELETE', credentials: 'include', headers });
      if (!res.ok) throw new FolderApiError(res.status, res.status === 403 ? 'forbidden' : 'store_failed');
      const next = { ...(it.reactions || {}) };
      const users = (next[name] || []).filter(u => u !== me);
      if (add) users.push(me);
      if (users.length) next[name] = users; else delete next[name];
      return next;
    }

    function reactionBar(folderId, it, canReact) {
      const me = state().users.currentUserId;
      const bar = el('div', { className: 'reactions' });
      const err = el('span', { className: 'rerr', role: 'alert' });
      let picker = null;
      const render = () => {
        const kids = [];
        for (const [name, users] of Object.entries(it.reactions || {})) {
          const mine = users.includes(me);
          const chip = el('button', { type: 'button', className: `rchip${mine ? ' mine' : ''}`, title: users.map(nameOf).join('، ') },
            el('span', { 'aria-hidden': 'true' }, glyph(name)), el('span', {}, String(users.length)));
          chip.setAttribute('aria-pressed', String(mine));
          chip.setAttribute('aria-label', `${name} ${users.length}`);
          if (canReact) chip.onclick = () => toggle(name, !mine);
          else chip.disabled = true;
          kids.push(chip);
        }
        if (canReact) {
          const plus = el('button', { type: 'button', className: 'rchip add', title: L('افزودن واکنش', 'Add reaction') }, icon('icon-emoticon-plus-outline'));
          plus.setAttribute('aria-label', L('افزودن واکنش', 'Add reaction'));
          plus.onclick = () => {
            if (picker) { picker.remove(); picker = null; return; }
            picker = el('div', { className: 'rpicker', role: 'group' });
            for (const name of QUICK_EMOJI) {
              const b = el('button', { type: 'button', title: name }, glyph(name));
              b.setAttribute('aria-label', name);
              b.onclick = () => { picker?.remove(); picker = null; toggle(name, !(it.reactions?.[name] || []).includes(me)); };
              picker.append(b);
            }
            bar.append(picker);
          };
          kids.push(plus);
        }
        kids.push(err);
        bar.replaceChildren(...kids);
        if (picker) bar.append(picker);
      };
      const toggle = async (name, add) => {
        err.textContent = '';
        try {
          it.reactions = await setReaction(folderId, it, name, add);
          render();
        } catch (e) {
          err.textContent = e instanceof FolderApiError ? (errorLabels()[e.code] || errorLabels().store_failed) : L('خطای شبکه.', 'Network error.');
        }
      };
      render();
      return bar;
    }

    const flash = (card, text) => {
      const note = el('div', { className: 'banner ok', role: 'status', style: 'margin-top:8px' }, text);
      card.append(note);
      setTimeout(() => note.remove(), 1600);
    };

    function itemCard(f, folderId, it, active, act) {
      const isNote = it.kind === 'note';
      const where = isNote ? L('فقط در پوشه', 'Folder only') : channelLabel(it.channel_id);
      const body = renderMessage(it.message);
      const card = el('div', { className: `msgcard${isNote ? ' note' : ''}` },
        el('div', { className: 'msghead' }, avatar(it.user_id || it.added_by, 'avatar lg'),
          el('div', { className: 'grow' }, el('span', { className: 'who' }, nameOf(it.user_id || it.added_by)),
            el('span', { className: 'where' }, [where, it.create_at ? when(it.create_at) : ''].filter(Boolean).join(' · ')))),
        body);
      const more = el('button', { type: 'button', className: 'more', hidden: true }, L('نمایش بیشتر', 'Show more'));
      more.onclick = () => {
        const collapsed = body.classList.toggle('clamp');
        more.textContent = collapsed ? L('نمایش بیشتر', 'Show more') : L('نمایش کمتر', 'Show less');
      };
      card.append(more);
      // A folder-only note's files are served by the plugin (folder members only).
      const files = (it.files || []).map(fi => (isNote ? { ...fi, url: `${API()}/${encodeURIComponent(folderId)}/notes/${encodeURIComponent(it.id)}/files/${encodeURIComponent(fi.id)}` } : fi));
      if (files.length) card.append(attachmentList(files));
      card.append(reactionBar(folderId, it, active));

      const foot = el('div', { className: 'msgfoot' }, el('span', { className: 'added' },
        isNote ? '' : L(`افزوده‌شده توسط ${nameOf(it.added_by)} · ${when(it.added_at)}`, `Added by ${nameOf(it.added_by)} · ${when(it.added_at)}`)));
      if (!isNote) {
        const go = el('button', { type: 'button', className: 'btn small' }, L('رفتن به پیام', 'Go to message'));
        go.onclick = () => goToPost(it.post_id);
        foot.append(go);
      }
      if (it.message) {
        const copy = el('button', { type: 'button', className: 'btn small' }, L('کپی', 'Copy'));
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(it.message); copy.textContent = L('کپی شد ✓', 'Copied ✓'); } catch (e) { copy.textContent = L('کپی نشد', 'Copy failed'); }
          setTimeout(() => { copy.textContent = L('کپی', 'Copy'); }, 1500);
        };
        foot.append(copy);
      }
      let rm = null;
      if (active) {
        rm = el('button', { type: 'button', className: 'btn small danger' }, isNote ? L('حذف', 'Delete') : L('حذف از پوشه', 'Remove'));
        rm.onclick = () => {
          if (isNote && !confirmIn(L('این پیام فقط در پوشه است و برای همیشه حذف می‌شود. ادامه می‌دهید؟', 'This message exists only in the folder and will be deleted permanently. Continue?'))) return;
          act(() => call('DELETE', `/${folderId}/items/${it.id}`), isNote ? L('پیام حذف شد.', 'Message deleted.') : L('پیام از پوشه حذف شد.', 'Message removed from the folder.'));
        };
        foot.append(rm);
      }
      card.append(foot);

      // The message actions, as in a conversation: from the ⋮ button or a right-click.
      const copyText = async (text, okText) => {
        try { await navigator.clipboard.writeText(text); flash(card, okText); } catch (e) { flash(card, L('کپی نشد', 'Copy failed')); }
      };
      const items = () => {
        const team = currentTeam();
        return [
          active ? { label: L('افزودن واکنش', 'Add reaction'), run: () => card.querySelector('.rchip.add')?.click() } : null,
          !isNote ? { label: L('پاسخ در رشته', 'Reply in thread'), run: () => { goToPost(it.post_id); ReplyClick.openThread(it.post_id, 120); } } : null,
          !isNote ? { label: L('رفتن به پیام', 'Go to message'), run: () => goToPost(it.post_id) } : null,
          !isNote ? { label: L('ارسال به…', 'Send to…'), run: () => Forward.open(it.post_id) } : null,
          it.message ? { label: L('کپی متن', 'Copy text'), run: () => copyText(it.message, L('متن کپی شد ✓', 'Text copied ✓')) } : null,
          !isNote && team ? { label: L('کپی لینک', 'Copy link'), run: () => copyText(`${location.origin}${basePath}/${team.name}/pl/${it.post_id}`, L('لینک کپی شد ✓', 'Link copied ✓')) } : null,
          active ? { label: isNote ? L('حذف', 'Delete') : L('حذف از پوشه', 'Remove from folder'), danger: true, run: () => rm.click() } : null
        ];
      };
      const kebab = el('button', { type: 'button', className: 'kebab', title: L('گزینه‌های پیام', 'Message options') }, '⋮');
      kebab.setAttribute('aria-label', L('گزینه‌های پیام', 'Message options'));
      kebab.setAttribute('aria-haspopup', 'menu');
      kebab.onclick = () => menuAt(kebab, items());
      card.append(kebab);
      card.addEventListener('contextmenu', e => {
        // Links, images, code, inputs, selected text and Shift keep the browser's menu.
        if (e.shiftKey || e.target.closest('a, img, video, pre, code, input, textarea, .fmenu')) return;
        const sel = (card.ownerDocument.defaultView || window).getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return;
        e.preventDefault();
        popMenu(e.clientX, e.clientY, items());
      });
      requestAnimationFrame(() => {
        if (body.scrollHeight > 240) { body.classList.add('clamp'); more.hidden = false; }
      });
      return card;
    }

    // Sends a multipart form (folder-only notes) and notifies listeners.
    async function sendForm(url, form) {
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf() }, body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new FolderApiError(res.status, data.error || (res.status === 413 ? 'limit_reached' : 'store_failed'));
      for (const fn of listeners) { try { fn(); } catch (e) { /* ignore */ } }
      return data;
    }

    async function v4(method, path, body, isForm) {
      const headers = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf() };
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(V4(path), { method, credentials: 'include', headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
      if (!res.ok) throw new FolderApiError(res.status, res.status === 413 ? 'limit_reached' : res.status === 403 ? 'forbidden' : 'store_failed');
      return res.json();
    }

    // Composer, shown above the messages. «در گفتگو هم» uses Mattermost's own
    // editor (window.Components.AdvancedTextEditor, rendered through a portal by
    // the panel component, so it has Mattermost's store, emoji picker,
    // formatting, attachments and drafts). «فقط در پوشه» is a box laid out the
    // same way whose message is stored only in the folder.
    let composerMode = 'folder';
    const conversationIds = new Map(); // folder ID → its conversation channel ID

    const icon = (cls, fallback) => el('i', { className: `icon ${cls}`, 'aria-hidden': 'true' }, fallback ? el('span', { className: 'icon-fallback' }, fallback) : null);
    const editorAvailable = () => Boolean(host && editorSubs.size && window.Components && window.Components.AdvancedTextEditor && window.ReactDOM && window.ReactDOM.createPortal);

    async function conversationOf(folderId) {
      if (!conversationIds.has(folderId)) conversationIds.set(folderId, (await call('POST', `/${folderId}/conversation`)).channel_id);
      return conversationIds.get(folderId);
    }

    // After Mattermost's editor sent a message: add it to the folder. Uses the
    // created post if the editor reports it, else the user's newest post there.
    async function addSentPost(folderId, channelId, res) {
      const me = state().users.currentUserId;
      let pid = res && ((res.created && res.created.id) || (res.data && res.data.id) || res.id);
      for (let attempt = 0; !pid && attempt < 5; attempt++) {
        if (attempt) await new Promise(r => setTimeout(r, 400));
        try {
          const list = await v4('GET', `/channels/${encodeURIComponent(channelId)}/posts?per_page=10`);
          const recent = Date.now() - 20000;
          pid = (list.order || []).find(x => { const p = list.posts[x]; return p && p.user_id === me && !p.type && p.create_at >= recent; });
        } catch (e) { /* retry */ }
      }
      if (!pid) return showFolder(folderId, undefined, new FolderApiError(404, 'not_found'));
      try {
        await call('POST', `/${folderId}/items`, { post_id: pid });
        await showFolder(folderId, L('ارسال شد و به پوشه اضافه شد.', 'Sent and added to the folder.'));
      } catch (e) {
        await showFolder(folderId, undefined, e);
      }
    }

    // The «فقط در پوشه» box (and the fallback for «در گفتگو هم» when
    // Mattermost's editor isn't available, e.g. in the overlay).
    function folderBox(f, folderId, mode) {
      const MAX_FILES = 10;
      const files = [];
      const box2 = el('div', { className: 'mmbox' });
      const ta = el('textarea', { className: 'mmbox-text', rows: 1, maxLength: 4000, dir: 'auto',
        placeholder: mode === 'folder' ? L('پیامی برای این پوشه بنویسید…', 'Write a message for this folder…') : L('پیامی بنویسید…', 'Write a message…') });
      ta.setAttribute('aria-label', L('متن پیام', 'Message text'));
      const chips = el('div', { className: 'mmbox-files' });
      const picker = el('input', { type: 'file', multiple: true, hidden: true });
      const err = el('div', {});
      const attach = el('button', { type: 'button', className: 'mmbox-btn', title: L('پیوست فایل', 'Attach files') }, icon('icon-paperclip', '📎'));
      attach.setAttribute('aria-label', L('پیوست فایل', 'Attach files'));
      attach.onclick = () => picker.click();
      const emojiBtn = el('button', { type: 'button', className: 'mmbox-btn', title: L('ایموجی', 'Emoji') }, icon('icon-emoticon-happy-outline', '☺'));
      emojiBtn.setAttribute('aria-label', L('ایموجی', 'Emoji'));
      let emojiMenu = null;
      emojiBtn.onclick = () => {
        if (emojiMenu) { emojiMenu.remove(); emojiMenu = null; return; }
        emojiMenu = el('div', { className: 'rpicker mmbox-emoji', role: 'group' });
        for (const name of Object.keys(EMOJI).filter((n, i, a) => a.indexOf(n) === i && !['thumbsup', 'thumbsdown'].includes(n))) {
          const b = el('button', { type: 'button', title: name }, EMOJI[name]);
          b.setAttribute('aria-label', name);
          b.onclick = () => {
            const at = ta.selectionStart ?? ta.value.length;
            ta.value = `${ta.value.slice(0, at)}${EMOJI[name]}${ta.value.slice(ta.selectionEnd ?? at)}`;
            ta.focus();
            ta.selectionStart = ta.selectionEnd = at + EMOJI[name].length;
            emojiMenu.remove();
            emojiMenu = null;
            sync();
          };
          emojiMenu.append(b);
        }
        box2.append(emojiMenu);
      };
      const send = el('button', { type: 'button', className: 'mmbox-send', title: L('ارسال', 'Send') }, icon('icon-send', '➤'));
      send.setAttribute('aria-label', L('ارسال', 'Send'));

      function addFiles(list) {
        for (const file of list) if (files.length < MAX_FILES) files.push(file);
        sync();
      }
      picker.onchange = () => { addFiles(picker.files); picker.value = ''; };
      ta.addEventListener('paste', e => {
        const pasted = e.clipboardData && e.clipboardData.files;
        if (pasted && pasted.length) { e.preventDefault(); addFiles(pasted); }
      });
      box2.addEventListener('dragover', e => { e.preventDefault(); box2.classList.add('drop'); });
      box2.addEventListener('dragleave', () => box2.classList.remove('drop'));
      box2.addEventListener('drop', e => { e.preventDefault(); box2.classList.remove('drop'); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
      // Enter sends, Shift+Enter is a new line (as in Mattermost).
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!send.disabled) send.click(); }
      });
      ta.addEventListener('input', () => sync());

      function sync() {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
        chips.replaceChildren(...files.map((file, i) => {
          const x = el('button', { type: 'button', className: 'x', title: L('حذف', 'Remove') }, '✕');
          x.setAttribute('aria-label', L(`حذف ${file.name}`, `Remove ${file.name}`));
          x.onclick = () => { files.splice(i, 1); sync(); };
          return el('span', { className: 'mmbox-chip' }, el('span', { 'aria-hidden': 'true' }, fileIcon(String(file.name).split('.').pop())),
            el('span', { className: 'n', dir: 'auto' }, file.name), el('span', { className: 's' }, humanSize(file.size)), x);
        }));
        attach.disabled = files.length >= MAX_FILES;
        send.disabled = !ta.value.trim() && !files.length;
      }

      send.onclick = async () => {
        send.disabled = true;
        err.replaceChildren();
        const text = ta.value.trim();
        try {
          if (mode === 'folder') {
            const form = new FormData();
            form.append('text', text);
            for (const file of files) form.append('files', file, file.name);
            await sendForm(`${API()}/${folderId}/notes`, form);
            await showFolder(folderId, L('در پوشه ذخیره شد.', 'Saved in the folder.'));
          } else {
            const channelId = await conversationOf(folderId);
            let fileIds = [];
            if (files.length) {
              const form = new FormData();
              form.append('channel_id', channelId);
              for (const file of files) form.append('files', file, file.name);
              fileIds = ((await v4('POST', '/files', form, true)).file_infos || []).map(x => x.id);
            }
            const post = await v4('POST', '/posts', { channel_id: channelId, message: text, file_ids: fileIds });
            await call('POST', `/${folderId}/items`, { post_id: post.id });
            await showFolder(folderId, L('ارسال شد و به پوشه اضافه شد.', 'Sent and added to the folder.'));
          }
        } catch (e) {
          err.replaceChildren(errorNode(e));
          send.disabled = false;
        }
      };

      box2.append(ta, chips, el('div', { className: 'mmbox-bar' }, attach, emojiBtn, el('span', { className: 'grow' }), send), picker);
      sync();
      return el('div', {}, box2, err);
    }

    function composer(f, folderId) {
      const me = state().users.currentUserId;
      const wrap = el('div', { className: 'composer' });
      const seg = el('div', { className: 'seg', role: 'radiogroup' });
      seg.setAttribute('aria-label', L('محل ارسال', 'Where to send'));
      const area = el('div', { className: 'composer-area' });
      const hint = el('div', { className: 'hint' });
      const other = [...f.members].find(id => id !== me);

      const render = async () => {
        for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.value === composerMode));
        hint.textContent = composerMode === 'folder'
          ? L('فقط در همین پوشه نمایش داده می‌شود و در هیچ گفتگویی نیست.', 'Shown only in this folder, not in any conversation.')
          : f.kind === 'group' ? L('در پیام گروهی اعضای پوشه هم فرستاده می‌شود.', 'Also sent to the group message of the folder’s members.')
            : f.kind === 'shared' && other ? L(`در پیام مستقیم با ${nameOf(other)} هم فرستاده می‌شود.`, `Also sent in your direct message with ${nameOf(other)}.`)
              : L('در گفتگو با خودتان هم فرستاده می‌شود (فقط شما می‌بینید).', 'Also sent to your conversation with yourself (only you see it).');
        setEditor(null);
        if (composerMode === 'conversation' && editorAvailable()) {
          const slot = el('div', { className: 'mm-editor' });
          area.replaceChildren(slot);
          try {
            const channelId = await conversationOf(folderId);
            if (!slot.isConnected) return;
            setEditor({
              key: `${folderId}:${channelId}`, node: slot, channelId,
              storageKey: `mmrtl-folder-${folderId}`,
              placeholder: L('پیامی بنویسید…', 'Write a message…'),
              afterSubmit: res => { addSentPost(folderId, channelId, res); }
            });
          } catch (e) {
            area.replaceChildren(errorNode(e));
          }
        } else {
          area.replaceChildren(folderBox(f, folderId, composerMode));
        }
      };
      const modeBtn = (value, label) => {
        const b = el('button', { type: 'button', role: 'radio' }, label);
        b.dataset.value = value;
        b.onclick = () => { if (composerMode !== value) { composerMode = value; render(); } };
        return b;
      };
      seg.append(modeBtn('folder', L('فقط در پوشه', 'Folder only')), modeBtn('conversation', L('در گفتگو هم', 'Also in conversation')));
      wrap.append(el('div', { className: 'composer-head' }, seg), area, hint);
      render();
      return wrap;
    }

    // Folder view. notice/error show at the top after an action on this folder.
    async function showFolder(id, notice, error) {
      const back = () => showList();
      let data;
      try {
        data = await call('GET', `/${id}`);
      } catch (e) {
        dialog(L('پوشه', 'Folder'), back).append(errorNode(e));
        return;
      }
      const { folder: f, items } = data;
      const me = state().users.currentUserId;
      await loadNames([f.owner, f.delete_by, f.contact, ...f.members, ...(f.invitees || []), ...items.flatMap(i => [i.added_by, i.user_id])]);
      const b = dialog(f.name, back);
      const head = el('div', { className: 'folder', style: 'cursor:default' },
        el('div', { className: 'ficon' }, KIND_ICON[f.kind]),
        el('div', { className: 'ftext' }, el('div', { className: 'fname' }, f.name, statusTag(f)), el('div', { className: 'fmeta' }, folderSubtitle(f))));
      b.append(head);
      if (f.kind === 'shared' || f.kind === 'group') {
        const people = el('div', { className: 'people', style: 'margin-top:8px' });
        for (const uid of f.members) people.append(el('span', { className: 'person' }, avatar(uid), uid === f.owner ? `${nameOf(uid)} ★` : nameOf(uid)));
        for (const uid of f.invitees || []) people.append(el('span', { className: 'person wait', title: L('هنوز نپذیرفته', 'Not accepted yet') }, avatar(uid), `${nameOf(uid)} ⏳`));
        b.append(people);
      }
      if (notice) b.append(el('div', { className: 'banner ok', role: 'status' }, notice));
      if (error) b.append(errorNode(error));

      // Each action re-opens this folder; a failure is shown on top.
      const act = async (fn, okText) => {
        try {
          await fn();
          await showFolder(id, okText);
        } catch (e) {
          await showFolder(id, undefined, e);
        }
      };

      if (f.role === 'invitee') {
        const ok = el('button', { type: 'button', className: 'btn primary small' }, L('پذیرش', 'Accept'));
        const no = el('button', { type: 'button', className: 'btn small' }, L('رد', 'Decline'));
        ok.onclick = () => act(() => call('POST', `/${id}/approve`), L('پوشه پذیرفته شد.', 'Folder accepted.'));
        no.onclick = () => runThenList(() => call('POST', `/${id}/reject`), L('دعوت رد شد.', 'Invitation declined.'));
        const bar = el('div', { className: 'banner warn' }, L(`${nameOf(f.owner)} شما را به این پوشه دعوت کرده است. پیام‌ها بعد از پذیرش نمایش داده می‌شوند.`, `${nameOf(f.owner)} invited you to this folder. Messages show after you accept.`));
        bar.append(el('div', { className: 'row' }, ok, no));
        b.append(bar);
        return;
      }

      if (f.status === 'pending') {
        b.append(el('div', { className: 'banner warn' }, L('منتظر پذیرش اعضا. تا آن موقع نمی‌توان پیام اضافه کرد.', 'Waiting for members to accept. Messages can be added after that.')));
      }
      if (f.status === 'deleting') {
        const bar = el('div', { className: 'banner warn' }, L(`${nameOf(f.delete_by)} حذف این پوشه را خواسته است. با تأیید همهٔ اعضا حذف می‌شود.`, `${nameOf(f.delete_by)} asked to delete this folder. It is deleted once every member approves.`));
        if (!(f.delete_ok || []).includes(me)) {
          const yes = el('button', { type: 'button', className: 'btn primary small' }, L('تأیید حذف', 'Approve deletion'));
          const no = el('button', { type: 'button', className: 'btn small' }, L('مخالفم', 'Reject'));
          yes.onclick = () => act(() => call('POST', `/${id}/delete-request/approve`), L('تأیید ثبت شد.', 'Approval recorded.'));
          no.onclick = () => act(() => call('POST', `/${id}/delete-request/reject`), L('حذف متوقف شد.', 'Deletion cancelled.'));
          bar.append(el('div', { className: 'row' }, yes, no));
        }
        b.append(bar);
      }

      const active = f.status === 'active';
      if (active) b.append(composer(f, id));
      const missing = selection.filter(pid => !items.some(i => i.post_id === pid));
      if (missing.length && active) {
        const add = el('button', { type: 'button', className: 'btn primary block', style: 'margin-top:12px' },
          `+ ${missing.length === 1 ? L('افزودن پیام انتخاب‌شده به این پوشه', 'Add the selected message to this folder') : L(`افزودن ${missing.length} پیام انتخاب‌شده به این پوشه`, `Add the ${missing.length} selected messages to this folder`)}`);
        add.onclick = async () => {
          add.disabled = true;
          let ok = 0;
          let failed = 0;
          let lastError = null;
          for (const pid of missing) {
            try { await call('POST', `/${id}/items`, { post_id: pid }); ok++; } catch (e) {
              failed++;
              lastError = e;
              if (e.code === 'limit_reached') break;
            }
          }
          selection = [];
          if (!ok && lastError) return showFolder(id, undefined, lastError);
          return showFolder(id, failed
            ? L(`${ok} پیام اضافه شد؛ ${failed} پیام اضافه نشد.`, `${ok} added; ${failed} could not be added.`)
            : ok === 1 ? L('پیام اضافه شد.', 'Message added.') : L(`${ok} پیام اضافه شد.`, `${ok} messages added.`));
        };
        b.append(add);
      }

      b.append(el('div', { className: 'section' }, L(`پیام‌ها (${items.length})`, `Messages (${items.length})`)));
      if (!items.length) {
        b.append(el('div', { className: 'empty' }, active
          ? L('پیامی در این پوشه نیست. پایین همین صفحه پیام یا فایل بفرستید، یا از منوی «…» هر پیام «افزودن به پوشه…» را بزنید.', 'No messages yet. Send a message or file below, or use “Add to folder…” in a message’s “…” menu.')
          : L('پیامی در این پوشه نیست.', 'No messages in this folder.')));
      }
      const msgs = el('div', { className: 'msgs' });
      const sorted = [...items].sort((a, c) => c.added_at - a.added_at);
      for (const it of sorted) msgs.append(itemCard(f, id, it, active, act));
      b.append(msgs);

      // Newest messages are at the top; after scrolling down, a button brings them back.
      const firstCard = msgs.firstElementChild;
      if (firstCard) {
        const jump = el('button', { type: 'button', className: 'jump', hidden: true }, `↑ ${L('آخرین پیام', 'Latest message')}`);
        const scroller = host || b;
        scroller.onscroll = () => {
          if (!firstCard.isConnected) return;
          jump.hidden = firstCard.getBoundingClientRect().top >= scroller.getBoundingClientRect().top - 40;
        };
        jump.onclick = () => firstCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        b.append(jump);
      }

      // Folder actions sit in a ⋮ menu beside the folder name.
      const shared = f.kind === 'shared' || f.kind === 'group';
      const actions = [];
      if (shared && active) {
        actions.push({ label: L('ترک پوشه', 'Leave folder'), run: () => {
          if (confirmIn(L('پوشه را ترک می‌کنید؟ پیام‌ها برای بقیهٔ اعضا باقی می‌مانند.', 'Leave this folder? Messages stay for the other members.'))) runThenList(() => call('POST', `/${id}/leave`), L('از پوشه خارج شدید.', 'You left the folder.'));
        } });
      }
      if (active || (f.status === 'pending' && f.role === 'owner')) {
        actions.push({ label: shared && active ? L('درخواست حذف از پوشه', 'Request deletion') : L('حذف پوشه', 'Delete folder'), danger: true, run: () => {
          const msg = shared && active
            ? L('حذف این پوشه نیاز به تأیید همهٔ اعضا دارد. درخواست را می‌فرستید؟', 'Deleting this folder needs every member to approve. Send the request?')
            : L('این پوشه برای همیشه حذف می‌شود. پیام‌های اصلی دست نمی‌خورند. ادامه می‌دهید؟', 'This folder will be deleted permanently. The original messages are not affected. Continue?');
          if (confirmIn(msg)) runThenList(() => call('POST', `/${id}/delete-request`), shared && active ? L('درخواست حذف برای اعضا فرستاده شد.', 'Deletion request sent.') : L('پوشه حذف شد.', 'Folder deleted.'));
        } });
      }
      if (actions.length) {
        const kebab = el('button', { type: 'button', className: 'kebab', title: L('گزینه‌های پوشه', 'Folder options') }, '⋮');
        kebab.setAttribute('aria-label', L('گزینه‌های پوشه', 'Folder options'));
        kebab.setAttribute('aria-haspopup', 'menu');
        kebab.onclick = () => menuAt(kebab, actions);
        head.append(kebab);
      }
    }

    return {
      open, openMany, openFolder, openCreate, openForChannel, close, attach, detach,
      setRhs: r => { rhs = r; },
      setPageRoute: on => { pageRoute = on; },
      configure: ({ page }) => { pageMode = Boolean(page); },
      subscribeEditor: fn => { editorSubs.add(fn); fn(editorSlot); return () => editorSubs.delete(fn); },
      list: () => call('GET'),
      onChange: fn => listeners.add(fn),
      loadNames, nameOf, kindLabels, splitFences
    };
  })();

  // ── Multi-select: tick several messages in the open conversation, then add
  // them all to a folder. Checkboxes are drawn only while the mode is on.
  const Selection = (() => {
    const picked = new Set();
    let on = false;
    let bar = null;
    let observer = null;
    const POSTS = 'div.post[id^="post_"]:not(.post--system)';

    function injectCSS() {
      upsertStyle(document, 'mmrtl-sel-style', `
        html.mmrtl-selecting ${POSTS} { position: relative; }
        .mmrtl-sel { position: absolute; top: 10px; inset-inline-start: 6px; z-index: 6; width: 20px; height: 20px; padding: 0; border-radius: 4px; border: 2px solid rgba(var(--center-channel-color-rgb), .45); background: var(--center-channel-bg); color: var(--button-color); font-size: 13px; line-height: 16px; cursor: pointer; }
        .mmrtl-sel[aria-checked="true"] { background: var(--button-bg); border-color: var(--button-bg); }
        .mmrtl-selected { background: rgba(var(--button-bg-rgb), .08) !important; }
        .mmrtl-selbar { position: fixed; z-index: 2147482998; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; background: var(--center-channel-bg); color: var(--center-channel-color); border: 1px solid rgba(var(--center-channel-color-rgb), .16); box-shadow: 0 8px 24px rgba(0,0,0,.18); font-size: 14px; }
        .mmrtl-selbar button { height: 32px; padding: 0 14px; border-radius: 4px; border: 1px solid rgba(var(--center-channel-color-rgb), .16); background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
        .mmrtl-selbar button.primary { background: var(--button-bg); color: var(--button-color); border-color: transparent; }
        .mmrtl-selbar button:disabled { opacity: .45; cursor: default; }`);
    }

    function setPicked(post, id, value) {
      if (value) picked.add(id); else picked.delete(id);
      post.classList.toggle('mmrtl-selected', value);
      const box = post.querySelector(':scope > .mmrtl-sel');
      if (box) { box.setAttribute('aria-checked', String(value)); box.textContent = value ? '✓' : ''; }
      renderBar();
    }

    function decorate() {
      if (!on) return;
      for (const post of document.querySelectorAll(POSTS)) {
        const id = post.id.slice(5);
        if (!/^[a-z0-9]{26}$/.test(id) || post.querySelector(':scope > .mmrtl-sel')) continue;
        const box = document.createElement('button');
        box.type = 'button';
        box.className = 'mmrtl-sel';
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-label', L('انتخاب پیام', 'Select message'));
        box.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); setPicked(post, id, !picked.has(id)); });
        post.prepend(box);
        setPicked(post, id, picked.has(id));
      }
    }

    function renderBar() {
      if (!on) return;
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'mmrtl-selbar';
        bar.setAttribute('role', 'toolbar');
        document.body.append(bar);
      }
      bar.dir = isFa() ? 'rtl' : 'ltr';
      const count = document.createElement('span');
      count.textContent = L(`${picked.size} پیام انتخاب شد`, `${picked.size} selected`);
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'primary';
      add.textContent = L('افزودن به پوشه…', 'Add to folder…');
      add.disabled = !picked.size;
      add.onclick = () => { const ids = [...picked]; stop(); Folders.openMany(ids); };
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = L('لغو', 'Cancel');
      cancel.onclick = stop;
      bar.replaceChildren(count, add, cancel);
    }

    function onKey(e) { if (e.key === 'Escape' && on) stop(); }

    function start(firstId) {
      injectCSS();
      if (!on) {
        on = true;
        picked.clear();
        document.documentElement.classList.add('mmrtl-selecting');
        observer = new MutationObserver(() => decorate());
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('keydown', onKey, true);
      }
      if (firstId) picked.add(firstId);
      decorate();
      renderBar();
    }

    function stop() {
      on = false;
      picked.clear();
      observer?.disconnect();
      observer = null;
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.classList.remove('mmrtl-selecting');
      for (const n of document.querySelectorAll('.mmrtl-sel')) n.remove();
      for (const n of document.querySelectorAll('.mmrtl-selected')) n.classList.remove('mmrtl-selected');
      bar?.remove();
      bar = null;
    }

    return { start, stop };
  })();

  // ── «پوشه‌ها» section at the top of the left sidebar. Lists the user's
  // folders grouped by kind; a click opens the folder in the right-hand panel.
  const FolderSidebar = (() => {
    const KEY = 'mmrtl-folders-collapsed';
    const roots = new Set();
    let folders = null; // null = feature off or unreachable: render nothing
    let timer = 0;

    const collapsed = () => { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
    const setCollapsed = v => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* not persisted */ } };

    function injectCSS() {
      upsertStyle(document, 'mmrtl-fsb-style', `
        .mmrtl-fsb { padding: 2px 8px 6px; color: var(--sidebar-text); font-size: 13px; }
        .mmrtl-fsb button { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: inherit; }
        .mmrtl-fsb button:hover, .mmrtl-fsb button:focus-visible { background: rgba(var(--sidebar-text-rgb), .08); }
        .mmrtl-fsb .head { font-weight: 600; }
        .mmrtl-fsb .sub { padding-block: 6px 2px; padding-inline: 22px 8px; font-size: 11px; opacity: .6; }
        .mmrtl-fsb .item { padding-inline-start: 34px; }
        .mmrtl-fsb .item.lvl1 { padding-inline-start: 22px; }
        .mmrtl-fsb .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mmrtl-fsb .who { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: .6; }
        .mmrtl-fsb .badge { margin-inline-start: auto; min-width: 18px; padding: 0 6px; border-radius: 9px; background: var(--mention-bg); color: var(--mention-color); font-size: 11px; text-align: center; }
        .mmrtl-fsb .muted { opacity: .7; }`);
    }

    function el(tag, props = {}, ...kids) {
      const n = document.createElement(tag);
      Object.assign(n, props);
      for (const k of kids) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
      return n;
    }

    // The other person (contact or shared folder), for the small label.
    function who(f, me) {
      if (f.kind === 'contact') return Folders.nameOf(f.contact);
      if (f.kind === 'shared') {
        const other = [...f.members, ...(f.invitees || [])].find(id => id !== me);
        return other ? Folders.nameOf(other) : '';
      }
      if (f.kind === 'group') return `${f.members.length + (f.invitees || []).length} ${L('نفر', 'people')}`;
      return '';
    }

    function paint(root) {
      if (!folders) { root.replaceChildren(); return; }
      const me = store.getState().entities.users.currentUserId;
      const invites = folders.filter(f => f.role === 'invitee');
      const mine = folders.filter(f => f.role !== 'invitee');
      const closed = collapsed();
      const head = el('button', { type: 'button', className: 'head', title: L('پوشه‌های پیام', 'Message folders') },
        el('span', {}, closed ? '▸' : '▾'), el('span', { className: 'name' }, `📁 ${L('پوشه‌ها', 'Folders')}`),
        invites.length ? el('span', { className: 'badge', title: L('دعوت‌های در انتظار', 'Pending invitations') }, String(invites.length)) : null);
      head.setAttribute('aria-expanded', String(!closed));
      head.onclick = () => { setCollapsed(!closed); render(); };
      const kids = [head];
      if (!closed) {
        if (invites.length) {
          const b = el('button', { type: 'button', className: 'muted item lvl1' }, el('span', { className: 'name' }, L(`دعوت‌ها (${invites.length})`, `Invitations (${invites.length})`)));
          b.onclick = () => Folders.open();
          kids.push(b);
        }
        const groups = [
          [L('شخصی', 'Personal'), mine.filter(f => f.kind === 'personal')],
          [L('با افراد', 'With people'), mine.filter(f => f.kind === 'contact' || f.kind === 'shared')],
          [L('گروهی', 'Group'), mine.filter(f => f.kind === 'group')]
        ];
        for (const [label, list] of groups) {
          if (!list.length) continue;
          kids.push(el('div', { className: 'sub' }, label));
          for (const f of list) {
            const pending = f.status !== 'active' ? ' ⏳' : '';
            const b = el('button', { type: 'button', className: 'item', title: f.name }, el('span', { className: 'name' }, `${f.name}${pending}`), el('span', { className: 'who' }, who(f, me)));
            b.onclick = () => Folders.openFolder(f.id);
            kids.push(b);
          }
        }
        const add = el('button', { type: 'button', className: 'muted item lvl1' }, el('span', { className: 'name' }, `+ ${L('پوشهٔ جدید', 'New folder')}`));
        add.onclick = () => Folders.openCreate();
        kids.push(add);
      }
      root.dir = isFa() ? 'rtl' : 'ltr';
      root.replaceChildren(...kids);
    }

    function render() { for (const r of roots) paint(r); }

    async function refresh() {
      try {
        const data = await Folders.list();
        const me = store.getState().entities.users.currentUserId;
        await Folders.loadNames(data.folders.flatMap(f => [f.contact, ...f.members, ...(f.invitees || [])]).filter(id => id && id !== me));
        folders = data.folders;
      } catch (e) {
        folders = null;
      }
      render();
    }

    function mount(el) {
      injectCSS();
      roots.add(el);
      paint(el);
      if (!timer) {
        refresh();
        timer = setInterval(refresh, 60000);
      }
    }

    function unmount(el) {
      roots.delete(el);
      if (!roots.size) { clearInterval(timer); timer = 0; }
    }

    Folders.onChange(() => refresh());
    return { mount, unmount };
  })();

  const ReadReceipts = (() => {
    const API = () => `${basePath}/plugins/${PLUGIN_ID}/api/v1/receipts`;
    const FAST = 15000, SLOW = 60000;
    let display = true;
    let status = null;          // { enabled, acknowledged }
    let statusAt = 0;
    let timer = null;
    let channelId = null;
    let skipChannel = null;     // channel reported too large
    let results = {};           // postId → { text, seen }
    let noticeShown = false;
    let started = false;

    const fa = n => (isFa() ? Number(n).toLocaleString('fa-IR') : String(n));
    const headers = json => ({ 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrfToken(), ...(json ? { 'Content-Type': 'application/json' } : {}) });

    function csrfToken() {
      const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }

    async function loadStatus(force) {
      if (!force && status && Date.now() - statusAt < 5 * 60 * 1000) return status;
      statusAt = Date.now();
      try {
        const r = await fetch(`${API()}/status`, { credentials: 'include', headers: headers(false) });
        status = r.ok ? await r.json() : { enabled: false };
      } catch (e) { status = { enabled: false }; }
      return status;
    }

    function injectCSS() {
      if (document.getElementById('mmrtl-rr-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-rr-style';
      st.textContent = `
        html.mmrtl-rr-on .post-message[data-mmrtl-rr]::after {
          content: attr(data-mmrtl-rr); display: block; margin-top: 2px; text-align: end;
          font-size: 12px; line-height: 1.4; unicode-bidi: plaintext;
          /* sent: pale blue; seen: full theme blue, bolder (theme link colour, so it works in light and dark themes) */
          color: rgba(var(--link-color-rgb, 35, 137, 215), .55);
        }
        html.mmrtl-rr-on .post-message[data-mmrtl-rr-seen="1"]::after { color: var(--link-color, #2389d7); font-weight: 600; }
        .mmrtl-rr-notice { position: fixed; inset: 0; z-index: 2147483002; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); }
        .mmrtl-rr-notice__box { width: min(520px, 92vw); padding: 22px 24px; border-radius: 10px; background: var(--center-channel-bg); color: var(--center-channel-color); box-shadow: 0 20px 60px rgba(0,0,0,.35); line-height: 1.9; }
        .mmrtl-rr-notice__box h3 { margin: 0 0 8px; font-size: 17px; }
        .mmrtl-rr-notice__box ul { margin: 8px 0; padding-inline-start: 20px; }
        .mmrtl-rr-notice__box button { margin-top: 12px; padding: 6px 18px; border: 0; border-radius: 6px; background: var(--button-bg); color: var(--button-color); cursor: pointer; font: inherit; }`;
      (document.head || document.documentElement).appendChild(st);
    }

    // One-time notice: until acknowledged, the user's own views are never
    // reported and they see no receipts.
    function showNotice() {
      if (noticeShown || document.querySelector('.mmrtl-rr-notice')) return;
      noticeShown = true;
      injectCSS();
      const el = document.createElement('div');
      el.className = 'mmrtl-rr-notice';
      el.dir = isFa() ? 'rtl' : 'ltr';
      el.innerHTML = `<div class="mmrtl-rr-notice__box" role="dialog" aria-modal="true">
        <h3>${L('اطلاع‌رسانی: نمایش «دیده شد» برای پیام‌ها', 'Notice: “Seen” indicators on messages')}</h3>
        <p>${L('مدیر سیستم نمایش وضعیت دیده‌شدن پیام‌ها را فعال کرده است:', 'Your system administrator has turned on message read indicators:')}</p>
        <ul>
          <li>${L('زیر پیام‌های شما «✓» (ارسال شد) یا «✓✓» (دیده شد) نمایش داده می‌شود.', 'Your messages show “✓” (sent) or “✓✓” (seen).')}</li>
          <li>${L('اعضای دیگرِ هر کانال، از جمله کانال‌های خصوصی و پیام‌های مستقیم، می‌بینند که شما پیامشان را دیده‌اید یا نه.', 'Other members of a channel — including private channels and direct messages — can see whether you have seen their messages.')}</li>
          <li>${L('«دیده شد» یعنی پس از ارسال پیام، کانال را باز کرده‌اید. زمانِ دقیقِ دیدن به هیچ‌کس نشان داده نمی‌شود.', '“Seen” means you opened the channel after the message was sent. The exact time is never shown to anyone.')}</li>
          <li>${L('تا وقتی این پیام را تأیید نکنید، وضعیت دیده‌شدنِ شما برای دیگران نمایش داده نمی‌شود.', 'Until you acknowledge this notice, your read status is not shown to others.')}</li>
        </ul>
        <button type="button">${L('متوجه شدم', 'I understand')}</button>
      </div>`;
      el.querySelector('button').addEventListener('click', async () => {
        try {
          const r = await fetch(`${API()}/ack`, { method: 'POST', credentials: 'include', headers: headers(false) });
          if (r.ok) { status = { ...status, acknowledged: true }; el.remove(); schedule(0); }
        } catch (e) { /* stays open; retry */ }
      });
      document.body.appendChild(el);
    }

    function currentChannel() { return store?.getState()?.entities?.channels?.currentChannelId || null; }

    function ownPostIds(chId) {
      const e = store.getState().entities;
      const me = e.users.currentUserId;
      const ids = [];
      for (const el of document.querySelectorAll('[id^="post_"]')) {
        const id = el.id.slice(5);
        const p = e.posts.posts[id];
        if (p && p.user_id === me && p.channel_id === chId && !p.type && !p.failed && /^[a-z0-9]{26}$/.test(id)) ids.push(id);
      }
      return ids.slice(-50);
    }

    function label(rec, members, names) {
      if (!rec || rec.seen === 0) return { text: '✓', seen: false };
      if (members <= 1) return { text: L('✓✓ دیده شد', '✓✓ Seen'), seen: true };
      if (names && names.length && names.length <= 3) return { text: `✓✓ ${names.join(L('، ', ', '))}`, seen: true };
      return { text: `✓✓ ${L(`${fa(rec.seen)} از ${fa(members)}`, `${rec.seen} of ${members}`)}`, seen: true };
    }

    function apply() {
      if (!display) return;
      for (const [id, r] of Object.entries(results)) {
        const msg = document.querySelector(`#post_${id} .post-message`);
        if (!msg || msg.getAttribute('data-mmrtl-rr') === r.text) continue;
        msg.setAttribute('data-mmrtl-rr', r.text);
        msg.setAttribute('data-mmrtl-rr-seen', r.seen ? '1' : '0');
      }
    }

    function clearMarks() {
      document.querySelectorAll('[data-mmrtl-rr]').forEach(el => { el.removeAttribute('data-mmrtl-rr'); el.removeAttribute('data-mmrtl-rr-seen'); });
    }

    async function refresh() {
      timer = null;
      if (!display || document.hidden) return;
      const st = await loadStatus(false);
      if (!st.enabled) { clearMarks(); results = {}; return schedule(SLOW); }
      if (!st.acknowledged) { showNotice(); return; }
      const chId = currentChannel();
      if (!chId || chId === skipChannel) return schedule(SLOW);
      const ids = ownPostIds(chId);
      if (!ids.length) return schedule(SLOW);
      let j;
      try {
        const r = await fetch(API(), { method: 'POST', credentials: 'include', headers: headers(true), body: JSON.stringify({ channel_id: chId, post_ids: ids }) });
        if (r.status === 403) { status = { ...status, acknowledged: false }; showNotice(); return; }
        if (!r.ok) return schedule(SLOW);
        j = await r.json();
      } catch (e) { return schedule(SLOW); }
      if (j.too_large) { skipChannel = chId; return; }
      const profiles = store.getState().entities.users.profiles;
      const next = {};
      let pending = false;
      for (const id of ids) {
        const rec = j.posts?.[id];
        const names = rec?.by?.map(u => profiles[u]?.first_name || profiles[u]?.username).filter(Boolean);
        next[id] = label(rec, j.members, names);
        if (!rec || rec.seen < j.members) pending = true;
      }
      results = next;
      apply();
      schedule(pending ? FAST : SLOW);
    }

    function schedule(ms) {
      clearTimeout(timer);
      timer = setTimeout(refresh, ms);
    }

    function onStoreChange() {
      const chId = currentChannel();
      if (chId !== channelId) {
        channelId = chId;
        skipChannel = null;
        results = {};
        if (started) schedule(300);
      }
    }

    // Someone else posting in this channel means they have seen it.
    function onPosted(msg) {
      const chId = msg?.broadcast?.channel_id || msg?.data?.channel_id;
      if (started && chId && chId === currentChannel()) schedule(1000);
    }

    function init(registry) {
      if (typeof registry.registerWebSocketEventHandler === 'function') registry.registerWebSocketEventHandler('posted', onPosted);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && started) schedule(500); });
    }

    async function configure(on) {
      display = on;
      document.documentElement.classList.toggle('mmrtl-rr-on', on);
      if (!on) { clearTimeout(timer); clearMarks(); return; }
      injectCSS();
      if (!started) {
        started = true;
        const st = await loadStatus(true);
        if (st.enabled && !st.acknowledged) showNotice();
        schedule(500);
      }
    }

    return { init, configure, apply, onStoreChange };
  })();

  // ── Paste long text as a .md file: after a long paste into the message (or
  // reply) box, a small bar offers to turn it into a Markdown attachment —
  // raw, or tidied with the Markdown converter. The file goes through
  // Mattermost's own paste-a-file path, so it appears as a normal attachment
  // and the user can still add a caption before sending.
  const PasteAsFile = (() => {
    const BOXES = '#post_textbox, #reply_textbox';
    const MIN_LINES = 10, MIN_CHARS = 1000, BAR_TTL = 20000;
    let on = true;
    let bar = null;
    let barTimer = null;
    let injecting = false;

    // Pure: is this paste long enough to offer the file option?
    const isLong = text => {
      const t = String(text || '');
      return t.length >= MIN_CHARS || t.split('\n').length >= MIN_LINES;
    };

    function setValue(ta, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, value);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function hideBar() {
      clearTimeout(barTimer);
      bar?.remove();
      bar = null;
    }

    // The .md document for a long paste. Code (HTML, JSON, …) must be fenced:
    // unfenced, Markdown treats its tags as prose and mangles the page.
    function markdownDocument(text, tidy) {
      const guess = detectCode(text);
      if (guess.isCode) {
        const body = text.replace(/\n+$/, '');
        const fence = body.includes('```') ? '~~~~' : '```';
        return `${fence}${guess.lang === 'text' ? '' : guess.lang}\n${body}\n${fence}\n`;
      }
      return tidy ? MdExport.toMarkdown(text) : (text.endsWith('\n') ? text : `${text}\n`);
    }

    function attach(ta, text, tidy) {
      // Take the pasted text back out of the box (wherever it now is).
      const at = ta.value.indexOf(text);
      if (at >= 0) setValue(ta, ta.value.slice(0, at) + ta.value.slice(at + text.length));
      const md = markdownDocument(text, tidy);
      const file = new File([md], MdExport.fileName(MdExport.titleFrom(text)), { type: 'text/markdown' });
      const dt = new DataTransfer();
      dt.items.add(file);
      ta.focus();
      injecting = true;
      try { ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } finally { injecting = false; }
    }

    function showBar(ta, text) {
      hideBar();
      injectCSS();
      bar = document.createElement('div');
      bar.className = 'mmrtl-paf';
      bar.dir = isFa() ? 'rtl' : 'ltr';
      const lines = text.split('\n').length;
      bar.innerHTML = `<span>📄 ${L(`متن بلندی چسباندید (${Number(lines).toLocaleString('fa-IR')} خط).`, `Long text pasted (${lines} lines).`)}</span>
        <button type="button" data-act="raw">${L('ارسال به‌صورت فایل .md', 'Send as .md file')}</button>
        <button type="button" data-act="tidy">${L('فایل .md مرتب‌شده', 'Tidied .md file')}</button>
        <button type="button" data-act="keep" class="plain">${L('همان متن', 'Keep as text')}</button>`;
      bar.addEventListener('mousedown', e => e.preventDefault()); // keep the caret in the box
      bar.addEventListener('click', e => {
        const act = e.target.closest('button')?.dataset.act;
        if (!act) return;
        if (act !== 'keep' && ta.isConnected) attach(ta, text, act === 'tidy');
        hideBar();
      });
      document.body.appendChild(bar);
      const r = ta.getBoundingClientRect();
      bar.style.left = `${Math.max(8, r.left)}px`;
      bar.style.width = `${Math.min(r.width, innerWidth - 16)}px`;
      bar.style.top = `${Math.max(8, r.top - bar.offsetHeight - 6)}px`;
      barTimer = setTimeout(hideBar, BAR_TTL);
    }

    // ── Code paste: pick the language, wrap in a ```lang fence (Mattermost
    // then highlights it), or set the language of the fence being pasted into.
    const LANGS = [
      ['javascript', 'JavaScript', 'js'], ['typescript', 'TypeScript', 'ts'], ['jsx', 'JSX', 'jsx'], ['tsx', 'TSX', 'tsx'],
      ['json', 'JSON', 'json'], ['python', 'Python', 'py'], ['csharp', 'C#', 'cs'], ['java', 'Java', 'java'],
      ['c', 'C', 'c'], ['cpp', 'C++', 'cpp'], ['go', 'Go', 'go'], ['rust', 'Rust', 'rs'], ['php', 'PHP', 'php'],
      ['ruby', 'Ruby', 'rb'], ['kotlin', 'Kotlin', 'kt'], ['swift', 'Swift', 'swift'], ['sql', 'SQL', 'sql'],
      ['yaml', 'YAML', 'yaml'], ['toml', 'TOML', 'toml'], ['ini', 'INI / env', 'ini'], ['bash', 'Bash / Shell', 'sh'],
      ['powershell', 'PowerShell', 'ps1'], ['batch', 'Batch', 'bat'], ['html', 'HTML', 'html'], ['xml', 'XML', 'xml'],
      ['css', 'CSS', 'css'], ['graphql', 'GraphQL', 'graphql'], ['dockerfile', 'Dockerfile', 'dockerfile'],
      ['diff', 'Diff', 'diff'], ['nginx', 'Nginx', 'conf'], ['markdown', 'Markdown', 'md'], ['text', L('متن ساده', 'Plain text'), 'txt']
    ];

    // Pure: does the text look like code, and which language? Conservative —
    // prose (including Persian) must not be offered a code fence.
    function detectCode(text) {
      const t = String(text || '').replace(/\r\n?/g, '\n').trim();
      const lines = t.split('\n');
      if (lines.length < 2 && t.length < 60) return { isCode: false, lang: null };
      const letters = (t.match(/[A-Za-z؀-ۿ]/g) || []).length;
      const latin = (t.match(/[A-Za-z]/g) || []).length;
      if (!letters || latin / letters < 0.5) return { isCode: false, lang: null };
      const rules = [
        ['php', /^<\?php/],
        ['json', /^[{[][\s\S]*[}\]]$/, s => { try { JSON.parse(s); return true; } catch (e) { return false; } }],
        ['xml', /^<\?xml/],
        ['html', /^<(!doctype|html|div|span|template|[a-z]+[\s>])/i],
        ['dockerfile', /^\s*FROM\s+\S+/im, s => /^\s*(RUN|COPY|CMD|ENTRYPOINT|WORKDIR)\b/m.test(s)],
        ['diff', /^(diff --git|@@ .* @@|--- a\/)/m],
        ['sql', /^\s*(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|WITH\s+\w+\s+AS)\b/im],
        ['java', /\bpublic\s+static\s+void\s+main\b|\bSystem\.out\.|\bimport\s+java\./],
        ['csharp', /\busing\s+System\b|\bnamespace\s+[\w.]+|\bpublic\s+(async\s+)?(Task|void|class|record|interface)\b|\bvar\s+\w+\s*=\s*new\b|\bawait\s+\w+Async\(/],
        ['go', /^package\s+\w+|\bfunc\s+(\(\w+\s+\*?\w+\)\s*)?\w+\(|:=/m],
        ['rust', /\bfn\s+\w+\(|\blet\s+mut\b|\bimpl\b|::new\(/],
        ['cpp', /#include\s*[<"]|\bstd::/],
        ['python', /^\s*(def|class)\s+\w+.*:\s*$|^\s*(import|from)\s+[\w.]+|\bprint\(|\bself\./m],
        ['powershell', /\b(Get|Set|New|Remove|Invoke|Write)-\w+|\$\w+\s*=\s*.+\|\s*\w+-\w+/],
        ['bash', /^#!.*\b(ba)?sh\b|^\s*(sudo|apt(-get)?|docker|kubectl|git|cd|ls|curl|export|echo|systemctl)\s/m],
        ['typescript', /\b(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean|void)\b|\bimport\s+.*\s+from\s+['"]/],
        ['javascript', /\b(const|let|var|function)\s+\w+|=>|console\.\w+\(|\brequire\(/],
        ['css', /^\s*[.#]?[\w-]+(\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{[^}]*:[^}]*;/m],
        ['yaml', /^\s*[\w-]+:\s*\S/m, s => s.split('\n').filter(l => /^\s*[\w-]+:\s/.test(l) || /^\s*-\s/.test(l)).length >= 2 && !/[;{}]/.test(s)],
        ['ini', /^\s*\[[\w.-]+\]\s*$/m]
      ];
      for (const [lang, re, check] of rules) {
        if (re.test(t) && (!check || check(t))) return { isCode: true, lang };
      }
      // Unknown language but clearly code-shaped: many lines ending in ; { } or indented.
      const codey = lines.filter(l => /[;{}]\s*$/.test(l) || /^\s{2,}\S/.test(l)).length;
      return lines.length >= 3 && codey / lines.length >= 0.5 ? { isCode: true, lang: 'text' } : { isCode: false, lang: null };
    }

    // Is position `pos` inside an open ``` fence? Returns the opening line's start, or -1.
    function openFenceBefore(value, pos) {
      const before = value.slice(0, pos);
      const re = /^```.*$/gm;
      let m, open = -1;
      while ((m = re.exec(before))) open = open < 0 ? m.index : -1;
      return open;
    }

    function setFenceLang(ta, fenceStart, lang) {
      const end = ta.value.indexOf('\n', fenceStart);
      const lineEnd = end < 0 ? ta.value.length : end;
      setValue(ta, `${ta.value.slice(0, fenceStart)}\`\`\`${lang === 'text' ? '' : lang}${ta.value.slice(lineEnd)}`);
    }

    function wrapInFence(ta, text, lang) {
      const at = ta.value.indexOf(text);
      if (at < 0) return;
      const pre = at > 0 && ta.value[at - 1] !== '\n' ? '\n' : '';
      const after = ta.value.slice(at + text.length);
      const post = after && !after.startsWith('\n') ? '\n' : '';
      const body = text.replace(/\n+$/, '');
      setValue(ta, `${ta.value.slice(0, at)}${pre}\`\`\`${lang === 'text' ? '' : lang}\n${body}\n\`\`\`${post}${after}`);
    }

    function attachCode(ta, text, lang) {
      const at = ta.value.indexOf(text);
      if (at >= 0) setValue(ta, ta.value.slice(0, at) + ta.value.slice(at + text.length));
      const ext = (LANGS.find(l => l[0] === lang) || LANGS[LANGS.length - 1])[2];
      const file = new File([text.endsWith('\n') ? text : `${text}\n`], `snippet.${ext}`, { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      ta.focus();
      injecting = true;
      try { ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } finally { injecting = false; }
    }

    // mode 'wrap': pasted code outside a fence; 'fence': pasted into a ``` block without a language.
    function showCodeBar(ta, text, guess, mode, fenceStart) {
      hideBar();
      injectCSS();
      bar = document.createElement('div');
      bar.className = 'mmrtl-paf';
      bar.dir = isFa() ? 'rtl' : 'ltr';
      const options = LANGS.map(([v, label]) => `<option value="${v}"${v === guess ? ' selected' : ''}>${label}</option>`).join('');
      bar.innerHTML = `<span>💻 ${L('کد چسباندید. زبان:', 'Code pasted. Language:')}</span>
        <select aria-label="${L('زبان کد', 'Code language')}">${options}</select>
        <button type="button" data-act="fence">${mode === 'fence' ? L('تنظیم زبان بلوک کد', 'Set block language') : L('قرار دادن در بلوک کد', 'Put in a code block')}</button>
        ${isLong(text) ? `<button type="button" data-act="file">${L('ارسال به‌صورت فایل', 'Send as a file')}</button>` : ''}
        <button type="button" data-act="keep" class="plain">${L('بدون تغییر', 'Leave as is')}</button>`;
      const select = bar.querySelector('select');
      bar.addEventListener('mousedown', e => { if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'OPTION') e.preventDefault(); });
      bar.addEventListener('click', e => {
        const act = e.target.closest('button')?.dataset.act;
        if (!act) return;
        if (ta.isConnected && act === 'fence') {
          if (mode === 'fence') setFenceLang(ta, fenceStart, select.value);
          else wrapInFence(ta, text, select.value);
        } else if (ta.isConnected && act === 'file') attachCode(ta, text, select.value);
        hideBar();
        ta.focus();
      });
      document.body.appendChild(bar);
      const r = ta.getBoundingClientRect();
      bar.style.left = `${Math.max(8, r.left)}px`;
      bar.style.width = `${Math.min(r.width, innerWidth - 16)}px`;
      bar.style.top = `${Math.max(8, r.top - bar.offsetHeight - 6)}px`;
      barTimer = setTimeout(hideBar, BAR_TTL);
    }

    function onPaste(e) {
      if ((!on && !codeOn) || injecting || e.defaultPrevented) return;
      const ta = e.target;
      if (!(ta instanceof HTMLTextAreaElement) || !ta.matches(BOXES)) return;
      const cd = e.clipboardData;
      if (!cd || (cd.files && cd.files.length)) return; // files/images: Mattermost handles them
      const text = cd.getData('text/plain').replace(/\r\n?/g, '\n');
      if (!text.trim()) return;
      // Decide from the box as it is before the paste lands.
      const fenceStart = openFenceBefore(ta.value, ta.selectionStart);
      const fenceLine = fenceStart >= 0 ? ta.value.slice(fenceStart, (ta.value.indexOf('\n', fenceStart) + 1 || ta.value.length + 1) - 1) : '';
      const guess = detectCode(text);
      // Let the normal paste happen; only offer the alternatives.
      if (codeOn && fenceStart >= 0 && /^```\s*$/.test(fenceLine)) {
        setTimeout(() => showCodeBar(ta, text, guess.lang || 'text', 'fence', fenceStart), 0);
      } else if (codeOn && fenceStart < 0 && guess.isCode) {
        setTimeout(() => showCodeBar(ta, text, guess.lang, 'wrap', -1), 0);
      } else if (on && fenceStart < 0 && isLong(text)) {
        setTimeout(() => showBar(ta, text), 0);
      }
    }

    function onKey(e) {
      if (bar && e.key === 'Escape') hideBar();
      else if (bar && e.key === 'Enter' && !e.shiftKey && e.target.matches?.(BOXES)) hideBar(); // message sent as text
    }

    function injectCSS() {
      if (document.getElementById('mmrtl-paf-style')) return;
      const st = document.createElement('style');
      st.id = 'mmrtl-paf-style';
      st.textContent = `
        .mmrtl-paf { position: fixed; z-index: 2147482999; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px;
          background: var(--center-channel-bg); color: var(--center-channel-color); border: 1px solid rgba(var(--center-channel-color-rgb), .16); box-shadow: 0 6px 20px rgba(0,0,0,.15); font-size: 13px; }
        .mmrtl-paf span { flex: 1 1 auto; }
        .mmrtl-paf button { border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; background: var(--button-bg); color: var(--button-color); }
        .mmrtl-paf select { font: inherit; padding: 3px 6px; border-radius: 6px; border: 1px solid rgba(var(--center-channel-color-rgb), .24); background: var(--center-channel-bg); color: inherit; direction: ltr; }
        .mmrtl-paf button.plain { background: transparent; color: inherit; border: 1px solid rgba(var(--center-channel-color-rgb), .2); }`;
      (document.head || document.documentElement).appendChild(st);
    }

    let listening = false;
    let codeOn = true;
    function configure(enabled, codeEnabled = true) {
      on = enabled;
      codeOn = codeEnabled;
      if (!on && !codeOn) hideBar();
      if ((on || codeOn) && !listening) {
        listening = true;
        document.addEventListener('paste', onPaste, true);
        document.addEventListener('keydown', onKey, true);
      }
    }

    return { configure, isLong, detectCode, openFenceBefore, markdownDocument };
  })();

  class Plugin {
    initialize(registry, reduxStore) {
      store = reduxStore;
      if (typeof registry.registerUserSettings === 'function') {
        registry.registerUserSettings({
          id: PLUGIN_ID,
          uiName: L('Mattermost RTL (فارسی)', 'Mattermost RTL (Persian)'),
          icon: '',
          sections: [
            { title: 'جهت پیام‌ها', settings: [radio('bidi', 'جهت پیام‌ها', 'هوشمند: اگر پاراگراف حتی یک حرف فارسی داشته باشد راست‌به‌چپ می‌شود.', [['smart', 'هوشمند (اولویت فارسی)'], ['off', 'خاموش']])] },
            { title: 'انتخاب دستی جهت', settings: [radio('hover', 'انتخاب دستی جهت', 'نوار کوچک کنار آواتار هنگام هاور روی پیام.', [['on', 'نمایش با هاور'], ['off', 'مخفی']])] },
            { title: 'جهت کل صفحه', settings: [radio('page_dir', 'جهت کل صفحه', '', [['auto', 'خودکار بر اساس زبان (فارسی ← راست‌به‌چپ)'], ['rtl', 'همیشه راست‌به‌چپ'], ['ltr', 'همیشه چپ‌به‌راست'], ['site-default', 'پیش‌فرض Mattermost']])] },
            { title: 'فونت فارسی', settings: [radio('fa_font', 'فونت فارسی', '', [['vazirmatn', 'Vazirmatn'], ['iransans', 'IRANSans'], ['yekan', 'Yekan'], ['yekanbakh', 'Yekan Bakh'], ['nastaliq', 'Noto Nastaliq'], ['tahoma', 'Tahoma'], ['site-default', 'پیش‌فرض سایت']])] },
            { title: 'فونت انگلیسی', settings: [radio('en_font', 'فونت انگلیسی', 'برای حروف لاتین. «مثل فونت فارسی» همان فونت را برای هر دو زبان به کار می‌برد.', [['site-default', 'پیش‌فرض سایت'], ['same-as-fa', 'مثل فونت فارسی'], ['segoe-ui', 'Segoe UI'], ['arial', 'Arial'], ['tahoma', 'Tahoma'], ['verdana', 'Verdana'], ['calibri', 'Calibri'], ['georgia', 'Georgia']])] },
            { title: 'محدوده‌ی فونت', settings: [radio('font_scope', 'فونت‌ها کجا اعمال شوند', '', [['all', 'کل صفحه'], ['messages', 'فقط متن پیام‌ها و کادر نوشتن']])] },
            { title: 'اندازه قلم پیام‌ها', settings: [radio('font_size', 'اندازه قلم پیام‌ها', 'روی متن پیام‌ها و کادر نوشتن پیام اعمال می‌شود.', [['site-default', 'پیش‌فرض سایت'], ['12', '12px'], ['13', '13px'], ['14', '14px'], ['15', '15px'], ['16', '16px'], ['17', '17px'], ['18', '18px'], ['20', '20px'], ['22', '22px'], ['24', '24px']])] },
            { title: 'رنگ قلم پیام‌ها', settings: [radio('text_color', 'رنگ قلم پیام‌ها', 'لینک‌ها، منشن‌ها و کدها رنگ خودشان را نگه می‌دارند. برای تم تیره رنگ‌های روشن را انتخاب کنید.', [['site-default', 'پیش‌فرض تم'], ['#000000', 'مشکی'], ['#1f2937', 'خاکستری تیره'], ['#1e3a8a', 'سرمه‌ای'], ['#065f46', 'سبز تیره'], ['#6b21a8', 'بنفش'], ['#7c2d12', 'قهوه‌ای'], ['#b91c1c', 'قرمز تیره'], ['#e5e7eb', 'خاکستری روشن (تم تیره)'], ['#ffffff', 'سفید (تم تیره)'], ['#fde68a', 'کرمی (تم تیره)']])] },
            { title: 'تاریخ پیام‌ها', settings: [radio('timestamp', 'نمایش زمان پیام', 'تاریخ بر اساس زبان Mattermost نمایش داده می‌شود (فارسی: شمسی).', [['full', 'تاریخ و ساعت کامل'], ['time', 'فقط ساعت (پیش‌فرض Mattermost)']])] },
            { title: 'اصلاح متن فارسی', settings: [radio('fa_fix', 'اصلاح خودکار هنگام نوشتن', 'ي و ك عربی ← ی و ک فارسی، ارقام عربی ← فارسی، نیم‌فاصله در «می/نمی» و «ها». متن داخل کد تغییر نمی‌کند.', [['on', 'فعال'], ['off', 'غیرفعال']])] },
            { title: 'پیش‌نمایش فایل Markdown', settings: [radio('md_preview', 'پیش‌نمایش فایل‌های md', 'فایل‌های .md، .markdown و .mdx با قالب‌بندی، جهت درست فارسی/انگلیسی، رنگ‌آمیزی کد و نمودار Mermaid نمایش داده می‌شوند.', [['on', 'فعال'], ['off', 'غیرفعال (متن خام)']])] },
            { title: 'پیش‌نمایش فایل CSV و JSON', settings: [radio('data_preview', 'پیش‌نمایش فایل‌های CSV، TSV و JSON', 'CSV/TSV به‌صورت جدول (جهت هر سلول جداگانه) و JSON مرتب‌شده با رنگ‌آمیزی نمایش داده می‌شوند.', [['on', 'فعال'], ['off', 'غیرفعال (پیش‌نمایش Mattermost)']])] },
            { title: 'پیش‌نمایش فایل‌های کد', settings: [radio('code_preview', 'پیش‌نمایش فایل‌های کد با Prism', 'فایل‌های کد (js، ts، py، cs، java، go، sql، yaml، sh، ps1، html، css، Dockerfile و…) با رنگ‌آمیزی، شماره خط و دکمهٔ Copy نمایش داده می‌شوند. خاموش: پیش‌نمایش خود Mattermost.', [['on', 'فعال (همهٔ فایل‌های کد)'], ['off', 'غیرفعال']])] },
            { title: 'پیش‌نمایش فایل‌های Office', settings: [radio('office_preview', 'پیش‌نمایش Excel، Word و PowerPoint', 'محتوای فایل‌های xlsx (جدول هر برگه)، docx (متن، جدول و تصویر) و pptx (متن و تصویرهای هر اسلاید) در فریم ایزوله نمایش داده می‌شود. چیدمان دقیق Office نیست؛ ماکروها هرگز اجرا نمی‌شوند. خاموش: پیش‌نمایش خود Mattermost.', [['on', 'فعال'], ['off', 'غیرفعال']])] },
            { title: 'خروجی Markdown پیام', settings: [radio('md_export', 'نمایش و دانلود پیام به‌صورت Markdown', 'دکمهٔ «MD» در نوار هاور پیام و گزینهٔ منوی «…»: متن پیام به یک سند Markdown مرتب (سرفصل، لیست، بلوک کد، کد درون‌خطی) تبدیل، پیش‌نمایش و به‌صورت فایل .md دانلود می‌شود.', [['on', 'فعال'], ['off', 'غیرفعال']])] },
            { title: 'چسباندن متن بلند به‌صورت فایل', settings: [radio('paste_as_file', 'پیشنهاد ارسال متن بلند به‌صورت فایل .md', 'بعد از چسباندن متن بلند (۱۰ خط یا ۱۰۰۰ کاراکتر به بالا) در کادر پیام، نواری پیشنهاد می‌دهد آن را به‌صورت پیوست .md (خام یا مرتب‌شده) بفرستید. متن‌های کوتاه و فایل‌ها دست نمی‌خورند.', [['on', 'فعال'], ['off', 'غیرفعال']])] },
            { title: 'زبان کد هنگام چسباندن', settings: [radio('code_paste', 'انتخاب زبان برای کدِ چسبانده‌شده', 'وقتی کد می‌چسبانید (یا داخل یک بلوک ``` بدون زبان)، نواری زبان را حدس می‌زند و اجازه می‌دهد آن را در بلوک کد با زبان درست قرار دهید (Mattermost آن را رنگ‌آمیزی می‌کند) یا کد بلند را به‌صورت فایل بفرستید.', [['on', 'فعال'], ['off', 'غیرفعال']])] },
            { title: 'تیک دیده‌شدن پیام', settings: [radio('read_receipts', 'نمایش ✓ و ✓✓ زیر پیام‌های شما', 'فقط وقتی مدیر سیستم این قابلیت را فعال کرده باشد کار می‌کند. خاموش کردن، فقط نمایش را در صفحهٔ شما پنهان می‌کند.', [['on', 'نمایش'], ['off', 'پنهان']])] },
            { title: 'منوی راست‌کلیک پیام', settings: [radio('context_menu', 'منوی راست‌کلیک روی پیام', 'راست‌کلیک روی پیام، منوی «بیشتر» و دکمه‌های نوار پیام را کنار نشانگر باز می‌کند. روی لینک، تصویر، کد، متن انتخاب‌شده یا با Shift، منوی خود مرورگر باز می‌شود.', [['on', 'فعال'], ['off', 'غیرفعال (منوی مرورگر)']])] },
            { title: 'باز کردن پاسخ با کلیک', settings: [radio('reply_click', 'باز کردن رشتهٔ پاسخ با کلیک روی پیام', 'کلیک روی متن پیام، پنل پاسخ (Reply) همان پیام را باز می‌کند. کلیک روی لینک، دکمه، تصویر، کد یا متن انتخاب‌شده کار خودش را می‌کند. خود Mattermost هم در Display گزینهٔ یک‌کلیکی «Click to open threads» دارد.', [['off', 'غیرفعال'], ['single', 'با یک‌بار کلیک'], ['double', 'با دوبار کلیک']])] },
            { title: 'محل نمایش پوشه‌ها', settings: [radio('folders_view', 'پوشه‌ها کجا باز شوند', 'پنل سمت راست (کنار گفتگو) یا کل فضای اصلی پیام‌رسان.', [['panel', 'پنل سمت راست'], ['page', 'فضای کامل پیام‌رسان']])] },
            { title: 'منوی کناری', settings: [radio('sidebar_toggle', 'جمع/باز کردن منوی کناری با کلیک روی لوگو', '', [['on', 'فعال'], ['off', 'غیرفعال']])] }
          ]
        });
      }
      const React = window.React;
      const SendToLabel = () => L('ارسال به…', 'Send to…');
      MdPreview.register(registry);
      ReadReceipts.init(registry);
      const MdLabel = () => L('نمایش به‌صورت Markdown', 'View as Markdown');
      registry.registerPostDropdownMenuAction(
        React ? React.createElement(MdLabel) : MdLabel(),
        postId => {
          const el = document.querySelector(`#post_${postId} .post-message__text, #rhsPost_${postId} .post-message__text`);
          if (el) MdExport.open(el);
        },
        postId => {
          const post = store.getState().entities.posts.posts[postId];
          return mdExportOn && Boolean(post?.message) && !(post.type || '').startsWith('system_');
        }
      );
      registry.registerPostDropdownMenuAction(
        React ? React.createElement(SendToLabel) : L('ارسال به…', 'Send to…'),
        postId => Forward.open(postId),
        postId => {
          const post = store.getState().entities.posts.posts[postId];
          return Boolean(post) && !(post.type || '').startsWith('system_');
        }
      );
      // Folders open in the right-hand panel when the API exists, else in an overlay.
      if (React && typeof registry.registerRightHandSidebarComponent === 'function') {
        // The panel renders inside Mattermost's React tree, so it can portal
        // Mattermost's own editor (with its store) into the folder view.
        // kind 'rhs': the right-hand panel; 'page': the center area (no channel
        // is shown there, so the editor can use CENTER's «post_textbox» id).
        const folderHost = kind => () => {
          const ref = React.useRef(null);
          const [slot, setSlot] = React.useState(null);
          React.useEffect(() => {
            const el = ref.current;
            const off = Folders.subscribeEditor(setSlot);
            Folders.attach(el, kind);
            return () => { off(); Folders.detach(el); };
          }, []);
          const Editor = window.Components && window.Components.AdvancedTextEditor;
          const portal = slot && Editor && window.ReactDOM && window.ReactDOM.createPortal
            ? window.ReactDOM.createPortal(React.createElement(Editor, {
              // RHS_COMMENT gives the box the id «reply_textbox», which is free while
              // this panel occupies the right-hand side (CENTER would duplicate
              // the channel's own «post_textbox»). No rootId: a normal post.
              key: slot.key, location: kind === 'page' ? 'CENTER' : 'RHS_COMMENT', channelId: slot.channelId, rootId: '', isThreadView: false,
              placeholder: slot.placeholder, storageKey: slot.storageKey, afterSubmit: slot.afterSubmit
            }), slot.node)
            : null;
          return React.createElement('div', { ref, className: `mmrtl-folders ${kind}` }, portal);
        };
        const FoldersPanel = folderHost('rhs');
        if (typeof registry.registerNeedsTeamRoute === 'function') {
          registry.registerNeedsTeamRoute('/folders', folderHost('page'));
          Folders.setPageRoute(true);
        }
        Folders.setRhs(registry.registerRightHandSidebarComponent(FoldersPanel, L('پوشه‌ها', 'Folders')));
      }
      // The sidebar section and the header button appear only when the admin has
      // turned folders on (the list call fails with "disabled" otherwise).
      Folders.list().then(() => {
        if (React && typeof registry.registerLeftSidebarHeaderComponent === 'function') {
          const FolderSection = () => {
            const ref = React.useRef(null);
            React.useEffect(() => {
              const el = ref.current;
              FolderSidebar.mount(el);
              return () => FolderSidebar.unmount(el);
            }, []);
            return React.createElement('div', { ref, className: 'mmrtl-fsb' });
          };
          registry.registerLeftSidebarHeaderComponent(FolderSection);
        }
        if (React && typeof registry.registerChannelHeaderButtonAction === 'function') {
          const icon = React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true },
            React.createElement('path', { fill: 'currentColor', d: 'M10 4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6z' }));
          registry.registerChannelHeaderButtonAction(
            icon,
            channel => Folders.openForChannel(channel),
            L('پوشه‌ها', 'Folders'),
            L('پوشه‌های این گفتگو', 'Folders for this conversation')
          );
        }
      }).catch(() => { /* folders off or unreachable: menu entry only */ });
      const FoldersLabel = () => L('افزودن به پوشه…', 'Add to folder…');
      const SelectLabel = () => L('انتخاب چند پیام برای پوشه…', 'Select messages for a folder…');
      registry.registerPostDropdownMenuAction(
        React ? React.createElement(FoldersLabel) : FoldersLabel(),
        postId => Folders.open(postId),
        postId => {
          const post = store.getState().entities.posts.posts[postId];
          return Boolean(post && (post.message || post.file_ids?.length)) && !(post.type || '').startsWith('system_');
        }
      );
      registry.registerPostDropdownMenuAction(
        React ? React.createElement(SelectLabel) : SelectLabel(),
        postId => Selection.start(postId),
        postId => {
          const post = store.getState().entities.posts.posts[postId];
          return Boolean(post) && !(post.type || '').startsWith('system_');
        }
      );
      applySettings();
      this.unsubscribe = store.subscribe(() => { applySettings(); ReadReceipts.onStoreChange(); });

      let queued = false;
      this.observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; applyCodeBlocksLTR(); Stamps.apply(); ReadReceipts.apply(); RtlMirror.schedule(); });
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    uninitialize() {
      this.unsubscribe?.();
      this.observer?.disconnect();
      Bidi.configure({ enabled: false, hover: false });
      applyPageDir('site-default');
      RtlMirror.configure(false);
      ResizeFlip.configure(false);
      ContextMenu.configure(false);
      document.getElementById('mmrtl-style')?.remove();
      document.documentElement.classList.remove('mmrtl-lhs-collapsed', 'mmrtl-lhs-open');
    }
  }

  window.registerPlugin(PLUGIN_ID, new Plugin());
  // Node unit tests only; in the browser `module` is undefined.
  if (typeof module === 'object' && module.exports) module.exports = { placeMenu: ContextMenu.placeMenu, isLongPaste: PasteAsFile.isLong, detectCode: PasteAsFile.detectCode, openFenceBefore: PasteAsFile.openFenceBefore, markdownDocument: PasteAsFile.markdownDocument, splitFences: Folders.splitFences, toMarkdown: MdExport.toMarkdown, titleFrom: MdExport.titleFrom, fileName: MdExport.fileName };
})();
