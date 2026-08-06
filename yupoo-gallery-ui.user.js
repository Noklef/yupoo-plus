// ==UserScript==
// @name         Yupoo Gallery UI+
// @namespace    yupoo-gallery-ui-plus
// @version      2.9.0
// @description  Rebuilds Yupoo album grids with 5 switchable card designs. Section-aware, full-page light/dark theme, price badge, lazy loading, density control, endless scroll.
// @match        *://*.yupoo.com/*
// @exclude      *://photo.yupoo.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ---- 0. Config ------------------------------------------------------- */

  const DESIGNS = [
    { id: 'editorial', label: 'Editorial', min: 260, hint: 'Big 4:5 image, floating price pill, 2-line title.' },
    { id: 'dense',     label: 'Dense',     min: 150, hint: 'Square tiles, many per row, title on hover.' },
    { id: 'info',      label: 'Info card', min: 230, hint: 'Image + meta row + persistent thumbnail strip.' },
    { id: 'masonry',   label: 'Masonry',   min: 250, hint: 'Native aspect ratios in columns, caption scrim.' },
    { id: 'showcase',  label: 'Showcase',  min: 320, hint: 'Large cards, hover cycles through album photos.' }
  ];

  const DEFAULTS = {
    design: 'editorial', density: 1, enabled: true, widen: true,
    theme: 'light', endless: false, collapsed: false
  };

  // Live, not a snapshot: cards outlive the query, so the hover cycle reads it
  // each time rather than baking the boot-time answer in.
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Shelved, not removed: it loads and dedupes correctly but crashes long
  // sessions. Flip to true to pick it back up; nothing else needs changing.
  const ENDLESS_READY = false;
  const THEMES = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

  /* ---- 1. Storage (GM_* with localStorage fallback) -------------------- */

  const store = {
    get(k, d) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch { /* noop */ }
      try {
        const v = localStorage.getItem('ygx:' + k);
        return v === null ? d : JSON.parse(v);
      } catch { return d; }
    },
    set(k, v) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch { /* noop */ }
      try { localStorage.setItem('ygx:' + k, JSON.stringify(v)); } catch { /* noop */ }
    }
  };

  const state = {
    design: store.get('design', DEFAULTS.design),
    density: Number(store.get('density', DEFAULTS.density)) || 1,
    enabled: store.get('enabled', DEFAULTS.enabled) !== false,
    widen: store.get('widen', DEFAULTS.widen) !== false,
    theme: store.get('theme', DEFAULTS.theme),
    collapsed: store.get('collapsed', DEFAULTS.collapsed) === true,
    // Forced off while shelved, so a previously saved true does not revive it.
    endless: ENDLESS_READY && store.get('endless', DEFAULTS.endless) === true
  };
  if (!DESIGNS.some(d => d.id === state.design)) state.design = DEFAULTS.design;
  if (!THEMES.some(t => t.id === state.theme)) state.theme = DEFAULTS.theme;

  /* ---- 2. Scraping ----------------------------------------------------- */

  // Yupoo's three templates and their DOM shapes are mapped in CLAUDE.md.
  // Older album__main / album__title markup and unknown templates fall back.

  const CARD_SEL = 'a.album3__main, a.album__main, a[data-album-id], a[href*="/albums/"]';
  const ALBUM_HREF = /\/albums\/(\d+)/;
  const COLLECTION_HREF = /\/collections\/(\d+)/;
  const CATEGORY_HREF = /\/categories\/(\d+)/;
  // Yupoo's own "not loaded yet" graphics, which must never be cached as a cover.
  const BAD_IMG = /(blank|placeholder|loading|spacer|1x1|nopic|no_pic|default_|\.svg($|\?)|^data:)/i;
  // A usable photo is one served by Yupoo's CDN, or at least a real raster file.
  const GOOD_IMG = /(photo\.yupoo\.com|\.(jpe?g|png|webp|gif)($|\?))/i;
  // A real .png on a real CDN, so GOOD_IMG accepts it and BAD_IMG misses it.
  const PLACEHOLDER_IMG = /im_photo_album/i;

  // Lazy-load attributes first: `src` is often a 1x1 data: URI, and Yupoo's
  // /square variant only ever appears there.
  const IMG_ATTRS = ['data-origin-src', 'data-original', 'data-src', 'data-lazy', 'src'];

  // Read by readCount and stripped by readTitle's fallback, which would
  // otherwise hand the photo count to parsePrice as a candidate number.
  const COUNT_SEL = '.album__photonumber, [class*="photonumber"], [class*="imgnum"]';

  function isRealPhoto(u) {
    return !!u && !BAD_IMG.test(u) && !PLACEHOLDER_IMG.test(u) && GOOD_IMG.test(u);
  }

  // Flagged rather than dropped: the card still has a title and price. The zero
  // count stops a real cover that matches the filename reading as empty.
  function isEmptyAlbum(card, count) {
    if (count !== 0) return false;
    return Array.from(card.querySelectorAll('img')).some(n =>
      IMG_ATTRS.some(attr => PLACEHOLDER_IMG.test(n.getAttribute(attr) || '')));
  }

  /* ---- Price formats: add here, nothing else needs touching ------------- */

  // Each `src` captures the bare number in group 1; tried in order, first wins.
  // NUM takes 1,299 / 299 / 299.50; NUM2 needs 2+ digits so "Y2K" is not a price.

  const NUM  = '((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)';
  const NUM2 = '((?:\\d{1,3}(?:,\\d{3})+|\\d{2,})(?:\\.\\d+)?)';
  const NOTW = '(?<![A-Za-z0-9])';   // left word boundary, letters included
  const NOTW_R = '(?![A-Za-z0-9])';  // right word boundary
  // Lookbehind-free stand-in. It consumes the boundary character, so the match
  // runs one char wide, which the title's leading-punctuation strip absorbs.
  const NOTW_ALT = '(?:^|[^A-Za-z0-9])';

  const PRICE_SYMBOL = '¥';   // what gets rendered on the card, whatever was matched

  const PRICE_PATTERNS = [
    { name: '¥259',     src: '[¥￥]\\s*' + NUM },
    { name: '259¥',     src: NUM + '\\s*[¥￥]' },
    { name: '259Y',     src: NOTW + NUM2 + '\\s*[Yy]' + NOTW_R,
                        alt: NOTW_ALT + NUM2 + '\\s*[Yy]' + NOTW_R },
    { name: 'Y259',     src: NOTW + '[Yy]\\s*' + NUM2,
                        alt: NOTW_ALT + '[Yy]\\s*' + NUM2 },
    { name: '259元',    src: NUM + '\\s*元' },
    { name: '259RMB',   src: NUM + '\\s*(?:RMB|CNY)' + NOTW_R },
    { name: 'RMB259',   src: '(?:RMB|CNY)\\s*' + NUM }
  ];

  // Compiled defensively: lookbehind is unsupported on some older engines, and
  // an uncompilable literal would take the whole userscript down at parse time.
  // A pattern that will not compile falls back to its `alt`, so the format
  // degrades to looser matching instead of disappearing.
  const PRICE_RES = PRICE_PATTERNS.map(p => {
    for (const src of [p.src, p.alt]) {
      if (!src) continue;
      try { return { name: p.name, re: new RegExp(src) }; } catch { /* try alt */ }
    }
    return null;
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

  // Yupoo serves /small /medium /big variants of the same path. One shape for
  // both pinning a size and building the dedupe key, so they cannot drift.
  const SIZE_RE = /\/(small|medium|big)(\.[a-z]{3,4})(\?.*)?$/i;

  // Everything is pinned to /small at scrape time, so nothing downstream picks.
  function sized(url, want) {
    if (!url) return url;
    return url.replace(SIZE_RE, '/' + want + '$2$3');
  }

  function urlFromNode(node) {
    if (!node || !node.getAttribute) return '';
    // data-origin-src is frequently present but empty — absUrl('') filters it.
    for (const a of IMG_ATTRS) {
      const v = absUrl(node.getAttribute(a));
      if (v && !BAD_IMG.test(v)) return v;
    }
    const bg = node.style && node.style.backgroundImage;
    if (bg) {
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !BAD_IMG.test(m[1])) return absUrl(m[1]);
    }
    return '';
  }

  function readImages(card) {
    const out = [];
    const seen = new Set();
    // Dedupe on the photo, not the URL: cover and first thumbnail are one
    // picture at two sizes, so raw URLs render a 1-photo album twice.
    const key = (u) => sized(u, '*');
    const push = (u) => {
      if (!isRealPhoto(u)) return;
      const k = key(u);
      if (seen.has(k)) return;
      seen.add(k);
      // Normalised here rather than at use: /small is 500x500, comfortably over
      // any card we render, so no design or hover state needs a bigger variant.
      out.push(sized(u, 'small'));
    };

    // Below the fold .album__img is still a placeholder and our hidden grid
    // means it never fills in, so take the cover only when it is a real photo.
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
    // Last resort on unknown templates. The badges come off first, or the photo
    // count lands in the title and parsePrice reads its digits as a price.
    const clone = card.cloneNode(true);
    clone.querySelectorAll(COUNT_SEL + ', .album3__loading, .album3__showmore')
      .forEach(n => n.remove());
    return (clone.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function readCount(card) {
    const node = card.querySelector(COUNT_SEL);
    if (node) {
      const m = (node.textContent || '').match(/\d+/);
      if (m) return Number(m[0]);
    }
    return 0;
  }

  // Grow upward from the anchor until the container would swallow a 2nd card.
  function cardRootFor(anchor, anchors) {
    // .categories__children is the /categories listing; .showindex__children
    // is the album grid and the category_commerce home page.
    const known = anchor.closest('.showindex__children, .categories__children, li.album, .album__main');
    if (known && known !== anchor) return known;
    let node = anchor;
    let best = anchor;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      if (node === document.body) break;
      // Containment against the anchors already in hand. A querySelectorAll per
      // ancestor re-scans the whole grid, which is quadratic in the card count.
      if (anchors.some(o => o !== anchor && node.contains(o))) break;
      best = node;
    }
    return best;
  }

  // Returns [{ grid: <original grid element>, items: [...] }]
  function scrapeGroups() {
    // Filtered up front rather than skipped in the loop: cardRootFor tests
    // containment against this list and must not count our own cards.
    const anchors = Array.from(document.querySelectorAll(CARD_SEL))
      .filter(a => !a.closest('.ygx-root') && !a.closest('.pagination__main'));
    const groups = new Map();

    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      // Href plus marker node, so a plain collection link elsewhere on the page
      // isn't mistaken for a "more" tile.
      const showmore = COLLECTION_HREF.test(href) ? a.querySelector('.album3__showmore') : null;
      if (!showmore && !ALBUM_HREF.test(href)) continue;

      const card = cardRootFor(a, anchors);
      const grid = card.parentElement;
      if (!grid || grid === document.body) continue;

      const base = { href: a.href, target: a.getAttribute('target') || '' };
      let item;

      if (showmore) {
        // <p class="album3__more">more</p><p>1298 items</p>
        const ps = showmore.querySelectorAll('p');
        item = Object.assign(base, {
          more: true,
          title: (showmore.querySelector('.album3__more') || ps[0] || {}).textContent || 'More',
          note: ps.length > 1 ? (ps[ps.length - 1].textContent || '').trim() : '',
          images: [], price: '', count: ''
        });
        item.title = item.title.trim() || 'More';
      } else {
        const count = readCount(card);
        const images = readImages(card);
        // No images and no placeholder means the scrape missed, not an empty album.
        const empty = !images.length && isEmptyAlbum(card, count);
        if (!images.length && !empty) continue;

        const rawTitle = readTitle(card);
        const pm = parsePrice(rawTitle);

        item = Object.assign(base, {
          empty,
          // Only the price is parsed out; the rest of the string stays verbatim.
          price: pm ? pm.value : '',
          title: (pm ? rawTitle.replace(pm.matched, '') : rawTitle)
            .replace(/^[\s\-–—:|,]+/, '')
            .replace(/\s+/g, ' ').trim(),
          images,
          count: count > 1 ? String(count) : ''
        });
      }

      if (!groups.has(grid)) groups.set(grid, []);
      groups.get(grid).push(item);
    }

    return Array.from(groups.entries())
      .filter(([, items]) => items.length)
      .map(([grid, items]) => ({ grid, items }));
  }

  /* ---- 3. Rendering ---------------------------------------------------- */

  const mounted = new Map();   // original grid element -> { root, gridEl, keys }
  let io = null;
  let lastSignature = '';
  let mountedDesign = '';
  // Module scope, because only one card can be hovered at a time and a per-card
  // interval outlives its card: a removed node never fires mouseleave.
  let cycleTimer = null;

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

  // Static markup, inlined so the card stays self-contained and takes currentColor.
  const EMPTY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4.5 3.5h15A1.5 1.5 0 0 1 21 5v14a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19V5a1.5 1.5 0 0 1 1.5-1.5z"/>' +
    '<path d="M3.4 16.6l4.3-4.3a2 2 0 0 1 2.8 0l3.6 3.6"/>' +
    '<circle cx="15.5" cy="8.5" r="1.4"/>' +
    '<path d="M3.4 3.4l17.2 17.2"/></svg>';

  // Shared by the empty-album card and by an image whose fallbacks all 404.
  function emptyBox(label) {
    const box = el('div', 'ygx-empty-box');
    const icon = el('span', 'ygx-empty-icon');
    icon.innerHTML = EMPTY_ICON;
    box.appendChild(icon);
    box.appendChild(el('span', 'ygx-empty-label', label));
    return box;
  }

  function stopCycle() {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }

  function buildCard(item, design) {
    const a = el('a', 'ygx-card');
    a.href = item.href;
    if (item.target) a.target = item.target;

    // Content goes in the media area, since Dense hides .ygx-body until hover.
    if (item.more) {
      a.classList.add('is-more');
      const box = el('div', 'ygx-more-box');
      box.appendChild(el('span', 'ygx-more-arrow', '→'));
      box.appendChild(el('span', 'ygx-more-label', item.title));
      if (item.note) box.appendChild(el('span', 'ygx-more-note', item.note));
      const wrap = el('div', 'ygx-media');
      wrap.appendChild(box);
      a.appendChild(wrap);
      return a;
    }

    const media = el('div', 'ygx-media');
    let img = null;

    if (item.empty) {
      // Media area again, so it survives the designs that hide the body.
      a.classList.add('is-empty');
      media.appendChild(emptyBox('No photos'));
    } else {
      img = el('img', 'ygx-img');
      img.alt = item.title;
      img.decoding = 'async';

      const first = item.images[0];
      img.dataset.ygxSrc = first;
      img.dataset.ygxFirst = first;

      // An occasional cover 404s outright, so step to the next photo. There is
      // no size fallback to make now that every URL is already /small.
      const chain = [first, item.images[1]].filter(Boolean);
      let step = 0;
      img.addEventListener('error', () => {
        if (++step < chain.length) { img.src = chain[step]; return; }
        // .ygx-img only fades in on load, so an exhausted chain would leave an
        // invisible card. Fall back to the empty-album treatment instead.
        if (io) io.unobserve(img);
        img.remove();
        a.classList.add('is-empty');
        media.appendChild(emptyBox('Image unavailable'));
      });
      media.appendChild(img);
      lazyObserver().observe(img);
    }

    if (item.count) media.appendChild(el('span', 'ygx-count', item.count));
    if (item.price) media.appendChild(el('span', 'ygx-price-float', PRICE_SYMBOL + item.price));
    media.appendChild(el('span', 'ygx-scrim'));

    const body = el('div', 'ygx-body');
    const title = el('div', 'ygx-title', item.title || '—');
    if (item.title) title.title = item.title;
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
      a.addEventListener('mouseenter', () => {
        if (REDUCED.matches) return;
        stopCycle();
        let i = 0;
        cycleTimer = setInterval(() => {
          i = (i + 1) % item.images.length;
          img.src = item.images[i];
        }, 900);
      });
      a.addEventListener('mouseleave', () => {
        stopCycle();
        img.src = img.dataset.ygxFirst;
      });
    }

    return a;
  }

  function unmountGroup(grid) {
    const m = mounted.get(grid);
    if (!m) return;
    stopCycle();
    m.root.remove();
    grid.removeAttribute('data-ygx-hidden');
    mounted.delete(grid);
  }

  function teardown() {
    Array.from(mounted.keys()).forEach(unmountGroup);
    if (io) { io.disconnect(); io = null; }
  }

  function mountGroup(grid, items) {
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
    mounted.set(grid, { root, gridEl, keys: items.map(i => i.href) });
  }

  // Same cards in the same order means the mounted DOM is still correct, and a
  // pure append only builds the tail. Rebuilding re-decodes every image, which
  // is what made a mutation-triggered render so expensive.
  function reconcile(m, items) {
    if (!m.root.isConnected || items.length < m.keys.length) return false;
    for (let i = 0; i < m.keys.length; i++) {
      if (m.keys[i] !== items[i].href) return false;
    }
    if (items.length > m.keys.length) {
      const frag = document.createDocumentFragment();
      items.slice(m.keys.length).forEach(it => frag.appendChild(buildCard(it, state.design)));
      m.gridEl.appendChild(frag);
      m.keys = items.map(i => i.href);
    }
    return true;
  }

  function render(force) {
    if (!state.enabled) return;
    const groups = scrapeGroups();
    // Torn down before the early return: an empty scrape means the page changed
    // under us, not that the cards we mounted are still valid.
    if (!groups.length) { teardown(); lastSignature = ''; return; }

    const sig = signature(groups);
    // Liveness is part of the check. Yupoo can replace its grid with an
    // identical list, which leaves the signature equal and our roots detached.
    const live = mounted.size > 0 && Array.from(mounted.keys()).every(g => g.isConnected);
    if (!force && sig === lastSignature && live) return;

    // buildCard bakes the design into each card, so a design change is the one
    // case that cannot reconcile.
    if (force || mountedDesign !== state.design) teardown();

    const keep = new Set();
    for (const { grid, items } of groups) {
      keep.add(grid);
      const m = mounted.get(grid);
      if (m && reconcile(m, items)) continue;
      unmountGroup(grid);
      mountGroup(grid, items);
    }
    // Sections the page no longer has.
    Array.from(mounted.keys()).forEach(g => { if (!keep.has(g)) unmountGroup(g); });

    mountedDesign = state.design;
    applyDensity();
    // Roots are inserted before their hidden grid, so a rebuild would otherwise
    // leave the sentinel stranded above the gallery and permanently in view.
    placeSentinel();
    // Committed last: a throw above must not record a signature that stops the
    // next render from retrying.
    lastSignature = sig;
  }

  function signature(groups) {
    return state.design + '::' +
      groups.map(g => g.items.length + ':' + g.items.map(i => i.href).join(',')).join('|');
  }

  /* ---- 3b. Endless scroll ---------------------------------------------- */

  // All three page types expose the same next link, hrefless on the last page.
  // Cards graft into the hidden original markup, so teardown stays a real restore.

  const NEXT_SEL = 'nav.pagination__main a[title="next page"]';
  const GRID_SEL = '.showindex__parent, .categories__parent';

  // Hard ceiling per page view. Every other guard depends on an event firing;
  // this one does not, so runaway loading stays bounded whatever else breaks.
  const MAX_PAGES = 10;

  // url: null is "not looked up yet", '' is "no further pages". armed clears on
  // each load and returns on scroll, so a sentinel in view cannot self-chain.
  const endless = {
    url: null, busy: false, armed: true, paused: false,
    pages: 0, node: null, io: null, extra: null, seen: new Set()
  };

  function nextPageUrl(doc) {
    const a = doc.querySelector(NEXT_SEL);
    const href = a && a.getAttribute('href');
    return href ? new URL(href, location.href).href : '';
  }

  function albumId(node) {
    const a = node.querySelector(CARD_SEL) || node;
    const m = (a.getAttribute('href') || '').match(ALBUM_HREF);
    return m ? m[1] : '';
  }

  function endlessStatus(text) {
    if (!endless.node) return;
    endless.node.firstChild.textContent = text;
    endless.node.classList.toggle('is-paused', endless.paused);
  }

  // Kept outside .ygx-root so render()'s teardown can't take it with it.
  function placeSentinel() {
    if (!state.endless || !state.enabled) return;
    if (!endless.node) {
      endless.node = el('div', 'ygx-endless');
      endless.node.appendChild(el('span', 'ygx-endless-text', ''));
      // Resuming from the page cap, so it only does anything while paused.
      endless.node.addEventListener('click', () => {
        if (!endless.paused) return;
        endless.paused = false;
        endless.pages = 0;
        endless.armed = true;
        loadNextPage();
      });
    }
    const roots = document.querySelectorAll('.ygx-root');
    const last = roots[roots.length - 1];
    if (!last) return;
    // Anchor to the hidden grid, not the root: roots insert before their grid,
    // so the root's slot is where the next rebuild hoists it above the cards.
    let anchor = last;
    mounted.forEach((m, grid) => { if (m.root === last) anchor = grid; });
    anchor.parentElement.insertBefore(endless.node, anchor.nextSibling);
    if (!endless.io) {
      endless.io = new IntersectionObserver(es => {
        if (endless.armed && es.some(e => e.isIntersecting)) loadNextPage();
      }, { rootMargin: '400px 0px' });
    }
    // Re-observing forces a fresh callback: staying in view is not a change, so
    // without this the second page never triggers a third.
    endless.io.unobserve(endless.node);
    endless.io.observe(endless.node);
  }

  async function loadNextPage() {
    if (endless.busy || endless.paused || !endless.url || !state.endless || !state.enabled) return;
    endless.busy = true;
    endless.armed = false;
    endlessStatus('Loading more…');

    let doc;
    try {
      // Bounded: a hung request would otherwise pin busy=true with no retry.
      const res = await fetch(endless.url, {
        credentials: 'same-origin',
        signal: window.AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(String(res.status));
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    } catch {
      endless.busy = false;
      endlessStatus('Could not load the next page. Scroll to retry.');
      return;
    }

    const live = Array.from(document.querySelectorAll(GRID_SEL)).filter(g => !g.closest('.ygx-root'));
    // One live grid means a flat list the next page continues. Several means
    // sections, so later pages share a container instead of the last heading.
    let target = live.length === 1 ? live[0] : endless.extra;

    for (const g of Array.from(doc.querySelectorAll(GRID_SEL))) {
      const kids = Array.from(g.children).filter(k => {
        const id = albumId(k);
        if (id && endless.seen.has(id)) return false;
        if (id) endless.seen.add(id);
        return true;
      });
      if (!kids.length) continue;

      if (!target) {
        target = g.cloneNode(false);
        endless.extra = target;
        const last = live[live.length - 1];
        last.parentElement.insertBefore(target, last.nextSibling);
      }
      kids.forEach(k => target.appendChild(document.adoptNode(k)));
    }

    endless.url = nextPageUrl(doc);
    endless.busy = false;
    endless.pages++;
    endless.paused = endless.pages >= MAX_PAGES && !!endless.url;
    // render() reconciles, so an appended page only builds the cards it added.
    render(false);
    if (endless.paused) endlessStatus('Paused after ' + endless.pages + ' pages. Click to load more.');
    else endlessStatus(endless.url ? '' : 'End of results');
  }

  function startEndless() {
    if (!state.endless || !state.enabled) return;
    if (!endless.seen.size) {
      document.querySelectorAll(CARD_SEL).forEach(a => {
        const m = (a.getAttribute('href') || '').match(ALBUM_HREF);
        if (m) endless.seen.add(m[1]);
      });
    }
    if (endless.url === null) endless.url = nextPageUrl(document);
    endless.armed = true;
    placeSentinel();
    endlessStatus(endless.url ? '' : 'End of results');
  }

  function stopEndless() {
    if (endless.io) { endless.io.disconnect(); endless.io = null; }
    if (endless.node) { endless.node.remove(); endless.node = null; }
  }

  // Appended pages stay in the DOM; only the tracking resets, so a fresh page
  // starts counting from its own first result.
  function resetEndless() {
    stopEndless();
    endless.url = null;
    endless.busy = false;
    endless.armed = true;
    endless.paused = false;
    endless.pages = 0;
    endless.extra = null;
    endless.seen.clear();
  }

  function applyDensity() {
    const d = DESIGNS.find(x => x.id === state.design) || DESIGNS[0];
    const min = Math.round(d.min * state.density);
    const root = document.documentElement;
    root.style.setProperty('--ygx-min', min + 'px');
  }

  function applyWiden() {
    document.documentElement.toggleAttribute('data-ygx-widen', state.widen && state.enabled);
  }

  // Gates the page-chrome restyle (sidebar, pagination) so that
  // "Restore original layout" puts everything back, not just the grid.
  function applyEnabledAttr() {
    document.documentElement.toggleAttribute('data-ygx-on', state.enabled);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-ygx-theme', state.theme);
  }

  // Hides Yupoo's own paginators, which endless scroll has taken over from.
  function applyEndlessAttr() {
    document.documentElement.toggleAttribute('data-ygx-endless', state.endless && state.enabled);
  }

  // Yupoo ships no "current" class for the sub-category row, and it sizes the
  // fold for its own 46px rows, so both are redone here for the pill layout.
  function syncSubcats() {
    const wrap = document.querySelector('.categories__box-right-categories-wrap');
    const inner = wrap && wrap.querySelector('.categories__box-right-categories');
    if (!inner) return;

    const here = (location.pathname.match(CATEGORY_HREF) || [])[1];
    inner.querySelectorAll('.categories__box-right-category-item').forEach(a => {
      const m = (a.getAttribute('href') || '').match(CATEGORY_HREF);
      a.classList.toggle('ygx-here', !!here && !!m && m[1] === here);
    });

    const toggle = wrap.querySelector('.categories__box-right-categories-toggle');
    if (!toggle) return;
    const clipped = inner.scrollHeight > inner.clientHeight + 1;
    toggle.style.display = clipped || !wrap.classList.contains('is-fold') ? '' : 'none';
  }

  function setTheme(id) {
    state.theme = id;
    store.set('theme', id);
    applyTheme();
    syncPanel();
  }

  function setDesign(id) {
    state.design = id;
    store.set('design', id);
    render(true);
    syncPanel();
  }

  function setEndless(on) {
    state.endless = on;
    store.set('endless', on);
    applyEndlessAttr();
    if (on) startEndless();
    else stopEndless();
  }

  function setEnabled(on) {
    state.enabled = on;
    store.set('enabled', on);
    lastSignature = '';
    applyEnabledAttr();
    applyEndlessAttr();
    applyWiden();
    if (on) { render(true); startEndless(); }
    else { teardown(); stopEndless(); }
    syncPanel();
  }

  /* ---- 4. Control panel ------------------------------------------------ */

  let panel = null;

  function buildPanel() {
    if (panel) return;
    panel = el('div', 'ygx-panel');
    panel.id = 'ygx-panel';
    // Persisted like every other setting, rather than reopening each page.
    panel.classList.toggle('is-collapsed', state.collapsed);

    const head = el('div', 'ygx-panel-head');
    head.appendChild(el('span', 'ygx-panel-title', 'Gallery UI+'));
    const collapse = el('button', 'ygx-icon-btn', state.collapsed ? '+' : '−');
    collapse.title = 'Collapse';
    collapse.addEventListener('click', () => {
      state.collapsed = panel.classList.toggle('is-collapsed');
      store.set('collapsed', state.collapsed);
      collapse.textContent = state.collapsed ? '+' : '−';
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

    const themes = el('div', 'ygx-themes');
    THEMES.forEach(t => {
      const b = el('button', 'ygx-theme-btn', t.label);
      b.dataset.theme = t.id;
      b.addEventListener('click', () => setTheme(t.id));
      themes.appendChild(b);
    });
    bodyEl.appendChild(themes);

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

    const endRow = el('label', 'ygx-row ygx-check');
    const endCb = el('input');
    endCb.type = 'checkbox';
    endCb.checked = state.endless;
    endCb.disabled = !ENDLESS_READY;
    endCb.addEventListener('change', () => setEndless(endCb.checked));
    endRow.appendChild(endCb);
    endRow.appendChild(el('span', 'ygx-row-label', 'Endless scroll'));
    if (!ENDLESS_READY) {
      endRow.classList.add('ygx-shelved');
      endRow.title = 'WIP: loads pages correctly, but crashes long sessions.';
      endRow.appendChild(el('span', 'ygx-note', 'WIP'));
    }
    bodyEl.appendChild(endRow);

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
    panel.querySelectorAll('.ygx-theme-btn').forEach(b => {
      b.classList.toggle('is-active', b.dataset.theme === state.theme);
    });
    const t = panel.querySelector('#ygx-toggle');
    if (t) {
      t.textContent = state.enabled ? 'Restore original layout' : 'Enable Gallery UI+';
      t.classList.toggle('is-off', !state.enabled);
    }
    // A class, not inline styles: the dim value belongs in the stylesheet, and
    // this way the theme buttons dim with everything else.
    panel.classList.toggle('is-disabled', !state.enabled);
  }

  /* ---- 5. Styles ------------------------------------------------------- */

  const CSS = `
  [data-ygx-hidden] { display: none !important; }

  /* Yupoo caps the album area at a fixed width. */
  [data-ygx-widen] .showindex__gallerycardwrap,
  [data-ygx-widen] .show-layout-category__catewrap,
  [data-ygx-widen] .categories__box,
  [data-ygx-widen] .categories__box.clearfix,
  /* The album page's two capped containers. NOT .showalbum__children, which is
     each photo tile: Yupoo sizes those calc((100% - 16px) / 2), so widening
     them collapsed the 2-up grid and ate the gutters. */
  [data-ygx-widen] .showalbum__imagecardwrap,
  [data-ygx-widen] .showalbumheader__main,
  [data-ygx-widen] .broadcastbar__wrap,
  [data-ygx-widen] .pagination__main {
    max-width: none !important;
    width: auto !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  [data-ygx-widen] .show-layout-category__catetitle { padding-left: 24px !important; }

  /* ---- Page chrome: header stack, broadcast bar, paginator, footer ---- */

  /* On :root, not .ygx-root: the chrome sits outside the grid and cannot
     inherit from it. Every chrome colour is a token, so the light theme is a
     re-declaration of this block plus the image-based exceptions. */
  :root {
    --ygx-page:     #0f1116;
    --ygx-bar:      #191c24;
    --ygx-bar-alt:  #14171d;
    --ygx-bar-line: #2a2f3b;
    --ygx-bar-text: #e9ecf3;
    --ygx-bar-dim:  #97a0b2;
    --ygx-bar-acc:  #3fbb85;
    --ygx-bar-on:   #06120c;
    --ygx-drop:     rgba(0,0,0,.5);
    /* Sidebar and sub-category row */
    --ygx-bar-strong:     #ffffff;
    --ygx-bar-active:     #e9ecf3;
    --ygx-bar-head:       #dfe4ee;
    --ygx-bar-item:       #b9c1d0;
    --ygx-bar-link:       #c3cad8;
    --ygx-bar-sub:        #8e97a8;
    --ygx-bar-hover:      #232833;
    --ygx-bar-hover-line: #3a4152;
    --ygx-bar-thumb:      #39404f;
    --ygx-bar-off:        #5b6474;
    /* The accent as text is a darker green than the accent as a surface once
       the theme flips, so the two are separate tokens. */
    --ygx-bar-acc-text:   #3fbb85;
    --ygx-bar-acc-wash:   rgba(63,187,133,.14);
    /* Control panel */
    --ygx-panel-bg:         rgba(20,23,30,.96);
    --ygx-panel-line:       #2c313d;
    --ygx-panel-head-line:  #262b36;
    --ygx-panel-btn:        #232833;
    --ygx-panel-btn-hover:  #2b313e;
    --ygx-panel-icon-hover: #262b36;
    --ygx-panel-note:       #6b7488;
    --ygx-panel-off:        #5c6577;
    --ygx-panel-shadow:     rgba(0,0,0,.55);
  }

  html[data-ygx-on] { background: var(--ygx-page) !important; }
  html[data-ygx-on] body { background: transparent !important; }

  /* Yupoo's own site bar, above the shop's. Its logo is a white PNG, so light
     mode inverts the logo rather than darkening the bar to keep it legible. */
  [data-ygx-on] .header__wrap {
    background: var(--ygx-bar) !important;
    border-bottom: 1px solid var(--ygx-bar-line) !important;
  }
  [data-ygx-on] .header__wrap,
  [data-ygx-on] .header__login,
  [data-ygx-on] .header__separator,
  [data-ygx-on] .header__wrap a,
  [data-ygx-on] .header__wrap i,
  [data-ygx-on] .language__currentlang { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .header__wrap a:hover { color: var(--ygx-bar-text) !important; }
  /* Language menu, which opens over the bar. */
  [data-ygx-on] .header__wrap .language__link ul {
    background: var(--ygx-bar) !important;
    border: 1px solid var(--ygx-bar-line) !important;
  }
  [data-ygx-on] .header__wrap .language__link ul a { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .header__wrap .language__link ul a:hover { color: var(--ygx-bar-acc) !important; }

  /* Shop header: nickname, search, menu tabs. */
  [data-ygx-on] .showheader__headerWrap {
    background: var(--ygx-bar-alt) !important;
    border-bottom: 1px solid var(--ygx-bar-line) !important;
  }
  [data-ygx-on] .showheader__nickname { color: var(--ygx-bar-text) !important; }
  [data-ygx-on] .showheader__menuslink,
  [data-ygx-on] .showheader__custommenu,
  [data-ygx-on] .showheader__qrcodehandle { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .showheader__menuslink:hover,
  [data-ygx-on] .showheader__custommenu:hover { color: var(--ygx-bar-text) !important; }
  /* Yupoo marks the active tab with a floating green div, not a class on it. */
  [data-ygx-on] .showheader__tabflag { background: var(--ygx-bar-acc) !important; }

  /* The wrap owns the pill border and the button is its right cap, so only
     colours change here; the geometry is left exactly as Yupoo has it. */
  [data-ygx-on] .search__inputWrap {
    background: var(--ygx-bar) !important;
    border-color: var(--ygx-bar-line) !important;
  }
  [data-ygx-on] .search__input { color: var(--ygx-bar-text) !important; }
  [data-ygx-on] .search__input::placeholder { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .search__searchBtn {
    background: var(--ygx-bar-acc) !important;
    border-color: var(--ygx-bar-acc) !important;
    color: var(--ygx-bar-on) !important;
  }

  [data-ygx-on] .broadcastbar__wrap {
    background: var(--ygx-bar-alt) !important;
    border-bottom: 1px solid var(--ygx-bar-line) !important;
  }
  [data-ygx-on] .broadcastbar__wrap pre { color: var(--ygx-bar-dim) !important; }

  /* All-categories dropdown, which Yupoo fixes over the page. */
  [data-ygx-on] .showheader__category_new {
    background: var(--ygx-bar) !important;
    border: 1px solid var(--ygx-bar-line) !important;
    box-shadow: 0 12px 30px var(--ygx-drop) !important;
  }
  /* Swept, not named: the tree's text is #494949, so anything missed once the
     panel goes dark would be dark-on-dark. */
  [data-ygx-on] .showheader__category_new,
  [data-ygx-on] .showheader__category_new a,
  [data-ygx-on] .showheader__category_new p,
  [data-ygx-on] .showheader__category_new li,
  [data-ygx-on] .showheader__category_new span,
  [data-ygx-on] .showheader__category_new div { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .showheader__link:hover { color: var(--ygx-bar-acc) !important; }

  /* Every shop-authored page (contact, "how to order") shares .htmlwrap__main.
     Yupoo's half-transparent tint and dashed green border wash out when dark.
     The album description carries the same class, so it is excluded here: the
     box treatment plus Yupoo's min-height:63px turned one line into a slab. */
  [data-ygx-on] .htmlwrap__main:not(.showalbumheader__gallerysubtitle) {
    background: var(--ygx-bar) !important;
    border: 1px dashed var(--ygx-bar-line) !important;
    border-radius: 12px !important;
    color: var(--ygx-bar-dim) !important;
  }
  /* The body is shop-authored HTML, so sweep the text rather than name it. */
  [data-ygx-on] .htmlwrap__main p,
  [data-ygx-on] .htmlwrap__main li,
  [data-ygx-on] .htmlwrap__main span,
  [data-ygx-on] .htmlwrap__main div,
  [data-ygx-on] .htmlwrap__main td,
  [data-ygx-on] .htmlwrap__main pre { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .htmlwrap__main h1,
  [data-ygx-on] .htmlwrap__main h2,
  [data-ygx-on] .htmlwrap__main h3,
  [data-ygx-on] .htmlwrap__main h4,
  [data-ygx-on] .htmlwrap__main strong,
  [data-ygx-on] .htmlwrap__main b { color: var(--ygx-bar-text) !important; }
  [data-ygx-on] .htmlwrap__main a { color: var(--ygx-bar-acc) !important; }

  /* .pagination__button is the shared base for prev/next, numbers and confirm;
     .pagination__active is the current page. Arrows are font icons, so: colour. */
  [data-ygx-on] .pagination__button {
    background: var(--ygx-bar) !important;
    border-color: var(--ygx-bar-line) !important;
    color: var(--ygx-bar-dim) !important;
  }
  [data-ygx-on] .pagination__button:hover {
    border-color: var(--ygx-bar-acc) !important;
    color: var(--ygx-bar-text) !important;
  }
  [data-ygx-on] .pagination__button.pagination__active,
  [data-ygx-on] .pagination__button.pagination__active:hover {
    background: var(--ygx-bar-acc) !important;
    border-color: var(--ygx-bar-acc) !important;
    color: var(--ygx-bar-on) !important;
  }
  [data-ygx-on] .pagination__disabled,
  [data-ygx-on] .pagination__disabled:hover,
  [data-ygx-on] .pagination__disabled i {
    border-color: var(--ygx-bar-line) !important;
    color: var(--ygx-bar-off) !important;
  }
  [data-ygx-on] .pagination__jumpwrap,
  [data-ygx-on] .pagination__jumpwrap span { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .pagination__jumpwrap input {
    background: var(--ygx-bar) !important;
    border: 1px solid var(--ygx-bar-line) !important;
    color: var(--ygx-bar-text) !important;
  }

  [data-ygx-on] .userfooter__main {
    background: var(--ygx-bar) !important;
    border-top: 1px solid var(--ygx-bar-line) !important;
  }
  [data-ygx-on] .userfooter__copyright,
  [data-ygx-on] .userfooter__lang,
  [data-ygx-on] .userfooter__lang * { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .userfooter__copyright a { color: var(--ygx-bar-text) !important; }

  /* Modals Yupoo pops over the page; white panels otherwise. */
  [data-ygx-on] .search__loginModal,
  [data-ygx-on] .passwordmodal__modal,
  [data-ygx-on] .alert__alert {
    background: var(--ygx-bar) !important;
    border: 1px solid var(--ygx-bar-line) !important;
    color: var(--ygx-bar-text) !important;
  }
  [data-ygx-on] .search__loginModal p,
  [data-ygx-on] .passwordmodal__modal p,
  [data-ygx-on] .alert__alert p { color: var(--ygx-bar-text) !important; }
  [data-ygx-on] .search__loginModal .button {
    background: var(--ygx-bar-alt) !important;
    border-color: var(--ygx-bar-line) !important;
    color: var(--ygx-bar-acc) !important;
  }

  /* Yupoo's dark icons, flipped to read on a dark surface. The white site logo
     is the reverse case, so it inverts in the light theme instead. */
  [data-ygx-on] .search__searchIcon,
  [data-ygx-on] .showheader__category_collapse,
  [data-ygx-on] .categories__box-right-pagination-button { filter: invert(1); }

  /* ---- /categories sidebar (tree shape is in CLAUDE.md) ---------------- */
  [data-ygx-on] .categories__box-left {
    background: var(--ygx-bar) !important;
    border: 1px solid var(--ygx-bar-line) !important;
    border-radius: 14px !important;
    padding: 6px !important;
    overflow: hidden auto !important;
    position: sticky !important;
    top: 10px;
    max-height: calc(100vh - 28px);
    scrollbar-width: thin;
    scrollbar-color: var(--ygx-bar-thumb) transparent;
    /* Reserve the track: without it a 1px hover height change toggles the
       scrollbar and reflows the column, which reads as every row jittering. */
    scrollbar-gutter: stable;
  }
  [data-ygx-on] .categories__box-left::-webkit-scrollbar { width: 8px; }
  [data-ygx-on] .categories__box-left::-webkit-scrollbar-thumb {
    background: var(--ygx-bar-thumb); border-radius: 99px; border: 2px solid var(--ygx-bar);
  }
  [data-ygx-on] .categories__box-left::-webkit-scrollbar-track { background: transparent; }

  [data-ygx-on] .categories__box-left .yupoo-collapse-item {
    background: transparent !important;
    border: 0 !important;
  }
  /* The header owns the row padding, so it owns the toggle hit area. Making the
     anchor display:block hands the row to the link, leaving nothing to expand. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-header,
  [data-ygx-on] .categories__box-left .yupoo-collapse-header:hover {
    box-sizing: border-box;
    background: transparent !important;
    /* Geometry is pinned identically across both states — only the colour
       differs — so nothing Yupoo's own :hover rules add can shift the row. */
    border: 0 !important;
    outline: 0 !important;
    margin: 0 !important;
    padding: 0 10px !important;
    /* Yupoo's line-height:48px strut beats the anchor's padding, leaving a 48px
       row with the label sitting high. Same defect the content items had. */
    line-height: 1.4 !important;
    height: auto !important;
    min-height: 0 !important;
    border-radius: 8px;
    cursor: pointer;
    transition: background .15s;
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-header:hover { background: var(--ygx-bar-hover) !important; }
  [data-ygx-on] .categories__box-left .yupoo-collapse-header > a {
    display: inline-block;
    max-width: 100%;
    padding: 8px 0 !important;
    /* Parents read as headings: larger, heavier, brighter than their children. */
    font-size: 13px !important;
    line-height: 1.4 !important;
    color: var(--ygx-bar-head) !important;
    text-decoration: none !important;
    vertical-align: middle;
    /* Pinned so a hover bolding from Yupoo's stylesheet can't change the
       text's measured width and shove the ellipsis around. */
    font-weight: 600 !important;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-header > a:hover { color: var(--ygx-bar-strong) !important; }

  [data-ygx-on] .categories__box-left .yupoo-collapse-item-selected > .yupoo-collapse-header {
    background: var(--ygx-bar-acc-wash) !important;
    box-shadow: inset 2px 0 0 var(--ygx-bar-acc);
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-item-selected > .yupoo-collapse-header > a {
    color: var(--ygx-bar-acc-text) !important; font-weight: 600 !important;
  }
  /* Children hang off a guide rail rather than relying on indent alone, so the
     nesting is legible at a glance instead of being inferred from padding. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-box {
    margin: 2px 0 6px 17px !important;
    padding: 0 0 0 10px !important;
    border-left: 1px solid var(--ygx-bar-line) !important;
  }

  [data-ygx-on] .categories__box-left .yupoo-collapse-content,
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-box {
    background: transparent !important; border: 0 !important;
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-item {
    display: block;
    padding: 6px 8px !important;
    margin: 1px 0;
    border-radius: 7px;
    font-size: 12px !important;
    /* Pinned: without it the row inherits Yupoo's line-height, which doesn't
       match the 6px padding and leaves the text sitting high in its box. */
    line-height: 1.5 !important;
    min-height: 0 !important;
    font-weight: 400 !important;
    color: var(--ygx-bar-sub) !important;
    text-decoration: none !important;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: background .15s, color .15s;
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-item:hover {
    background: var(--ygx-bar-hover) !important; color: var(--ygx-bar-active) !important;
  }
  /* The active child link carries .yupoo-collapse-content-item-selected. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-item-selected,
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-item-selected:hover {
    color: var(--ygx-bar-acc-text) !important;
    font-weight: 600 !important;
    background: var(--ygx-bar-acc-wash) !important;
    box-shadow: inset 2px 0 0 var(--ygx-bar-acc);
  }
  /* Parent of the open branch, so the trail to the current page reads. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-item-active > .yupoo-collapse-header > a {
    color: var(--ygx-bar-active) !important;
  }

  /* The chevron is a ::after at right:16px width:12px, so it reaches 28px in;
     20px left only 2px of clearance. .yupoo-collapse-item-single has none. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-item:not(.yupoo-collapse-item-single) > .yupoo-collapse-header > a {
    max-width: calc(100% - 28px);
  }

  /* ---- Sidebar collapse button ----------------------------------------- */

  /* An empty div positioned against .categories__box, so it lands over the first
     row. Its icon is a background image, so these colours are pre-inverted. */
  [data-ygx-on] .yupoo-categories-hide-sidebar,
  [data-ygx-on] .yupoo-categories-show-sidebar {
    width: 26px !important;
    height: 26px !important;
    background-size: 15px 15px !important;
    background-color: #e6e3db !important;
    border: 1px solid #d5d0c4 !important;
    border-radius: 7px !important;
    filter: invert(1);
    z-index: 2;
    transition: background-color .15s, border-color .15s;
  }
  [data-ygx-on] .yupoo-categories-hide-sidebar:hover,
  [data-ygx-on] .yupoo-categories-show-sidebar:hover {
    background-color: #dcd7cc !important; border-color: #c5bead !important;
  }
  /* Pull it into the row's text column: the card reserves a 10px scrollbar
     gutter, so left as Yupoo has it the button sits on top of the scrollbar. */
  [data-ygx-on] .yupoo-categories-hide-sidebar { transform: translate(-24px, -1px); }

  /* The button sits over the first row, so that row alone reserves its width.
     Declared after the chevron rule so it wins the 28px reservation. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-item:first-child > .yupoo-collapse-header > a {
    max-width: calc(100% - 32px);
  }

  /* ---- Sub-category row above the grid (shape in CLAUDE.md) ------------- */
  [data-ygx-on] .categories__box-right-categories {
    gap: 8px !important;
    /* Left edge lines up with the first card; the right reserves the More button. */
    padding: 0 72px 0 24px !important;
    margin: 0 0 12px !important;
  }
  /* Yupoo pins every wrapper to 179px, so a short label reserves as much room as
     the longest one. Let the pills hug their text instead. */
  [data-ygx-on] .categories__box-right-category-item-trick-wrap {
    width: auto !important;
    margin: 0 !important;
  }
  [data-ygx-on] .categories__box-right-category-item {
    display: inline-block;
    padding: 5px 12px !important;
    border-radius: 999px;
    background: var(--ygx-bar);
    border: 1px solid var(--ygx-bar-line);
    font-size: 12.5px !important;
    line-height: 1.44 !important;
    color: var(--ygx-bar-item) !important;
    text-decoration: none !important;
    transition: background .15s, border-color .15s, color .15s;
  }
  [data-ygx-on] .categories__box-right-category-item:hover {
    background: var(--ygx-bar-hover);
    border-color: var(--ygx-bar-hover-line);
    color: var(--ygx-bar-strong) !important;
  }
  [data-ygx-on] .categories__box-right-category-item.ygx-here {
    background: var(--ygx-bar-acc); border-color: var(--ygx-bar-acc);
    color: var(--ygx-bar-on) !important; font-weight: 600;
  }
  /* Two pill rows of 30px plus one 8px gap, replacing Yupoo's 94px cut. */
  [data-ygx-on] .categories__box-right-categories-wrap.is-fold .categories__box-right-categories {
    max-height: 68px !important;
  }
  [data-ygx-on] .categories__box-right-categories-toggle {
    top: 6px !important; right: 24px !important;
    font-size: 12px !important; color: var(--ygx-bar-dim) !important; cursor: pointer;
  }
  [data-ygx-on] .categories__box-right-categories-toggle:hover { color: var(--ygx-bar-acc-text) !important; }

  /* Header row above the grid: total count + pagination */
  [data-ygx-on] .categories__box-right-total,
  [data-ygx-on] .categories__box-right-pagination-span {
    color: var(--ygx-bar-sub) !important; font-size: 12.5px !important;
  }
  [data-ygx-on] .categories__box-right-pagination a { color: var(--ygx-bar-link) !important; }
  [data-ygx-on] .categories__box-right-pagination a:hover { color: var(--ygx-bar-acc-text) !important; }

  /* ---- Album detail page, /albums/<id> (shape in CLAUDE.md) ------------- */

  /* The header is one panel. flow-root rather than block because the cover is a
     float no ancestor contains, and a panel it can hang out of looks broken. */
  [data-ygx-on] .showalbumheader__main {
    display: flow-root !important;
    background: var(--ygx-bar) !important;
    border: 1px solid var(--ygx-bar-line) !important;
    border-radius: 14px !important;
    padding: 14px 16px 16px !important;
    margin-bottom: 4px !important;
  }
  /* Breadcrumb reads as the panel's header row. */
  [data-ygx-on] .showalbumheader__header {
    margin-bottom: 12px !important;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--ygx-bar-line);
    font-size: 12px;
  }
  [data-ygx-on] .yupoo-crumbs-span { color: var(--ygx-bar-sub) !important; }
  [data-ygx-on] .yupoo-crumbs-span.is-link:hover { color: var(--ygx-bar-acc-text) !important; }

  /* Yupoo's 1px #cfcfcf frame and the white 5px inner border both go. */
  [data-ygx-on] .showalbumheader__gallerycover,
  [data-ygx-on] .showalbumheader__space {
    border: 0 !important;
    border-radius: 12px;
    overflow: hidden;
    background: var(--ygx-bar-alt);
  }

  /* The count sits in the h1 next to the title, separated by an <i> that draws
     itself from currentColor, so dimming the h1 dims the rule too. */
  [data-ygx-on] .showalbumheader__gallerydec h1 { color: var(--ygx-bar-dim) !important; }
  [data-ygx-on] .showalbumheader__gallerytitle { color: var(--ygx-bar-text) !important; }

  /* A quiet rail instead of a box: the description is usually one or two lines,
     and min-height reserved 63px for them. */
  [data-ygx-on] .showalbumheader__gallerysubtitle {
    min-height: 0 !important;
    margin: 2px 0 12px !important;
    padding-left: 10px;
    border-left: 2px solid var(--ygx-bar-line);
    color: var(--ygx-bar-dim) !important;
  }
  [data-ygx-on] .showalbumheader__gallerysubtitle a { color: var(--ygx-bar-acc-text) !important; }

  /* Batch copy / batch download / share. */
  [data-ygx-on] .showalbumheader__tabgroup .button {
    background: var(--ygx-bar-hover) !important;
    border: 1px solid var(--ygx-bar-line) !important;
    color: var(--ygx-bar-item) !important;
    transition: border-color .15s, color .15s;
  }
  [data-ygx-on] .showalbumheader__tabgroup .button:hover {
    border-color: var(--ygx-bar-hover-line) !important;
    color: var(--ygx-bar-strong) !important;
  }

  /* Thumbnail / Detail / Big. Yupoo ships these #fff on #9f9f9f, which is the
     white block that survived on the dark page. */
  [data-ygx-on] .showalbumheader__btn-group .showalbumheader__button {
    background: var(--ygx-bar-hover) !important;
    border-color: var(--ygx-bar-line) !important;
    color: var(--ygx-bar-dim) !important;
  }
  [data-ygx-on] .showalbumheader__btn-group .showalbumheader__button:hover {
    color: var(--ygx-bar-strong) !important;
  }
  [data-ygx-on] .showalbumheader__btn-group .showalbumheader__button.showalbumheader__active {
    background: var(--ygx-bar-acc) !important;
    border-color: var(--ygx-bar-acc) !important;
    color: var(--ygx-bar-on) !important;
  }

  [data-ygx-on] .socialshare__shareModal {
    background: var(--ygx-bar) !important;
    border-color: var(--ygx-bar-line) !important;
    color: var(--ygx-bar-text) !important;
  }
  [data-ygx-on] .socialshare__shareModal h4,
  [data-ygx-on] .socialshare__shareModal h5 { color: var(--ygx-bar-text) !important; }

  /* Photo tiles take the .ygx-card treatment. border-box is load-bearing:
     Yupoo sizes them with calc(), so a content-box border wraps the row. */
  [data-ygx-on] .showalbum__children.image__main {
    box-sizing: border-box;
    background: var(--ygx-bar);
    border: 1px solid var(--ygx-bar-line);
    border-radius: 14px;
    overflow: hidden;
    transition: transform .22s cubic-bezier(.2,.7,.3,1), border-color .22s, box-shadow .22s;
  }
  [data-ygx-on] .showalbum__children.image__main:hover {
    border-color: var(--ygx-bar-hover-line);
    transform: translateY(-3px);
    box-shadow: 0 14px 34px var(--ygx-drop);
  }
  [data-ygx-on] .image__imagewrap { background: var(--ygx-bar-alt); }
  /* Yupoo's own hover frame is a ::after at #49bc85; retinted, not removed. */
  [data-ygx-on] .image__imagewrap:hover:after { border-color: var(--ygx-bar-acc) !important; }
  /* Upload filenames, meaningless to a shopper. Yupoo already hides them in
     Thumbnail view; this extends that to Detail and Big. */
  [data-ygx-on] .image__decwrap { display: none !important; }

  :root { --ygx-min: 260px; }

  .ygx-root {
    --ygx-card:    #191c24;
    --ygx-card-hi: #212530;
    --ygx-line:    #2a2f3b;
    --ygx-line-hi: #3a4152;
    --ygx-text:    #e9ecf3;
    --ygx-muted:   #97a0b2;
    /* The accent as text sits on a wash; as a surface it carries text. They
       diverge in light, so the badge does not read the text green. */
    --ygx-accent:      #3fbb85;
    --ygx-accent-bg:   #3fbb85;
    --ygx-on-accent:   #06120c;
    --ygx-accent-wash: rgba(63,187,133,.08);
    --ygx-shot:        #0b0d12;
    --ygx-badge:       rgba(10,12,18,.72);
    --ygx-badge-text:  #dfe4ee;
    --ygx-shadow:      0 14px 34px rgba(0,0,0,.45);
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
    border-color: var(--ygx-line-hi);
    transform: translateY(-3px);
    box-shadow: var(--ygx-shadow);
  }

  .ygx-media { position: relative; overflow: hidden; background: var(--ygx-shot); flex: 0 0 auto; }
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
    color: var(--ygx-badge-text); background: var(--ygx-badge); z-index: 3;
  }
  .ygx-price-float {
    position: absolute; left: 8px; top: 8px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: .2px;
    color: var(--ygx-on-accent); background: var(--ygx-accent-bg);
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

  /* Fixed quarter-width slots: at width:100% a 1- or 2-photo album stretched
     them full width and they read as a second giant image under the cover. */
  .ygx-strip { display: flex; gap: 4px; padding: 0 12px 12px; }
  .ygx-thumb {
    flex: 0 0 calc(25% - 3px); max-width: calc(25% - 3px);
    aspect-ratio: 1/1; object-fit: cover;
    border-radius: 5px; background: var(--ygx-shot); opacity: .78; transition: opacity .2s;
  }
  .ygx-card:hover .ygx-thumb { opacity: 1; }

  /* ---- Empty album: in the media area, so Dense and Masonry keep it ----- */
  .ygx-empty-box {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 6px; color: var(--ygx-muted);
  }
  .ygx-empty-icon { display: block; width: 26px; height: 26px; opacity: .75; }
  .ygx-empty-icon svg { display: block; width: 100%; height: 100%; }
  .ygx-empty-label { font-size: 11px; line-height: 1; }

  /* ---- "More" tile ----------------------------------------------------- */
  .ygx-card.is-more { background: transparent; border-color: var(--ygx-accent); }
  .ygx-card.is-more:hover {
    background: var(--ygx-accent-wash);
    border-color: var(--ygx-accent);
    box-shadow: none;
  }
  .ygx-card.is-more .ygx-media { background: transparent; }
  .ygx-more-box {
    position: absolute; inset: 0; padding: 10px; text-align: center;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; color: var(--ygx-accent);
  }
  .ygx-more-arrow { font-size: 22px; line-height: 1; }
  /* Yupoo's label is lowercase "more"; cased here so the text stays verbatim. */
  .ygx-more-label { font-size: 14px; font-weight: 700; text-transform: capitalize; }
  .ygx-more-note { font-size: 12px; color: var(--ygx-muted); }

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
  /* column-width is the multi-column form of minmax(var(--ygx-min), 1fr), so
     Masonry answers to the density slider exactly like the grid designs. Fixed
     column-count breakpoints used to override the slider below 1500px. */
  .ygx-grid[data-design="masonry"] {
    display: block; column-width: var(--ygx-min); column-count: auto; column-gap: 16px;
  }
  .ygx-grid[data-design="masonry"] .ygx-card {
    break-inside: avoid; display: inline-block; width: 100%; margin: 0 0 16px; border-radius: 12px;
  }
  .ygx-grid[data-design="masonry"] .ygx-media { aspect-ratio: auto; }
  .ygx-grid[data-design="masonry"] .ygx-img { height: auto; min-height: 90px; }
  /* Masonry sizes from the image; neither card has one, so pin a ratio. */
  .ygx-grid[data-design="masonry"] .ygx-card.is-more .ygx-media,
  .ygx-grid[data-design="masonry"] .ygx-card.is-empty .ygx-media { aspect-ratio: 3/4; }
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

  /* ---- Endless scroll -------------------------------------------------- */
  [data-ygx-endless] nav.pagination__main,
  [data-ygx-endless] .categories__box-right-pagination { display: none !important; }

  .ygx-endless {
    min-height: 40px; padding: 4px 24px 30px;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .ygx-endless-text { font-size: 12px; color: var(--ygx-bar-dim); letter-spacing: .2px; }
  .ygx-endless.is-paused { cursor: pointer; }
  .ygx-endless.is-paused .ygx-endless-text { color: var(--ygx-bar-acc-text); }

  /* ---- Control panel --------------------------------------------------- */
  .ygx-panel {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
    width: 246px; border-radius: 14px; overflow: hidden;
    background: var(--ygx-panel-bg); border: 1px solid var(--ygx-panel-line);
    box-shadow: 0 18px 44px var(--ygx-panel-shadow); color: var(--ygx-bar-text);
    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .ygx-panel * { box-sizing: border-box; }
  /* Dimmed by class, so the value lives here and the theme buttons dim too. */
  .ygx-panel.is-disabled .ygx-designs,
  .ygx-panel.is-disabled .ygx-themes,
  .ygx-panel.is-disabled .ygx-row { opacity: .4; pointer-events: none; }

  /* Host-page armour: "all: unset" resets only the base state, so a Yupoo
     button:hover rule still shifts our geometry. Pinned across every state. */
  .ygx-panel button,
  .ygx-panel button:hover,
  .ygx-panel button:focus,
  .ygx-panel button:active,
  .ygx-panel button:focus-visible {
    box-sizing: border-box !important;
    margin: 0 !important;
    border: 0 !important;
    outline: 0 !important;
    box-shadow: none !important;
    transform: none !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    line-height: 1.4 !important;
    letter-spacing: normal !important;
    text-transform: none !important;
    text-decoration: none !important;
    white-space: nowrap !important;
    vertical-align: middle !important;
    font-family: inherit !important;
    float: none !important;
    position: static !important;
  }
  .ygx-panel .ygx-design-btn,
  .ygx-panel .ygx-design-btn:hover,
  .ygx-panel .ygx-theme-btn,
  .ygx-panel .ygx-theme-btn:hover { padding: 7px 6px !important; font-weight: 600 !important; }
  .ygx-panel .ygx-toggle,
  .ygx-panel .ygx-toggle:hover { padding: 7px !important; font-weight: 600 !important; }
  .ygx-panel .ygx-icon-btn,
  .ygx-panel .ygx-icon-btn:hover { padding: 0 !important; width: 22px !important; height: 22px !important; }
  .ygx-panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 10px 9px 12px; border-bottom: 1px solid var(--ygx-panel-head-line);
  }
  .ygx-panel-title { font-weight: 700; letter-spacing: .3px; font-size: 12px; }
  .ygx-icon-btn {
    all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px;
    display: grid; place-items: center; color: #97a0b2; font-size: 15px;
  }
  .ygx-icon-btn:hover { background: var(--ygx-panel-icon-hover); color: var(--ygx-bar-strong); }
  .ygx-panel.is-collapsed .ygx-panel-body { display: none; }
  .ygx-panel-body { padding: 11px 12px 13px; display: flex; flex-direction: column; gap: 10px; }
  .ygx-designs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .ygx-design-btn {
    all: unset; cursor: pointer; text-align: center; padding: 7px 6px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600;
    background: var(--ygx-panel-btn); color: var(--ygx-bar-item);
    transition: background .15s, color .15s;
  }
  .ygx-design-btn:hover { background: var(--ygx-panel-btn-hover); color: var(--ygx-bar-strong); }
  .ygx-design-btn.is-active { background: var(--ygx-bar-acc); color: var(--ygx-bar-on); }
  .ygx-designs .ygx-design-btn:nth-child(5) { grid-column: 1 / -1; }

  .ygx-themes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .ygx-theme-btn {
    all: unset; cursor: pointer; text-align: center; padding: 6px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600;
    background: var(--ygx-panel-btn); color: var(--ygx-bar-item);
    transition: background .15s, color .15s;
  }
  .ygx-theme-btn:hover { background: var(--ygx-panel-btn-hover); color: var(--ygx-bar-strong); }
  .ygx-theme-btn.is-active { background: var(--ygx-bar-acc); color: var(--ygx-bar-on); }
  .ygx-row { display: flex; align-items: center; gap: 9px; }
  .ygx-check { cursor: pointer; }
  .ygx-check input { accent-color: var(--ygx-bar-acc); margin: 0; }
  .ygx-row-label { color: var(--ygx-bar-dim); font-size: 11px; white-space: nowrap; }
  /* Shelved setting: visible so it is not forgotten, but not operable. */
  .ygx-row.ygx-shelved { cursor: not-allowed; }
  .ygx-row.ygx-shelved .ygx-row-label { color: var(--ygx-panel-off); }
  .ygx-note {
    margin-left: auto; font-size: 10px; letter-spacing: .3px; color: var(--ygx-panel-note);
    border: 1px solid var(--ygx-panel-line); border-radius: 5px; padding: 1px 5px;
  }
  .ygx-range { flex: 1; accent-color: var(--ygx-bar-acc); }
  .ygx-toggle {
    all: unset; cursor: pointer; text-align: center; padding: 7px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600;
    background: var(--ygx-panel-btn); color: #97a0b2;
    border: 1px solid var(--ygx-panel-line);
  }
  .ygx-toggle:hover { background: var(--ygx-panel-btn-hover); color: var(--ygx-bar-strong); }
  .ygx-toggle.is-off { background: var(--ygx-bar-acc); color: var(--ygx-bar-on); border-color: transparent; }

  /* ---- Light theme (default): two token blocks and five exceptions ------ */

  /* Surfaces only. Scrim overlays keep white-on-gradient in both themes,
     because that text sits on the photograph rather than on the card. */

  /* Flipping these re-themes the whole chrome. What is left below is only what
     a token cannot express: a baked-in PNG, or a pre-inverted background image.
     Qualified with :root so it outranks dark on specificity, not source order. */
  :root[data-ygx-theme="light"] {
    --ygx-page:     #f6f7f9;
    --ygx-bar:      #ffffff;
    --ygx-bar-alt:  #fbfbfc;
    --ygx-bar-line: #e4e7ec;
    --ygx-bar-text: #1c2024;
    --ygx-bar-dim:  #667085;
    --ygx-bar-acc:  #16a06a;
    --ygx-bar-on:   #ffffff;
    --ygx-drop:     rgba(16,24,40,.14);
    --ygx-bar-strong:     #101828;
    --ygx-bar-active:     #101828;
    --ygx-bar-head:       #475467;
    --ygx-bar-item:       #475467;
    --ygx-bar-link:       #475467;
    --ygx-bar-sub:        #667085;
    --ygx-bar-hover:      #f4f6f8;
    --ygx-bar-hover-line: #cfd4dc;
    --ygx-bar-thumb:      #cfd4dc;
    --ygx-bar-off:        #b8c0cd;
    --ygx-bar-acc-text:   #0f8f5f;
    --ygx-bar-acc-wash:   rgba(22,160,106,.10);
    --ygx-panel-bg:         rgba(255,255,255,.97);
    --ygx-panel-line:       #e4e7ec;
    --ygx-panel-head-line:  #eaecf0;
    --ygx-panel-btn:        #f2f4f7;
    --ygx-panel-btn-hover:  #e9ecf1;
    --ygx-panel-icon-hover: #f2f4f7;
    --ygx-panel-note:       #98a2b3;
    --ygx-panel-off:        #98a2b3;
    --ygx-panel-shadow:     rgba(16,24,40,.18);
  }
  /* A white logo on a white bar, so it has to flip here and only here. */
  [data-ygx-theme="light"][data-ygx-on] .header__logo img { filter: invert(1); }
  /* Yupoo's own icons are already dark, so the dark theme's flip comes off. */
  [data-ygx-theme="light"][data-ygx-on] .search__searchIcon,
  [data-ygx-theme="light"][data-ygx-on] .showheader__category_collapse,
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-pagination-button { filter: none; }

  [data-ygx-theme="light"] .ygx-root {
    --ygx-card:    #ffffff;
    --ygx-card-hi: #ffffff;
    --ygx-line:    #e4e7ec;
    --ygx-line-hi: #cfd4dc;
    --ygx-text:    #1c2024;
    --ygx-muted:   #667085;
    --ygx-accent:      #0f8f5f;
    --ygx-accent-bg:   #16a06a;
    --ygx-on-accent:   #ffffff;
    --ygx-accent-wash: rgba(22,160,106,.07);
    --ygx-shot:        #f2f4f7;
    --ygx-badge:       rgba(255,255,255,.92);
    --ygx-badge-text:  #344054;
    --ygx-shadow:      0 12px 28px rgba(16,24,40,.14);
  }

  /* The sidebar toggle's icon is a background image, so its colours are
     pre-inverted in the dark rules and cannot be read from a token. */
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-hide-sidebar,
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-show-sidebar {
    filter: none; background-color: #fff !important; border-color: #e4e7ec !important;
  }
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-hide-sidebar:hover,
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-show-sidebar:hover {
    background-color: #f4f6f8 !important; border-color: #cfd4dc !important;
  }

  /* The only panel colour that is not a token: its dim is a step darker than
     --ygx-bar-dim, which the rest of the light chrome uses. */
  [data-ygx-theme="light"] .ygx-toggle { color: #475467; }

  /* ---- Motion ----------------------------------------------------------- */

  @media (prefers-reduced-motion: reduce) {
    .ygx-root *, .ygx-panel * { transition: none !important; animation: none !important; }
    .ygx-card:hover { transform: none; }
    .ygx-card:hover .ygx-img { transform: none; }
  }
  `;

  let cssDone = false;
  function injectCSS() {
    if (cssDone) return;
    cssDone = true;
    try { if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; } } catch { /* noop */ }
    const s = document.createElement('style');
    s.id = 'ygx-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---- 6. Boot --------------------------------------------------------- */

  // Trailing edge with a ceiling: a page that mutates faster than `ms` would
  // otherwise defer the call indefinitely.
  function debounce(fn, ms, maxWait) {
    let t = 0;
    let first = 0;
    return function (...args) {
      const run = () => { t = 0; first = 0; fn.apply(this, args); };
      const now = Date.now();
      if (!first) first = now;
      clearTimeout(t);
      if (maxWait && now - first >= maxWait) { run(); return; }
      t = setTimeout(run, ms);
    };
  }

  // The observer is what picks up a late-arriving grid, so it is installed
  // unconditionally rather than behind a card check that may never pass.
  function observeDom() {
    const reflow = debounce(() => { render(false); syncSubcats(); }, 250, 1500);
    new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target;
        if (t && t.closest && (t.closest('.ygx-root') || t.closest('.ygx-panel'))) continue;
        if (m.addedNodes.length || m.removedNodes.length) { reflow(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Capture on document, not window: Yupoo scrolls <body> as an overflow
    // container, and scroll does not bubble, so a window listener never fires.
    document.addEventListener('scroll', () => { endless.armed = true; },
      { passive: true, capture: true });

    // Measured, not styled, so the sub-category fold has to be re-measured on
    // any width change or the More toggle keeps its boot-time visibility.
    window.addEventListener('resize', debounce(syncSubcats, 150, 600));

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      // Torn down now rather than after the settle delay, so the old page's
      // cards never sit over the new one.
      teardown();
      lastSignature = '';
      resetEndless();
      setTimeout(() => { render(true); syncSubcats(); startEndless(); }, 400);
    }, 700);
  }

  // Runs whole on every page, cards or not. Behind a card check, gridless pages
  // got no stylesheet at all and stayed white in dark mode.
  function boot() {
    injectCSS();
    applyTheme();
    applyEnabledAttr();
    applyEndlessAttr();
    applyWiden();
    applyDensity();
    buildPanel();
    observeDom();
    render(true);
    syncSubcats();
    startEndless();
  }

  boot();
})();
