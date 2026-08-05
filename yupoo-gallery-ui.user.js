// ==UserScript==
// @name         Yupoo Gallery UI+
// @namespace    yupoo-gallery-ui-plus
// @version      2.1.3
// @description  Rebuilds Yupoo album grids with 5 switchable card designs. Section-aware, dark theme, price badge, lazy loading, density control.
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
    { id: 'editorial', label: 'Editorial', min: 260, hint: 'Big 4:5 image, floating price pill, 2-line title.' },
    { id: 'dense',     label: 'Dense',     min: 150, hint: 'Square tiles, many per row, title on hover.' },
    { id: 'info',      label: 'Info card', min: 230, hint: 'Image + meta row + persistent thumbnail strip.' },
    { id: 'masonry',   label: 'Masonry',   min: 250, hint: 'Native aspect ratios in columns, caption scrim.' },
    { id: 'showcase',  label: 'Showcase',  min: 320, hint: 'Large cards, hover cycles through album photos.' }
  ];

  const DEFAULTS = { design: 'editorial', density: 1, enabled: true, widen: true };

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
    enabled: store.get('enabled', DEFAULTS.enabled) !== false,
    widen: store.get('widen', DEFAULTS.widen) !== false
  };
  if (!DESIGNS.some(d => d.id === state.design)) state.design = DEFAULTS.design;

  /* =========================================================================
   * 2. Scraping
   *
   * Verified against Yupoo's "category_commerce" template:
   *
   *   main.showindex__gallerycardwrap
   *     div.show-layout-category__catewrap          <- section (may be absent)
   *       a.show-layout-category__catetitle         <- heading, left in place
   *       div.showindex__parent                     <- GRID
   *         div.showindex__children                 <- card wrapper
   *           a.album3__main[data-album-id][title][href="/albums/<id>?..."]
   *             div.album3__loading                 <- skeleton, ignored
   *             div.album__imgwrap
   *               img.album__img.autocover          <- COVER (first image)
   *               div.album__photonumber            <- photo count
   *             div.album3__photoswrap
   *               div.album3__squareWrap > img.album3__img[data-src]   <- thumbs
   *             div.album3__title                   <- title
   *
   * Older templates use album__main / album__title; both are handled, and
   * there's a generic fallback for anything else.
   * ====================================================================== */

  const CARD_SEL = 'a.album3__main, a.album__main, a[data-album-id], a[href*="/albums/"]';
  const ALBUM_HREF = /\/albums\/(\d+)/;
  // Yupoo's own "not loaded yet" graphics, which must never be cached as a cover.
  const BAD_IMG = /(blank|placeholder|loading|spacer|1x1|nopic|no_pic|default_|\.svg($|\?)|^data:)/i;
  // A usable photo is one served by Yupoo's CDN, or at least a real raster file.
  const GOOD_IMG = /(photo\.yupoo\.com|\.(jpe?g|png|webp|gif)($|\?))/i;

  function isRealPhoto(u) { return !!u && !BAD_IMG.test(u) && GOOD_IMG.test(u); }

  /* ---- Price formats ------------------------------------------------------
   * Add new formats here — nothing else needs touching.
   *
   * Each entry's `src` is a regex source string that must capture the bare
   * number in group 1. They're tried in order, first match wins, and the
   * matched text is stripped from the title.
   *
   * NUM  accepts 1,299 / 299 / 299.50
   * NUM2 is the same but requires 2+ digits, used for the bare-letter forms
   *      so that "Y2K" or "S3" don't read as prices.
   * ---------------------------------------------------------------------- */

  const NUM  = '((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)';
  const NUM2 = '((?:\\d{1,3}(?:,\\d{3})+|\\d{2,})(?:\\.\\d+)?)';
  const NOTW = '(?<![A-Za-z0-9])';   // left word boundary, letters included
  const NOTW_R = '(?![A-Za-z0-9])';  // right word boundary

  const PRICE_SYMBOL = '¥';   // what gets rendered on the card, whatever was matched

  const PRICE_PATTERNS = [
    { name: '¥259',     src: '[¥￥]\\s*' + NUM },
    { name: '259¥',     src: NUM + '\\s*[¥￥]' },
    { name: '259Y',     src: NOTW + NUM2 + '\\s*[Yy]' + NOTW_R },
    { name: 'Y259',     src: NOTW + '[Yy]\\s*' + NUM2 },
    { name: '259元',    src: NUM + '\\s*元' },
    { name: '259RMB',   src: NUM + '\\s*(?:RMB|CNY)' + NOTW_R },
    { name: 'RMB259',   src: '(?:RMB|CNY)\\s*' + NUM }
  ];

  // Compiled defensively: lookbehind is unsupported on some older engines, and
  // an uncompilable literal would take the whole userscript down at parse time.
  const PRICE_RES = PRICE_PATTERNS.map(p => {
    try { return { name: p.name, re: new RegExp(p.src) }; } catch (e) { return null; }
  }).filter(Boolean);

  // -> { value: '259', matched: '¥259', format: '¥259' } or null
  function parsePrice(text) {
    if (!text) return null;
    for (const p of PRICE_RES) {
      const m = text.match(p.re);
      if (m && m[1]) return { value: m[1].replace(/,/g, ''), matched: m[0], format: p.name };
    }
    return null;
  }

  function absUrl(u) {
    if (!u) return '';
    u = u.trim();
    if (!u) return '';
    if (u.startsWith('//')) return location.protocol + u;
    if (u.startsWith('/')) return location.origin + u;
    return u;
  }

  // Yupoo serves /small /medium /big variants of the same path.
  function sized(url, want) {
    if (!url) return url;
    return url.replace(/\/(small|medium|big)(\.[a-z]{3,4})(\?.*)?$/i, '/' + want + '$2$3');
  }

  function urlFromNode(el) {
    if (!el || !el.getAttribute) return '';
    // data-origin-src is frequently present but empty — absUrl('') filters it.
    for (const a of ['data-origin-src', 'data-original', 'data-src', 'data-lazy', 'src']) {
      const v = absUrl(el.getAttribute(a));
      if (v && !BAD_IMG.test(v)) return v;
    }
    const bg = el.style && el.style.backgroundImage;
    if (bg) {
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !BAD_IMG.test(m[1])) return absUrl(m[1]);
    }
    return '';
  }

  function readImages(card) {
    const out = [];
    const seen = new Set();
    // Dedupe on the photo, not the URL: the cover and the first thumbnail are
    // the same picture at different sizes (/small vs /medium), so comparing raw
    // URLs lets a 1-photo album render its one image twice.
    const key = (u) => u.replace(/\/(small|medium|big)(\.[a-z]{3,4})($|\?)/i, '/*');
    const push = (u) => {
      if (!isRealPhoto(u)) return;
      const k = key(u);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(u);
    };

    // The cover is the album's first image — size guide or not, it's what shows.
    //
    // But Yupoo lazy-loads it: for albums below the fold, .album__img still has
    // a placeholder in src and an empty data-origin-src. Because we hide the
    // original grid, Yupoo's loader never scrolls it into view and never fills
    // it in. The first .album3__img thumbnail carries the same photo in its
    // data-src and is populated server-side, so it's the more reliable read —
    // we take the cover only when it's already a real photo.
    const cover = card.querySelector('.album__imgwrap img, .album__img');
    push(cover ? urlFromNode(cover) : '');

    card.querySelectorAll('.album3__photoswrap img, .album3__img, .album__othersimg')
      .forEach(im => push(urlFromNode(im)));

    if (out.length) return out;

    // Generic fallback for unknown templates: every image-ish node in DOM order,
    // skipping the loading skeleton.
    card.querySelectorAll('img, [data-src], [data-origin-src], [style*="background-image"]')
      .forEach(n => {
        if (n.closest('.album3__loading')) return;
        push(urlFromNode(n));
      });
    return out;
  }

  function readTitle(card) {
    const t = card.getAttribute('title');
    if (t && t.trim()) return t.trim().replace(/\s+/g, ' ');
    const node = card.querySelector('.album3__title, .album__title, [class*="title"]');
    if (node) {
      const v = (node.getAttribute('title') || node.textContent || '').trim();
      if (v) return v.replace(/\s+/g, ' ');
    }
    return (card.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function readCount(card) {
    const node = card.querySelector('.album__photonumber, [class*="photonumber"], [class*="imgnum"]');
    if (node) {
      const m = (node.textContent || '').match(/\d+/);
      if (m) return Number(m[0]);
    }
    return 0;
  }

  // Grow upward from the anchor until the container would swallow a 2nd card.
  function cardRootFor(anchor) {
    const known = anchor.closest('.showindex__children, li.album, .album__main');
    if (known && known !== anchor) return known;
    let node = anchor;
    let best = anchor;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      if (node === document.body) break;
      if (node.querySelectorAll(CARD_SEL).length > 1) break;
      best = node;
    }
    return best;
  }

  // Returns [{ grid: <original grid element>, items: [...] }]
  function scrapeGroups() {
    const anchors = Array.from(document.querySelectorAll(CARD_SEL));
    const groups = new Map();

    for (const a of anchors) {
      if (a.closest('.ygx-root')) continue;      // our own output
      if (a.closest('.pagination__main')) continue;
      const href = a.getAttribute('href') || '';
      if (!ALBUM_HREF.test(href)) continue;

      const card = cardRootFor(a);
      const grid = card.parentElement;
      if (!grid || grid === document.body) continue;

      const images = readImages(card);
      if (!images.length) continue;

      const rawTitle = readTitle(card);
      const pm = parsePrice(rawTitle);
      const count = readCount(card);

      const item = {
        href: a.href,
        target: a.getAttribute('target') || '',
        // Only the price is parsed out; the rest of the string stays verbatim.
        price: pm ? pm.value : '',
        title: (pm ? rawTitle.replace(pm.matched, '') : rawTitle)
          .replace(/^[\s\-–—:|,]+/, '')
          .replace(/\s+/g, ' ').trim(),
        images,
        count: count > 1 ? String(count) : ''
      };

      if (!groups.has(grid)) groups.set(grid, []);
      groups.get(grid).push(item);
    }

    return Array.from(groups.entries())
      .filter(([, items]) => items.length)
      .map(([grid, items]) => ({ grid, items }));
  }

  /* =========================================================================
   * 3. Rendering
   * ====================================================================== */

  const mounted = new Map();   // original grid element -> our .ygx-root element
  let io = null;
  let lastSignature = '';

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

    const media = el('div', 'ygx-media');
    const img = el('img', 'ygx-img');
    img.alt = item.title;
    img.decoding = 'async';

    const wantBig = design === 'editorial' || design === 'showcase' || design === 'masonry';
    const first = wantBig ? sized(item.images[0], 'medium') : item.images[0];
    img.dataset.ygxSrc = first;
    img.dataset.ygxFirst = first;

    // Not every album has a /medium variant, and an occasional cover 404s
    // outright — walk down to the small original, then to the next photo.
    const chain = [];
    for (const u of [first, item.images[0], item.images[1]]) {
      if (u && !chain.includes(u)) chain.push(u);
    }
    let step = 0;
    img.addEventListener('error', () => {
      if (++step >= chain.length) return;
      img.src = chain[step];
    });
    media.appendChild(img);
    lazyObserver().observe(img);

    if (item.count) media.appendChild(el('span', 'ygx-count', item.count));
    if (item.price) media.appendChild(el('span', 'ygx-price-float', PRICE_SYMBOL + item.price));
    media.appendChild(el('span', 'ygx-scrim'));

    const body = el('div', 'ygx-body');
    const title = el('div', 'ygx-title', item.title || '—');
    title.title = item.title;
    body.appendChild(title);

    const meta = el('div', 'ygx-meta');
    if (item.price) meta.appendChild(el('span', 'ygx-price', PRICE_SYMBOL + item.price));
    if (item.count) meta.appendChild(el('span', 'ygx-chip', item.count + ' photos'));
    if (meta.children.length) body.appendChild(meta);

    a.appendChild(media);
    a.appendChild(body);

    if (design === 'info' && item.images.length > 1) {
      const strip = el('div', 'ygx-strip');
      item.images.slice(1, 5).forEach(u => {
        const t = el('img', 'ygx-thumb');
        t.dataset.ygxSrc = u;
        lazyObserver().observe(t);
        strip.appendChild(t);
      });
      a.appendChild(strip);
    }

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

  function teardown() {
    mounted.forEach((root, grid) => {
      root.remove();
      grid.removeAttribute('data-ygx-hidden');
    });
    mounted.clear();
    if (io) { io.disconnect(); io = null; }
  }

  function render(force) {
    if (!state.enabled) return;
    const groups = scrapeGroups();
    if (!groups.length) return;

    const sig = state.design + '::' + groups.map(g => g.items.length + ':' + g.items.map(i => i.href).join(',')).join('|');
    if (!force && sig === lastSignature) return;
    lastSignature = sig;

    teardown();

    for (const { grid, items } of groups) {
      const root = el('div', 'ygx-root');
      const gridEl = el('div', 'ygx-grid');
      gridEl.setAttribute('data-design', state.design);
      const frag = document.createDocumentFragment();
      items.forEach(it => frag.appendChild(buildCard(it, state.design)));
      gridEl.appendChild(frag);
      root.appendChild(gridEl);

      // Sit exactly where the original grid sits, so category headings,
      // pagination and the rest of the page keep their position.
      grid.parentElement.insertBefore(root, grid);
      grid.setAttribute('data-ygx-hidden', '1');
      mounted.set(grid, root);
    }

    applyDensity();
  }

  function applyDensity() {
    const d = DESIGNS.find(x => x.id === state.design) || DESIGNS[0];
    const min = Math.round(d.min * state.density);
    const root = document.documentElement;
    root.style.setProperty('--ygx-min', min + 'px');
    root.style.setProperty('--ygx-cols', String(Math.max(1, Math.round(6 / state.density))));
  }

  function applyWiden() {
    document.documentElement.toggleAttribute('data-ygx-widen', state.widen);
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
    lastSignature = '';
    if (on) render(true);
    else teardown();
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

    const wideRow = el('label', 'ygx-row ygx-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = state.widen;
    cb.addEventListener('change', () => {
      state.widen = cb.checked;
      store.set('widen', state.widen);
      applyWiden();
    });
    wideRow.appendChild(cb);
    wideRow.appendChild(el('span', 'ygx-row-label', 'Full-width page'));
    bodyEl.appendChild(wideRow);

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

  /* Yupoo caps the album area at a fixed width. */
  [data-ygx-widen] .showindex__gallerycardwrap,
  [data-ygx-widen] .show-layout-category__catewrap,
  [data-ygx-widen] .categories__box,
  [data-ygx-widen] .categories__box.clearfix,
  [data-ygx-widen] .showalbum__children,
  [data-ygx-widen] .broadcastbar__wrap,
  [data-ygx-widen] .pagination__main {
    max-width: none !important;
    width: auto !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  [data-ygx-widen] .show-layout-category__catetitle { padding-left: 24px !important; }

  :root { --ygx-min: 260px; --ygx-cols: 6; }

  .ygx-root {
    --ygx-card:    #191c24;
    --ygx-card-hi: #212530;
    --ygx-line:    #2a2f3b;
    --ygx-text:    #e9ecf3;
    --ygx-muted:   #97a0b2;
    --ygx-accent:  #3fbb85;
    box-sizing: border-box;
    width: 100%;
    padding: 8px 24px 28px;
    color: var(--ygx-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", Roboto, sans-serif;
    /* Keep the whole grid below Yupoo's own overlays (category dropdown,
       lightbox, modals) rather than competing with them. */
    position: relative;
    z-index: 0;
    isolation: isolate;
  }
  .ygx-root *, .ygx-root *::before, .ygx-root *::after { box-sizing: border-box; }

  .ygx-grid { display: grid; gap: 18px; }

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
    /* Contains the price pill / count badge z-index inside the card, so they
       can't paint over page chrome. */
    isolation: isolate;
    transition: transform .22s cubic-bezier(.2,.7,.3,1),
                border-color .22s, box-shadow .22s, background .22s;
  }
  .ygx-card:hover {
    background: var(--ygx-card-hi);
    border-color: #3a4152;
    transform: translateY(-3px);
    box-shadow: 0 14px 34px rgba(0,0,0,.45);
  }

  .ygx-media { position: relative; overflow: hidden; background: #0b0d12; flex: 0 0 auto; }
  .ygx-img {
    display: block; width: 100%; height: 100%; object-fit: cover;
    opacity: 0; transition: opacity .35s ease, transform .5s cubic-bezier(.2,.7,.3,1);
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
    color: #dfe4ee; background: rgba(10,12,18,.72); z-index: 3;
  }
  .ygx-price-float {
    position: absolute; left: 8px; top: 8px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: .2px;
    color: #06120c; background: var(--ygx-accent);
    box-shadow: 0 2px 10px rgba(0,0,0,.35); z-index: 3; display: none;
  }

  .ygx-body { padding: 11px 12px 13px; display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; }
  .ygx-title {
    font-size: 13px; line-height: 1.45; color: var(--ygx-text);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
  }
  .ygx-meta { display: flex; align-items: center; gap: 8px; margin-top: auto; }
  .ygx-price { font-size: 14px; font-weight: 700; color: var(--ygx-accent); letter-spacing: .2px; }
  .ygx-chip { font-size: 11px; color: var(--ygx-muted); border: 1px solid var(--ygx-line); border-radius: 6px; padding: 2px 6px; }

  /* Thumbs hold a fixed quarter-width slot. With width:100% a 1- or 2-photo
     album stretched them to full card width and they rendered as a second
     giant image under the cover. */
  .ygx-strip { display: flex; gap: 4px; padding: 0 12px 12px; }
  .ygx-thumb {
    flex: 0 0 calc(25% - 3px); max-width: calc(25% - 3px);
    aspect-ratio: 1/1; object-fit: cover;
    border-radius: 5px; background: #0b0d12; opacity: .78; transition: opacity .2s;
  }
  .ygx-card:hover .ygx-thumb { opacity: 1; }

  /* ---- 1. Editorial ---------------------------------------------------- */
  .ygx-grid[data-design="editorial"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr)); gap: 22px;
  }
  .ygx-grid[data-design="editorial"] .ygx-media { aspect-ratio: 4/5; }
  .ygx-grid[data-design="editorial"] .ygx-price-float { display: block; }
  .ygx-grid[data-design="editorial"] .ygx-price { display: none; }
  .ygx-grid[data-design="editorial"] .ygx-card { border-radius: 16px; }

  /* ---- 2. Dense -------------------------------------------------------- */
  .ygx-grid[data-design="dense"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr)); gap: 10px;
  }
  .ygx-grid[data-design="dense"] .ygx-card { border-radius: 10px; }
  .ygx-grid[data-design="dense"] .ygx-media { aspect-ratio: 1/1; }
  .ygx-grid[data-design="dense"] .ygx-price-float {
    display: block; left: 7px; top: auto; bottom: 7px; font-size: 11px; padding: 2px 8px;
  }
  .ygx-grid[data-design="dense"] .ygx-body {
    position: absolute; inset: auto 0 0 0; z-index: 4; padding: 26px 10px 10px;
    background: linear-gradient(to top, rgba(6,8,12,.95) 40%, rgba(6,8,12,0));
    opacity: 0; transform: translateY(6px); transition: opacity .2s, transform .2s;
  }
  .ygx-grid[data-design="dense"] .ygx-card:hover .ygx-body { opacity: 1; transform: none; }
  .ygx-grid[data-design="dense"] .ygx-card:hover .ygx-price-float { opacity: 0; }
  .ygx-grid[data-design="dense"] .ygx-title { font-size: 11.5px; -webkit-line-clamp: 3; }
  .ygx-grid[data-design="dense"] .ygx-meta { display: none; }
  .ygx-grid[data-design="dense"] .ygx-card:hover .ygx-img { transform: scale(1.08); }

  /* ---- 3. Info card ---------------------------------------------------- */
  .ygx-grid[data-design="info"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr)); gap: 16px;
  }
  .ygx-grid[data-design="info"] .ygx-media { aspect-ratio: 1/1; border-bottom: 1px solid var(--ygx-line); }
  .ygx-grid[data-design="info"] .ygx-body { padding: 12px 12px 10px; }
  .ygx-grid[data-design="info"] .ygx-title { min-height: 2.9em; }
  .ygx-grid[data-design="info"] .ygx-meta {
    padding-top: 9px; border-top: 1px dashed var(--ygx-line); justify-content: space-between;
  }

  /* ---- 4. Masonry ------------------------------------------------------ */
  .ygx-grid[data-design="masonry"] { display: block; column-count: var(--ygx-cols); column-gap: 16px; }
  @media (max-width: 1500px) { .ygx-grid[data-design="masonry"] { column-count: 5; } }
  @media (max-width: 1200px) { .ygx-grid[data-design="masonry"] { column-count: 4; } }
  @media (max-width: 900px)  { .ygx-grid[data-design="masonry"] { column-count: 3; } }
  @media (max-width: 620px)  { .ygx-grid[data-design="masonry"] { column-count: 2; } }
  .ygx-grid[data-design="masonry"] .ygx-card {
    break-inside: avoid; display: inline-block; width: 100%; margin: 0 0 16px; border-radius: 12px;
  }
  .ygx-grid[data-design="masonry"] .ygx-media { aspect-ratio: auto; }
  .ygx-grid[data-design="masonry"] .ygx-img { height: auto; min-height: 90px; }
  .ygx-grid[data-design="masonry"] .ygx-scrim { opacity: 1; }
  .ygx-grid[data-design="masonry"] .ygx-body {
    position: absolute; inset: auto 0 0 0; z-index: 4; padding: 10px 12px 11px; gap: 4px;
  }
  .ygx-grid[data-design="masonry"] .ygx-title {
    -webkit-line-clamp: 1; font-size: 12px; color: #f2f5fa; text-shadow: 0 1px 3px rgba(0,0,0,.7);
  }
  .ygx-grid[data-design="masonry"] .ygx-chip { display: none; }
  .ygx-grid[data-design="masonry"] .ygx-price { font-size: 13px; text-shadow: 0 1px 3px rgba(0,0,0,.7); }

  /* ---- 5. Showcase ----------------------------------------------------- */
  .ygx-grid[data-design="showcase"] {
    grid-template-columns: repeat(auto-fill, minmax(var(--ygx-min), 1fr)); gap: 24px;
  }
  .ygx-grid[data-design="showcase"] .ygx-card { border-radius: 18px; }
  .ygx-grid[data-design="showcase"] .ygx-media { aspect-ratio: 3/4; }
  .ygx-grid[data-design="showcase"] .ygx-scrim { opacity: 1; height: 62%; }
  .ygx-grid[data-design="showcase"] .ygx-body {
    position: absolute; inset: auto 0 0 0; z-index: 4; padding: 14px 16px 16px; gap: 6px;
  }
  .ygx-grid[data-design="showcase"] .ygx-title {
    font-size: 14px; color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,.75);
  }
  .ygx-grid[data-design="showcase"] .ygx-price {
    font-size: 18px; font-weight: 800; color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,.75);
  }
  .ygx-grid[data-design="showcase"] .ygx-chip {
    background: rgba(255,255,255,.10); border-color: rgba(255,255,255,.18); color: #dfe5f0;
  }
  .ygx-grid[data-design="showcase"] .ygx-count { top: 10px; right: 10px; bottom: auto; }
  .ygx-grid[data-design="showcase"] .ygx-card:hover .ygx-img { transform: none; }

  /* ---- Control panel --------------------------------------------------- */
  .ygx-panel {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
    width: 246px; border-radius: 14px; overflow: hidden;
    background: rgba(20,23,30,.96); border: 1px solid #2c313d;
    box-shadow: 0 18px 44px rgba(0,0,0,.55); color: #e9ecf3;
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
  .ygx-panel-body { padding: 11px 12px 13px; display: flex; flex-direction: column; gap: 10px; }
  .ygx-designs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .ygx-design-btn {
    all: unset; cursor: pointer; text-align: center; padding: 7px 6px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600; background: #232833; color: #b9c1d0;
    transition: background .15s, color .15s;
  }
  .ygx-design-btn:hover { background: #2b313e; color: #fff; }
  .ygx-design-btn.is-active { background: #3fbb85; color: #07130d; }
  .ygx-designs .ygx-design-btn:nth-child(5) { grid-column: 1 / -1; }
  .ygx-row { display: flex; align-items: center; gap: 9px; }
  .ygx-check { cursor: pointer; }
  .ygx-check input { accent-color: #3fbb85; margin: 0; }
  .ygx-row-label { color: #97a0b2; font-size: 11px; white-space: nowrap; }
  .ygx-range { flex: 1; accent-color: #3fbb85; }
  .ygx-toggle {
    all: unset; cursor: pointer; text-align: center; padding: 7px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600; background: #232833; color: #97a0b2; border: 1px solid #2c313d;
  }
  .ygx-toggle:hover { background: #2b313e; color: #fff; }
  .ygx-toggle.is-off { background: #3fbb85; color: #07130d; border-color: transparent; }
  `;

  function injectCSS() {
    try { if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; } } catch (e) { /* noop */ }
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
    if (!document.querySelector(CARD_SEL)) return false;
    injectCSS();
    applyWiden();
    applyDensity();
    buildPanel();
    render(true);

    const reflow = debounce(() => render(false), 250);
    new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target;
        if (t && t.closest && (t.closest('.ygx-root') || t.closest('.ygx-panel'))) continue;
        if (m.addedNodes.length || m.removedNodes.length) { reflow(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true });

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
    if (++tries > 40) return;  // ~10s
    setTimeout(waitForAlbums, 250);
  })();
})();
