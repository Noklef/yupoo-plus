// ==UserScript==
// @name         Yupoo Gallery UI+
// @namespace    yupoo-gallery-ui-plus
// @version      1.0.0
// @description  Rebuilds Yupoo album grids with 5 switchable card designs. Dark theme, price badge, lazy loading, density control.
// @match        *://*.yupoo.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 0. Config
   * ====================================================================== */

  const DESIGNS = [
    { id: 'editorial', label: 'Editorial',  min: 260, hint: 'Big 4:5 image, floating price pill, 2-line title.' },
    { id: 'dense',     label: 'Dense',      min: 150, hint: 'Square tiles, many per row, title on hover.' },
    { id: 'info',      label: 'Info card',  min: 230, hint: 'Image + meta row + persistent thumbnail strip.' },
    { id: 'masonry',   label: 'Masonry',    min: 250, hint: 'Native aspect ratios in columns, caption scrim.' },
    { id: 'showcase',  label: 'Showcase',   min: 320, hint: 'Large cards, hover cycles through album photos.' }
  ];

  const DEFAULTS = { design: 'editorial', density: 1, enabled: true };

  /* =========================================================================
   * 1. Storage (GM_* with localStorage fallback)
   * ====================================================================== */

  const store = {
    get(k, d) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) { /* noop */ }
      try {
        const v = localStorage.getItem('ygx:' + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) { /* noop */ }
      try { localStorage.setItem('ygx:' + k, JSON.stringify(v)); } catch (e) { /* noop */ }
    }
  };

  const state = {
    design: store.get('design', DEFAULTS.design),
    density: Number(store.get('density', DEFAULTS.density)) || 1,
    enabled: store.get('enabled', DEFAULTS.enabled) !== false
  };
  if (!DESIGNS.some(d => d.id === state.design)) state.design = DEFAULTS.design;

  /* =========================================================================
   * 2. Scraping — build a model from whatever markup Yupoo is serving
   *
   * Yupoo changes class names between shop templates, so nothing here relies
   * on a specific class. We find album links, grow a container around each
   * one until it would swallow a second album, and read the pieces out.
   * ====================================================================== */

  const ALBUM_HREF = /\/albums\/(\d+)/;
  const PRICE_RE = /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/;
  const BAD_IMG = /(blank|placeholder|loading|spacer|1x1|^data:)/i;

  function absUrl(u) {
    if (!u) return '';
    u = u.trim();
    if (u.startsWith('//')) return location.protocol + u;
    if (u.startsWith('/')) return location.origin + u;
    return u;
  }

  // Yupoo serves /small.jpg /medium.jpg /big.jpg variants off the same path.
  function sized(url, want) {
    if (!url) return url;
    return url.replace(/\/(small|medium|big)(\.[a-z]{3,4})(\?.*)?$/i, '/' + want + '$2$3');
  }

  function urlFromNode(el) {
    const attrs = ['data-origin-src', 'data-original', 'data-src', 'data-lazy', 'src'];
    for (const a of attrs) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && !BAD_IMG.test(v)) return absUrl(v);
    }
    const bg = el.style && el.style.backgroundImage;
    if (bg) {
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !BAD_IMG.test(m[1])) return absUrl(m[1]);
    }
    return '';
  }

  // All image URLs inside the card, in DOM order. [0] is the album's first
  // image — shown as-is, size guide or not.
  function collectImages(card) {
    const nodes = card.querySelectorAll(
      'img, [data-src], [data-origin-src], [data-original], [style*="background-image"]'
    );
    const out = [];
    const seen = new Set();
    for (const n of nodes) {
      const u = urlFromNode(n);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out;
  }

  // Grow upward from the anchor until the container would contain a 2nd album.
  function cardRootFor(anchor) {
    let node = anchor;
    let best = anchor;
    for (let i = 0; i < 7 && node.parentElement; i++) {
      node = node.parentElement;
      if (node === document.body) break;
      const ids = new Set();
      node.querySelectorAll('a[href*="/albums/"]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(ALBUM_HREF);
        if (m) ids.add(m[1]);
      });
      if (ids.size > 1) break;
      best = node;
    }
    return best;
  }

  function readTitle(card, anchor) {
    const direct =
      card.querySelector('.album__title, .text__overflow, [class*="title"]') ||
      (anchor.getAttribute('title') ? anchor : null);
    let t = '';
    if (direct) t = (direct.getAttribute('title') || direct.textContent || '').trim();
    if (!t) t = (anchor.getAttribute('title') || anchor.textContent || '').trim();
    if (!t) t = (card.textContent || '').trim();
    return t.replace(/\s+/g, ' ').trim();
  }

  function readCount(card, imgCount) {
    const known = card.querySelector('.album__imgnum, [class*="imgnum"], [class*="num"], [class*="count"]');
    if (known) {
      const m = (known.textContent || '').match(/\d+/);
      if (m) return m[0];
    }
    for (const el of card.querySelectorAll('span, i, em, div')) {
      if (el.children.length) continue;
      const txt = (el.textContent || '').trim();
      if (/^\d{1,4}$/.test(txt)) return txt;
    }
    return imgCount > 1 ? String(imgCount) : '';
  }

  function scrape() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/albums/"]'));
    const byId = new Map();

    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(ALBUM_HREF);
      if (!m) continue;
      if (a.closest('#ygx-root')) continue; // our own output
      const id = m[1];
      if (byId.has(id)) continue;

      const card = cardRootFor(a);
      const imgs = collectImages(card);
      if (!imgs.length) continue;

      const rawTitle = readTitle(card, a);
      const pm = rawTitle.match(PRICE_RE);

      byId.set(id, {
        id,
        href: a.href,
        target: a.getAttribute('target') || '',
        // "Only price, else nothing" — pull the ¥ figure out, leave the rest verbatim.
        price: pm ? pm[1] : '',
        title: (pm ? rawTitle.replace(pm[0], '') : rawTitle).replace(/\s+/g, ' ').trim(),
        images: imgs,
        count: readCount(card, imgs.length),
        node: card
      });
    }
    return Array.from(byId.values());
  }

  /* =========================================================================
   * 3. Rendering
   * ====================================================================== */

  let rootEl = null;
  let gridEl = null;
  let hiddenOriginals = [];
  let lastSignature = '';
  let io = null;

  function ensureRoot(sampleNode) {
    if (rootEl && rootEl.isConnected) return rootEl;
    rootEl = document.createElement('div');
    rootEl.id = 'ygx-root';
    gridEl = document.createElement('div');
    gridEl.id = 'ygx-grid';
    rootEl.appendChild(gridEl);

    // Drop it where the original grid lived so page chrome stays put.
    let host = sampleNode && sampleNode.parentElement;
    if (host && host !== document.body) host.parentElement.insertBefore(rootEl, host);
    else document.body.appendChild(rootEl);
    return rootEl;
  }

  function hideOriginals(items) {
    const hosts = new Set();
    items.forEach(it => { if (it.node && it.node.parentElement) hosts.add(it.node.parentElement); });
    hiddenOriginals = [];
    hosts.forEach(h => {
      if (h.closest('#ygx-root')) return;
      h.setAttribute('data-ygx-hidden', '1');
      hiddenOriginals.push(h);
    });
  }

  function showOriginals() {
    hiddenOriginals.forEach(h => h.removeAttribute('data-ygx-hidden'));
    hiddenOriginals = [];
  }

  function lazyObserver() {
    if (io) return io;
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        if (img.dataset.ygxSrc) {
          img.src = img.dataset.ygxSrc;
          delete img.dataset.ygxSrc;
        }
        img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
        io.unobserve(img);
      }
    }, { rootMargin: '600px 0px' });
    return io;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildCard(item, design) {
    const a = el('a', 'ygx-card');
    a.href = item.href;
    if (item.target) a.target = item.target;
    a.setAttribute('data-id', item.id);

    const media = el('div', 'ygx-media');
    const img = el('img', 'ygx-img');
    img.alt = item.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    // Bigger designs pull the medium variant; dense grids stay on small.
    const wantBig = design === 'editorial' || design === 'showcase' || design === 'masonry';
    const first = wantBig ? sized(item.images[0], 'medium') : item.images[0];
    img.dataset.ygxSrc = first;
    img.dataset.ygxFirst = first;
    // Fall back to the original URL if the upsized variant 404s.
    img.addEventListener('error', function onErr() {
      if (img.dataset.ygxFallback) return;
      img.dataset.ygxFallback = '1';
      img.src = item.images[0];
    });
    media.appendChild(img);
    lazyObserver().observe(img);

    if (item.count) media.appendChild(el('span', 'ygx-count', item.count));
    if (item.price) media.appendChild(el('span', 'ygx-price-float', '¥' + item.price));
    media.appendChild(el('span', 'ygx-scrim'));

    const body = el('div', 'ygx-body');
    const title = el('div', 'ygx-title', item.title || '—');
    title.title = item.title;
    body.appendChild(title);

    const meta = el('div', 'ygx-meta');
    if (item.price) meta.appendChild(el('span', 'ygx-price', '¥' + item.price));
    if (item.count) meta.appendChild(el('span', 'ygx-chip', item.count + ' photos'));
    body.appendChild(meta);

    a.appendChild(media);
    a.appendChild(body);

    // Info design keeps a small persistent thumbnail strip.
    if (design === 'info' && item.images.length > 1) {
      const strip = el('div', 'ygx-strip');
      item.images.slice(1, 5).forEach(u => {
        const t = el('img', 'ygx-thumb');
        t.loading = 'lazy';
        t.dataset.ygxSrc = u;
        lazyObserver().observe(t);
        strip.appendChild(t);
      });
      a.appendChild(strip);
    }

    // Showcase cycles the album's photos on hover; leaving restores image #1.
    if (design === 'showcase' && item.images.length > 1) {
      let timer = null;
      let i = 0;
      a.addEventListener('mouseenter', () => {
        clearInterval(timer);
        timer = setInterval(() => {
          i = (i + 1) % item.images.length;
          img.src = sized(item.images[i], 'medium');
        }, 900);
      });
      a.addEventListener('mouseleave', () => {
        clearInterval(timer);
        i = 0;
        img.src = img.dataset.ygxFirst;
      });
    }

    return a;
  }

  function render(force) {
    if (!state.enabled) return;
    const items = scrape();
    if (items.length < 2) return;

    const sig = state.design + '|' + items.map(i => i.id).join(',');
    if (!force && sig === lastSignature) return;
    lastSignature = sig;

    ensureRoot(items[0].node);
    hideOriginals(items);

    if (io) { io.disconnect(); io = null; }
    gridEl.textContent = '';
    gridEl.setAttribute('data-design', state.design);
    const frag = document.createDocumentFragment();
    items.forEach(it => frag.appendChild(buildCard(it, state.design)));
    gridEl.appendChild(frag);

    applyDensity();
  }

  function applyDensity() {
    const d = DESIGNS.find(x => x.id === state.design) || DESIGNS[0];
    const min = Math.round(d.min * state.density);
    rootEl.style.setProperty('--ygx-min', min + 'px');
    rootEl.style.setProperty('--ygx-cols', String(Math.max(1, Math.round(6 / state.density))));
  }

  function setDesign(id) {
    state.design = id;
    store.set('design', id);
    render(true);
    syncPanel();
  }

  function setEnabled(on) {
    state.enabled = on;
    store.set('enabled', on);
    if (on) {
      lastSignature = '';
      render(true);
    } else {
      showOriginals();
      if (rootEl) rootEl.remove();
      rootEl = null;
      lastSignature = '';
    }
    syncPanel();
  }

  /* =========================================================================
   * 4. Control panel
   * ====================================================================== */

  let panel = null;

  function buildPanel() {
    panel = el('div', 'ygx-panel');
    panel.id = 'ygx-panel';

    const head = el('div', 'ygx-panel-head');
    head.appendChild(el('span', 'ygx-panel-title', 'Gallery UI+'));
    const collapse = el('button', 'ygx-icon-btn', '−');
    collapse.title = 'Collapse';
    collapse.addEventListener('click', () => {
      panel.classList.toggle('is-collapsed');
      collapse.textContent = panel.classList.contains('is-collapsed') ? '+' : '−';
    });
    head.appendChild(collapse);
    panel.appendChild(head);

    const bodyEl = el('div', 'ygx-panel-body');

    const designs = el('div', 'ygx-designs');
    DESIGNS.forEach(d => {
      const b = el('button', 'ygx-design-btn', d.label);
      b.dataset.design = d.id;
      b.title = d.hint;
      b.addEventListener('click', () => setDesign(d.id));
      designs.appendChild(b);
    });
    bodyEl.appendChild(designs);

    const densRow = el('label', 'ygx-row');
    densRow.appendChild(el('span', 'ygx-row-label', 'Card size'));
    const range = el('input', 'ygx-range');
    range.type = 'range';
    range.min = '0.6';
    range.max = '1.8';
    range.step = '0.1';
    range.value = String(state.density);
    range.addEventListener('input', () => {
      state.density = Number(range.value);
      store.set('density', state.density);
      applyDensity();
    });
    densRow.appendChild(range);
    bodyEl.appendChild(densRow);

    const toggle = el('button', 'ygx-toggle', '');
    toggle.id = 'ygx-toggle';
    toggle.addEventListener('click', () => setEnabled(!state.enabled));
    bodyEl.appendChild(toggle);

    panel.appendChild(bodyEl);
    document.body.appendChild(panel);
    syncPanel();
  }

  function syncPanel() {
    if (!panel) return;
    panel.querySelectorAll('.ygx-design-btn').forEach(b => {
      b.classList.toggle('is-active', b.dataset.design === state.design);
    });
    const t = panel.querySelector('#ygx-toggle');
    if (t) {
      t.textContent = state.enabled ? 'Restore original layout' : 'Enable Gallery UI+';
      t.classList.toggle('is-off', !state.enabled);
    }
    panel.querySelectorAll('.ygx-designs, .ygx-row').forEach(n => {
      n.style.opacity = state.enabled ? '1' : '0.4';
      n.style.pointerEvents = state.enabled ? '' : 'none';
    });
  }

  /* =========================================================================
   * 5. Styles
   * ====================================================================== */

  const CSS = `
  [data-ygx-hidden] { display: none !important; }

  #ygx-root {
    --ygx-bg:        #0f1116;
    --ygx-card:      #191c24;
    --ygx-card-hi:   #212530;
    --ygx-line:      #2a2f3b;
    --ygx-text:      #e9ecf3;
    --ygx-muted:     #97a0b2;
    --ygx-accent:    #3fbb85;
    --ygx-min:       260px;
    --ygx-cols:      6;
    box-sizing: border-box;
    width: 100%;
    padding: 20px 24px 60px;
    color: var(--ygx-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", Roboto, sans-serif;
  }
  #ygx-root *, #ygx-root *::before, #ygx-root *::after { box-sizing: border-box; }

  #ygx-grid { display: grid; gap: 18px; }

  .ygx-card {
    position: relative;
    display: flex;
    flex-direction: column;
    text-decoration: none !important;
    color: inherit;
    background: var(--ygx-card);
    border: 1px solid var(--ygx-line);
    border-radius: 14px;
    overflow: hidden;
    transition: transform .22s cubic-bezier(.2,.7,.3,1),
                border-color .22s, box-shadow .22s, background .22s;
  }
  .ygx-card:hover {
    background: var(--ygx-card-hi);
    border-color: #3a4152;
    transform: translateY(-3px);
    box-shadow: 0 14px 34px rgba(0,0,0,.45);
  }

  .ygx-media {
    position: relative;
    overflow: hidden;
    background: #0b0d12;
    flex: 0 0 auto;
  }
  .ygx-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity .35s ease, transform .5s cubic-bezier(.2,.7,.3,1);
  }
  .ygx-img.is-loaded { opacity: 1; }
  .ygx-card:hover .ygx-img { transform: scale(1.05); }

  .ygx-scrim {
    position: absolute; inset: auto 0 0 0; height: 55%;
    background: linear-gradient(to top, rgba(6,8,12,.88), rgba(6,8,12,0));
    opacity: 0; transition: opacity .25s; pointer-events: none;
  }

  .ygx-count {
    position: absolute; right: 8px; bottom: 8px;
    padding: 2px 7px; border-radius: 999px;
    font-size: 11px; font-weight: 600; line-height: 1.5;
    color: #dfe4ee; background: rgba(10,12,18,.72);
    backdrop-filter: blur(6px); z-index: 3;
  }
  .ygx-price-float {
    position: absolute; left: 8px; top: 8px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: .2px;
    color: #06120c; background: var(--ygx-accent);
    box-shadow: 0 2px 10px rgba(0,0,0,.35); z-index: 3;
    display: none;
  }

  .ygx-body { padding: 11px 12px 13px; display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; }
  .ygx-title {
    font-size: 13px; line-height: 1.45; color: var(--ygx-text);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
  }
  .ygx-meta { display: flex; align-items: center; gap: 8px; margin-top: auto; }
  .ygx-price { font-size: 14px; font-weight: 700; color: var(--ygx-accent); letter-spacing: .2px; }
  .ygx-chip {
    font-size: 11px; color: var(--ygx-muted);
    border: 1px solid var(--ygx-line); border-radius: 6px; padding: 2px 6px;
  }

  .ygx-strip { display: flex; gap: 4px; padding: 0 12px 12px; }
  .ygx-thumb {
    width: 100%; aspect-ratio: 1/1; object-fit: cover;
    border-radius: 5px; background: #0b0d12; opacity: .78; transition: opacity .2s;
  }
  .ygx-card:hover .ygx-thumb { opacity: 1; }

  /* ---- 1. Editorial ---------------------------------------------------- */
  #ygx-grid[data-design="editorial"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr));
    gap: 22px;
  }
  #ygx-grid[data-design="editorial"] .ygx-media { aspect-ratio: 4/5; }
  #ygx-grid[data-design="editorial"] .ygx-price-float { display: block; }
  #ygx-grid[data-design="editorial"] .ygx-price { display: none; }
  #ygx-grid[data-design="editorial"] .ygx-card { border-radius: 16px; }
  #ygx-grid[data-design="editorial"] .ygx-title { font-size: 13.5px; }

  /* ---- 2. Dense -------------------------------------------------------- */
  #ygx-grid[data-design="dense"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr));
    gap: 10px;
  }
  #ygx-grid[data-design="dense"] .ygx-card { border-radius: 10px; }
  #ygx-grid[data-design="dense"] .ygx-media { aspect-ratio: 1/1; }
  #ygx-grid[data-design="dense"] .ygx-price-float {
    display: block; left: 7px; top: auto; bottom: 7px;
    font-size: 11px; padding: 2px 8px;
  }
  #ygx-grid[data-design="dense"] .ygx-body {
    position: absolute; inset: auto 0 0 0; z-index: 4;
    padding: 26px 10px 10px;
    background: linear-gradient(to top, rgba(6,8,12,.95) 40%, rgba(6,8,12,0));
    opacity: 0; transform: translateY(6px);
    transition: opacity .2s, transform .2s;
  }
  #ygx-grid[data-design="dense"] .ygx-card:hover .ygx-body { opacity: 1; transform: none; }
  #ygx-grid[data-design="dense"] .ygx-card:hover .ygx-price-float { opacity: 0; }
  #ygx-grid[data-design="dense"] .ygx-title { font-size: 11.5px; -webkit-line-clamp: 3; }
  #ygx-grid[data-design="dense"] .ygx-meta { display: none; }
  #ygx-grid[data-design="dense"] .ygx-card:hover .ygx-img { transform: scale(1.08); }

  /* ---- 3. Info card ---------------------------------------------------- */
  #ygx-grid[data-design="info"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr));
    gap: 16px;
  }
  #ygx-grid[data-design="info"] .ygx-media { aspect-ratio: 1/1; border-bottom: 1px solid var(--ygx-line); }
  #ygx-grid[data-design="info"] .ygx-body { padding: 12px 12px 10px; }
  #ygx-grid[data-design="info"] .ygx-title { min-height: 2.9em; }
  #ygx-grid[data-design="info"] .ygx-meta {
    padding-top: 9px; border-top: 1px dashed var(--ygx-line);
    justify-content: space-between;
  }

  /* ---- 4. Masonry ------------------------------------------------------ */
  #ygx-grid[data-design="masonry"] {
    display: block;
    column-count: var(--ygx-cols);
    column-gap: 16px;
  }
  @media (max-width: 1500px) { #ygx-grid[data-design="masonry"] { column-count: 5; } }
  @media (max-width: 1200px) { #ygx-grid[data-design="masonry"] { column-count: 4; } }
  @media (max-width: 900px)  { #ygx-grid[data-design="masonry"] { column-count: 3; } }
  @media (max-width: 620px)  { #ygx-grid[data-design="masonry"] { column-count: 2; } }
  #ygx-grid[data-design="masonry"] .ygx-card {
    break-inside: avoid; display: inline-block; width: 100%;
    margin: 0 0 16px; border-radius: 12px;
  }
  #ygx-grid[data-design="masonry"] .ygx-media { aspect-ratio: auto; }
  #ygx-grid[data-design="masonry"] .ygx-img { height: auto; min-height: 90px; }
  #ygx-grid[data-design="masonry"] .ygx-scrim { opacity: 1; }
  #ygx-grid[data-design="masonry"] .ygx-body {
    position: absolute; inset: auto 0 0 0; z-index: 4;
    padding: 10px 12px 11px; gap: 4px;
  }
  #ygx-grid[data-design="masonry"] .ygx-title {
    -webkit-line-clamp: 1; font-size: 12px; color: #f2f5fa;
    text-shadow: 0 1px 3px rgba(0,0,0,.7);
  }
  #ygx-grid[data-design="masonry"] .ygx-chip { display: none; }
  #ygx-grid[data-design="masonry"] .ygx-price { font-size: 13px; text-shadow: 0 1px 3px rgba(0,0,0,.7); }

  /* ---- 5. Showcase ----------------------------------------------------- */
  #ygx-grid[data-design="showcase"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr));
    gap: 24px;
  }
  #ygx-grid[data-design="showcase"] .ygx-card { border-radius: 18px; }
  #ygx-grid[data-design="showcase"] .ygx-media { aspect-ratio: 3/4; }
  #ygx-grid[data-design="showcase"] .ygx-scrim { opacity: 1; height: 62%; }
  #ygx-grid[data-design="showcase"] .ygx-body {
    position: absolute; inset: auto 0 0 0; z-index: 4;
    padding: 14px 16px 16px; gap: 6px;
  }
  #ygx-grid[data-design="showcase"] .ygx-title {
    font-size: 14px; color: #fff; -webkit-line-clamp: 2;
    text-shadow: 0 1px 4px rgba(0,0,0,.75);
  }
  #ygx-grid[data-design="showcase"] .ygx-price {
    font-size: 18px; font-weight: 800; color: #fff;
    text-shadow: 0 1px 4px rgba(0,0,0,.75);
  }
  #ygx-grid[data-design="showcase"] .ygx-chip {
    background: rgba(255,255,255,.10); border-color: rgba(255,255,255,.18); color: #dfe5f0;
  }
  #ygx-grid[data-design="showcase"] .ygx-count { top: 10px; right: 10px; bottom: auto; }
  #ygx-grid[data-design="showcase"] .ygx-card:hover .ygx-img { transform: none; }

  /* ---- Control panel --------------------------------------------------- */
  .ygx-panel {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
    width: 246px; border-radius: 14px; overflow: hidden;
    background: rgba(20,23,30,.94);
    border: 1px solid #2c313d;
    box-shadow: 0 18px 44px rgba(0,0,0,.55);
    backdrop-filter: blur(10px);
    color: #e9ecf3;
    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .ygx-panel * { box-sizing: border-box; }
  .ygx-panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 10px 9px 12px; border-bottom: 1px solid #262b36;
  }
  .ygx-panel-title { font-weight: 700; letter-spacing: .3px; font-size: 12px; }
  .ygx-icon-btn {
    all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px;
    display: grid; place-items: center; color: #97a0b2; font-size: 15px;
  }
  .ygx-icon-btn:hover { background: #262b36; color: #fff; }
  .ygx-panel.is-collapsed .ygx-panel-body { display: none; }
  .ygx-panel-body { padding: 11px 12px 13px; display: flex; flex-direction: column; gap: 11px; }
  .ygx-designs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .ygx-design-btn {
    all: unset; cursor: pointer; text-align: center;
    padding: 7px 6px; border-radius: 8px; font-size: 11.5px; font-weight: 600;
    background: #232833; color: #b9c1d0; border: 1px solid transparent;
    transition: background .15s, color .15s, border-color .15s;
  }
  .ygx-design-btn:hover { background: #2b313e; color: #fff; }
  .ygx-design-btn.is-active { background: #3fbb85; color: #07130d; }
  .ygx-designs .ygx-design-btn:nth-child(5) { grid-column: 1 / -1; }
  .ygx-row { display: flex; align-items: center; gap: 9px; }
  .ygx-row-label { color: #97a0b2; font-size: 11px; white-space: nowrap; }
  .ygx-range { flex: 1; accent-color: #3fbb85; }
  .ygx-toggle {
    all: unset; cursor: pointer; text-align: center; padding: 7px;
    border-radius: 8px; font-size: 11.5px; font-weight: 600;
    background: #232833; color: #97a0b2; border: 1px solid #2c313d;
  }
  .ygx-toggle:hover { background: #2b313e; color: #fff; }
  .ygx-toggle.is-off { background: #3fbb85; color: #07130d; border-color: transparent; }
  `;

  function injectCSS() {
    try {
      if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; }
    } catch (e) { /* noop */ }
    const s = document.createElement('style');
    s.id = 'ygx-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* =========================================================================
   * 6. Boot
   * ====================================================================== */

  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function boot() {
    if (!document.querySelector('a[href*="/albums/"]')) return false;
    injectCSS();
    buildPanel();
    render(true);

    // Yupoo paginates and lazy-injects; re-render when the album set changes.
    const reflow = debounce(() => render(false), 220);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target && m.target.closest && m.target.closest('#ygx-root')) continue;
        if (m.addedNodes.length || m.removedNodes.length) { reflow(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true });

    // SPA-ish navigation
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastSignature = '';
        setTimeout(() => render(true), 400);
      }
    }, 700);

    return true;
  }

  let tries = 0;
  (function waitForAlbums() {
    if (boot()) return;
    if (++tries > 40) return; // ~10s
    setTimeout(waitForAlbums, 250);
  })();
})();
