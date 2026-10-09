// Mattermost RTL — Mattermost webapp plugin.
// Port of a Chrome extension: Persian-first smart bidi per message,
// hover direction toolbar, RTL/LTR whole page, Persian fonts, collapsible LHS.
(function () {
  'use strict';

  const PLUGIN_ID = 'com.github.sysman2007.mattermost-rtl';
  const PREF_CATEGORY = `pp_${PLUGIN_ID}`;
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
      auto: '<svg viewBox="0 0 16 16"><path d="M3.5 13 8 3l4.5 10M5.2 9.5h5.6"/></svg>'
    };

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
        <button type="button" data-dir="auto" title="خودکار">${ICONS.auto}</button>`;
      bar.addEventListener('mousedown', e => e.preventDefault());
      bar.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn || !current) return;
        e.stopPropagation();
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
      bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.dir === mode));
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

    return { configure };
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
  const DEFAULTS = { bidi: 'smart', hover: 'on', page_dir: 'auto', fa_font: 'vazirmatn', en_font: 'site-default', font_scope: 'all', font_size: 'site-default', text_color: 'site-default', sidebar_toggle: 'on', timestamp: 'full', fa_fix: 'on' };
  let last = '';
  let sidebarOn = false;

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
            { title: 'منوی کناری', settings: [radio('sidebar_toggle', 'جمع/باز کردن منوی کناری با کلیک روی لوگو', '', [['on', 'فعال'], ['off', 'غیرفعال']])] }
          ]
        });
      }
      const React = window.React;
      const SendToLabel = () => L('ارسال به…', 'Send to…');
      registry.registerPostDropdownMenuAction(
        React ? React.createElement(SendToLabel) : L('ارسال به…', 'Send to…'),
        postId => Forward.open(postId),
        postId => {
          const post = store.getState().entities.posts.posts[postId];
          return Boolean(post) && !(post.type || '').startsWith('system_');
        }
      );
      applySettings();
      this.unsubscribe = store.subscribe(applySettings);

      let queued = false;
      this.observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; applyCodeBlocksLTR(); Stamps.apply(); RtlMirror.schedule(); });
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
      document.getElementById('mmrtl-style')?.remove();
      document.documentElement.classList.remove('mmrtl-lhs-collapsed', 'mmrtl-lhs-open');
    }
  }

  window.registerPlugin(PLUGIN_ID, new Plugin());
})();
