// ==UserScript==
// @name         Yupoo Gallery UI+
// @namespace    yupoo-gallery-ui-plus
// @version      2.6.3
// @description  Rebuilds Yupoo album grids with 5 switchable card designs. Section-aware, dark theme, price badge, lazy loading, density control, endless scroll.
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

  const DEFAULTS = { design: 'editorial', density: 1, enabled: true, widen: true, theme: 'light', endless: false };

  // Endless scroll is shelved, not removed: it fetches, appends and dedupes
  // correctly, but crashes long sessions for reasons not yet pinned down. Set
  // this to true to pick it back up; nothing else needs changing.
  const ENDLESS_READY = false;
  const THEMES = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

  /* =========================================================================
   * 1. Storage (GM_* with localStorage fallback)
   * ====================================================================== */

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
    // Forced off while shelved, so a previously saved true does not revive it.
    endless: ENDLESS_READY && store.get('endless', DEFAULTS.endless) === true
  };
  if (!DESIGNS.some(d => d.id === state.design)) state.design = DEFAULTS.design;
  if (!THEMES.some(t => t.id === state.theme)) state.theme = DEFAULTS.theme;

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
   * A grid's last child may instead be a "more" tile linking to the collection:
   *
   *         div.showindex__children
   *           a.album3__main[title="more"][href="/collections/<id>"]
   *             div.album3__showmore > p.album3__more + p  <- "more", "39 items"
   *
   * The /categories/<id> listing is flatter: one div.categories__parent holding
   * every div.categories__children, where the title is a sibling of the anchor
   * rather than a descendant.
   *
   * Older templates use album__main / album__title; both are handled, and
   * there's a generic fallback for anything else.
   * ====================================================================== */

  const CARD_SEL = 'a.album3__main, a.album__main, a[data-album-id], a[href*="/albums/"]';
  const ALBUM_HREF = /\/albums\/(\d+)/;
  const COLLECTION_HREF = /\/collections\/(\d+)/;
  const CATEGORY_HREF = /\/categories\/(\d+)/;
  // Yupoo's own "not loaded yet" graphics, which must never be cached as a cover.
  const BAD_IMG = /(blank|placeholder|loading|spacer|1x1|nopic|no_pic|default_|\.svg($|\?)|^data:)/i;
  // A usable photo is one served by Yupoo's CDN, or at least a real raster file.
  const GOOD_IMG = /(photo\.yupoo\.com|\.(jpe?g|png|webp|gif)($|\?))/i;
  // Yupoo's "no photos" graphic: a real .png on a real CDN, so GOOD_IMG accepts
  // it and BAD_IMG misses it. Without this it gets cached as a cover.
  const PLACEHOLDER_IMG = /im_photo_album/i;

  // Lazy-load attributes first: `src` is often a 1x1 data: URI, and Yupoo's
  // /square variant only ever appears there.
  const IMG_ATTRS = ['data-origin-src', 'data-original', 'data-src', 'data-lazy', 'src'];

  function isRealPhoto(u) {
    return !!u && !BAD_IMG.test(u) && !PLACEHOLDER_IMG.test(u) && GOOD_IMG.test(u);
  }

  // Flagged rather than dropped: the card still has a title and price. The zero
  // count stops a real cover that matches the filename reading as empty.
  function isEmptyAlbum(card) {
    if (readCount(card) !== 0) return false;
    return Array.from(card.querySelectorAll('img')).some(n =>
      IMG_ATTRS.some(attr => PLACEHOLDER_IMG.test(n.getAttribute(attr) || '')));
  }

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
    try { return { name: p.name, re: new RegExp(p.src) }; } catch { return null; }
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
    // .categories__children is the /categories listing; .showindex__children
    // is the album grid and the category_commerce home page.
    const known = anchor.closest('.showindex__children, .categories__children, li.album, .album__main');
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
      // Href plus marker node, so a plain collection link elsewhere on the page
      // isn't mistaken for a "more" tile.
      const showmore = COLLECTION_HREF.test(href) ? a.querySelector('.album3__showmore') : null;
      if (!showmore && !ALBUM_HREF.test(href)) continue;

      const card = cardRootFor(a);
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
        const images = readImages(card);
        // No images and no placeholder means the scrape missed, not an empty album.
        const empty = !images.length && isEmptyAlbum(card);
        if (!images.length && !empty) continue;

        const rawTitle = readTitle(card);
        const pm = parsePrice(rawTitle);
        const count = readCount(card);

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

  // Static markup, inlined so the card stays self-contained and takes currentColor.
  const EMPTY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4.5 3.5h15A1.5 1.5 0 0 1 21 5v14a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19V5a1.5 1.5 0 0 1 1.5-1.5z"/>' +
    '<path d="M3.4 16.6l4.3-4.3a2 2 0 0 1 2.8 0l3.6 3.6"/>' +
    '<circle cx="15.5" cy="8.5" r="1.4"/>' +
    '<path d="M3.4 3.4l17.2 17.2"/></svg>';

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
      const box = el('div', 'ygx-empty-box');
      const icon = el('span', 'ygx-empty-icon');
      icon.innerHTML = EMPTY_ICON;
      box.appendChild(icon);
      box.appendChild(el('span', 'ygx-empty-label', 'No photos'));
      media.appendChild(box);
    } else {
      img = el('img', 'ygx-img');
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
    }

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

    const sig = signature(groups);
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
    // Roots are inserted before their hidden grid, so a rebuild would otherwise
    // leave the sentinel stranded above the gallery and permanently in view.
    placeSentinel();
  }

  function signature(groups) {
    return state.design + '::' +
      groups.map(g => g.items.length + ':' + g.items.map(i => i.href).join(',')).join('|');
  }

  /* =========================================================================
   * 3b. Endless scroll
   *
   * All three paginated page types (/, /albums, /categories/<id>) serve plain
   * server-rendered HTML on this origin, and all expose the same next link. On
   * the last page that anchor carries no href, which is the stop signal.
   *
   * Fetched cards are grafted into the hidden original markup rather than into
   * our output, so scraping, dedupe and "Restore original layout" are unchanged.
   * ====================================================================== */

  const NEXT_SEL = 'nav.pagination__main a[title="next page"]';
  const GRID_SEL = '.showindex__parent, .categories__parent';

  // Hard ceiling per page view. Every other guard depends on an event firing;
  // this one does not, so runaway loading stays bounded whatever else breaks.
  const MAX_PAGES = 10;

  // url: null means "not looked up yet", '' means "no further pages".
  // armed is cleared on each load and set again by scrolling, so a sentinel that
  // stays in view cannot chain through every page unattended.
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
    // Anchor to the hidden grid, not the root: roots are inserted before their
    // grid, so anchoring to the root puts the sentinel in the slot the next
    // rebuild inserts into, hoisting it above the cards.
    let anchor = last;
    mounted.forEach((root, grid) => { if (root === last) anchor = grid; });
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

  // Appends only what the fetch added. A full render(true) per page rebuilt every
  // card and re-decoded every image, which is what froze the tab.
  function renderAppended() {
    const groups = scrapeGroups();
    if (!groups.length) return;
    for (const { grid, items } of groups) {
      const root = mounted.get(grid);
      if (!root) { lastSignature = ''; render(true); return; }
      const gridEl = root.firstElementChild;
      const have = gridEl.children.length;
      if (items.length <= have) continue;
      const frag = document.createDocumentFragment();
      items.slice(have).forEach(it => frag.appendChild(buildCard(it, state.design)));
      gridEl.appendChild(frag);
    }
    lastSignature = signature(groups);
    placeSentinel();
  }

  async function loadNextPage() {
    if (endless.busy || endless.paused || !endless.url || !state.endless || !state.enabled) return;
    endless.busy = true;
    endless.armed = false;
    endlessStatus('Loading more…');

    let doc;
    try {
      const res = await fetch(endless.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    } catch {
      endless.busy = false;
      endlessStatus('Could not load the next page. Scroll to retry.');
      return;
    }

    const live = Array.from(document.querySelectorAll(GRID_SEL)).filter(g => !g.closest('.ygx-root'));
    // One live grid is a flat list, so the next page continues it. Several means
    // sections, and the next page is a flat list that must not land under the
    // last heading, so every later page shares one container of its own.
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
    renderAppended();
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
    root.style.setProperty('--ygx-cols', String(Math.max(1, Math.round(6 / state.density))));
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

  /* ---- /categories sidebar --------------------------------------------
   * .categories__box-left > .yupoo-collapse-item
   *                           > .yupoo-collapse-header > a       (parent)
   *                           > .yupoo-collapse-content
   *                               > .yupoo-collapse-content-box
   *                                   > a.yupoo-collapse-content-item  (child)
   * -------------------------------------------------------------------- */
  [data-ygx-on] .categories__box-left {
    background: #191c24 !important;
    border: 1px solid #2a2f3b !important;
    border-radius: 14px !important;
    padding: 6px !important;
    overflow: hidden auto !important;
    position: sticky !important;
    top: 10px;
    max-height: calc(100vh - 28px);
    scrollbar-width: thin;
    scrollbar-color: #39404f transparent;
    /* Reserve the scrollbar track. Without this, a hover state that changes
       content height by a pixel makes the scrollbar appear/disappear and the
       entire column reflows — which looks like every row jittering at once. */
    scrollbar-gutter: stable;
  }
  [data-ygx-on] .categories__box-left::-webkit-scrollbar { width: 8px; }
  [data-ygx-on] .categories__box-left::-webkit-scrollbar-thumb {
    background: #39404f; border-radius: 99px; border: 2px solid #191c24;
  }
  [data-ygx-on] .categories__box-left::-webkit-scrollbar-track { background: transparent; }

  [data-ygx-on] .categories__box-left .yupoo-collapse-item {
    background: transparent !important;
    border: 0 !important;
  }
  /* Yupoo binds expand/collapse to .yupoo-collapse-header and lets the inline
     <a> handle navigation. So the header owns the row padding (and therefore
     the toggle hit area) and the anchor stays inline at text width — making
     the anchor display:block hands the whole row to the link and there's
     nothing left to click to expand. */
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
  [data-ygx-on] .categories__box-left .yupoo-collapse-header:hover { background: #232833 !important; }
  [data-ygx-on] .categories__box-left .yupoo-collapse-header > a {
    display: inline-block;
    max-width: 100%;
    padding: 8px 0 !important;
    /* Parents read as headings: larger, heavier, brighter than their children. */
    font-size: 13px !important;
    line-height: 1.4 !important;
    color: #dfe4ee !important;
    text-decoration: none !important;
    vertical-align: middle;
    /* Pinned so a hover bolding from Yupoo's stylesheet can't change the
       text's measured width and shove the ellipsis around. */
    font-weight: 600 !important;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-header > a:hover { color: #fff !important; }

  [data-ygx-on] .categories__box-left .yupoo-collapse-item-selected > .yupoo-collapse-header {
    background: rgba(63,187,133,.14) !important;
    box-shadow: inset 2px 0 0 #3fbb85;
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-item-selected > .yupoo-collapse-header > a {
    color: #3fbb85 !important; font-weight: 600 !important;
  }
  /* Children hang off a guide rail rather than relying on indent alone, so the
     nesting is legible at a glance instead of being inferred from padding. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-box {
    margin: 2px 0 6px 17px !important;
    padding: 0 0 0 10px !important;
    border-left: 1px solid #2a2f3b !important;
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
    color: #8e97a8 !important;
    text-decoration: none !important;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: background .15s, color .15s;
  }
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-item:hover {
    background: #232833 !important; color: #e9ecf3 !important;
  }
  /* The active child link carries .yupoo-collapse-content-item-selected. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-item-selected,
  [data-ygx-on] .categories__box-left .yupoo-collapse-content-item-selected:hover {
    color: #3fbb85 !important;
    font-weight: 600 !important;
    background: rgba(63,187,133,.12) !important;
    box-shadow: inset 2px 0 0 #3fbb85;
  }
  /* Parent of the open branch, so the trail to the current page reads. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-item-active > .yupoo-collapse-header > a {
    color: #e9ecf3 !important;
  }

  /* The chevron is a ::after at right:16px width:12px, so it reaches 28px in;
     20px left only 2px of clearance. .yupoo-collapse-item-single has none. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-item:not(.yupoo-collapse-item-single) > .yupoo-collapse-header > a {
    max-width: calc(100% - 28px);
  }

  /* ---- Sidebar collapse button ----------------------------------------
   * An empty 24px div positioned against .categories__box, not the sidebar, so
   * it lands on top of the first row 5px inside the sidebar's right edge. Fine
   * against Yupoo's flat grey block; against our rounded card it reads as debris.
   *
   * The icon is a background image, so the dark theme inverts the whole element
   * and the surface colours here are pre-inverted to compensate.
   * -------------------------------------------------------------------- */
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
  /* Pull it in to the row's text column. The card reserves a scrollbar gutter, so
     rows end ~10px short of its inner edge; left where Yupoo puts it, the button
     overhangs every row and sits on top of the scrollbar. */
  [data-ygx-on] .yupoo-categories-hide-sidebar { transform: translate(-24px, -1px); }

  /* The button sits over the first row, so that row alone reserves its width.
     Declared after the chevron rule so it wins the 28px reservation. */
  [data-ygx-on] .categories__box-left .yupoo-collapse-item:first-child > .yupoo-collapse-header > a {
    max-width: calc(100% - 32px);
  }

  /* ---- Sub-category row (above the grid) -------------------------------
   * .categories__box-right-categories-wrap.is-fold
   *   > .categories__box-right-categories
   *       > .categories__box-right-category-item-trick-wrap
   *           > a.categories__box-right-category-item
   *   > .categories__box-right-categories-toggle          "More" / "Less"
   * -------------------------------------------------------------------- */
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
    background: #191c24;
    border: 1px solid #2a2f3b;
    font-size: 12.5px !important;
    line-height: 1.44 !important;
    color: #b9c1d0 !important;
    text-decoration: none !important;
    transition: background .15s, border-color .15s, color .15s;
  }
  [data-ygx-on] .categories__box-right-category-item:hover {
    background: #232833; border-color: #3a4152; color: #fff !important;
  }
  [data-ygx-on] .categories__box-right-category-item.ygx-here {
    background: #3fbb85; border-color: #3fbb85; color: #07130d !important; font-weight: 600;
  }
  /* Two pill rows of 30px plus one 8px gap, replacing Yupoo's 94px cut. */
  [data-ygx-on] .categories__box-right-categories-wrap.is-fold .categories__box-right-categories {
    max-height: 68px !important;
  }
  [data-ygx-on] .categories__box-right-categories-toggle {
    top: 6px !important; right: 24px !important;
    font-size: 12px !important; color: #97a0b2 !important; cursor: pointer;
  }
  [data-ygx-on] .categories__box-right-categories-toggle:hover { color: #3fbb85 !important; }

  /* Header row above the grid: total count + pagination */
  [data-ygx-on] .categories__box-right-total,
  [data-ygx-on] .categories__box-right-pagination-span {
    color: #8e97a8 !important; font-size: 12.5px !important;
  }
  [data-ygx-on] .categories__box-right-pagination a { color: #c3cad8 !important; }
  [data-ygx-on] .categories__box-right-pagination a:hover { color: #3fbb85 !important; }

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

  /* ---- Empty album -----------------------------------------------------
   * Natural size, not stretched; in the media area so Dense/Masonry keep it.
   * -------------------------------------------------------------------- */
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
    background: rgba(63,187,133,.08);
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
  .ygx-endless-text { font-size: 12px; color: #97a0b2; letter-spacing: .2px; }
  .ygx-endless.is-paused { cursor: pointer; }
  .ygx-endless.is-paused .ygx-endless-text { color: #3fbb85; }
  [data-ygx-theme="light"] .ygx-endless.is-paused .ygx-endless-text { color: #0f8f5f; }

  /* ---- Control panel --------------------------------------------------- */
  .ygx-panel {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
    width: 246px; border-radius: 14px; overflow: hidden;
    background: rgba(20,23,30,.96); border: 1px solid #2c313d;
    box-shadow: 0 18px 44px rgba(0,0,0,.55); color: #e9ecf3;
    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .ygx-panel * { box-sizing: border-box; }

  /* Host-page armour.
   *
   * The panel is injected into Yupoo's document, which styles bare button
   * elements (.pagination__button, .showlayout__action button, .button...).
   * "all: unset" only resets the base state — a host rule such as
   *   button:hover { border: 1px solid; padding: 8px }
   * still wins over .ygx-design-btn:hover, which only declares colours, so
   * their geometry change applies on hover and the button shifts.
   *
   * Pinning every box-model property across all states makes that structurally
   * impossible, whatever their stylesheet turns out to say. */
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
  /* Shelved setting: visible so it is not forgotten, but not operable. */
  .ygx-row.ygx-shelved { cursor: not-allowed; }
  .ygx-row.ygx-shelved .ygx-row-label { color: #5c6577; }
  .ygx-note {
    margin-left: auto; font-size: 10px; letter-spacing: .3px; color: #6b7488;
    border: 1px solid #2c313d; border-radius: 5px; padding: 1px 5px;
  }
  .ygx-range { flex: 1; accent-color: #3fbb85; }
  .ygx-toggle {
    all: unset; cursor: pointer; text-align: center; padding: 7px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600; background: #232833; color: #97a0b2; border: 1px solid #2c313d;
  }
  .ygx-toggle:hover { background: #2b313e; color: #fff; }
  .ygx-toggle.is-off { background: #3fbb85; color: #07130d; border-color: transparent; }

  /* =======================================================================
   * LIGHT THEME (default) — overrides the dark values above.
   *
   * Only surfaces are re-themed. The scrim-backed overlays used by Dense,
   * Masonry and Showcase keep white text on a dark gradient in both themes,
   * because that text sits on the photograph, not on the card.
   * ==================================================================== */

  [data-ygx-theme="light"] .ygx-root {
    --ygx-card:    #ffffff;
    --ygx-card-hi: #ffffff;
    --ygx-line:    #e4e7ec;
    --ygx-text:    #1c2024;
    --ygx-muted:   #667085;
    --ygx-accent:  #0f8f5f;
  }
  [data-ygx-theme="light"] .ygx-media,
  [data-ygx-theme="light"] .ygx-thumb { background: #f2f4f7; }
  [data-ygx-theme="light"] .ygx-card:hover {
    border-color: #cfd4dc;
    box-shadow: 0 12px 28px rgba(16,24,40,.14);
  }
  [data-ygx-theme="light"] .ygx-count { background: rgba(255,255,255,.92); color: #344054; }
  [data-ygx-theme="light"] .ygx-price-float { background: #16a06a; color: #fff; }
  [data-ygx-theme="light"] .ygx-card.is-more:hover { background: rgba(22,160,106,.07); }

  /* Sidebar */
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left {
    background: #ffffff !important; border-color: #e4e7ec !important;
    scrollbar-color: #cfd4dc transparent;
  }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left::-webkit-scrollbar-thumb {
    background: #cfd4dc; border-color: #ffffff;
  }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-header:hover { background: #f4f6f8 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-header > a { color: #475467 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-header > a:hover { color: #101828 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-item-selected > .yupoo-collapse-header {
    background: rgba(22,160,106,.10) !important; box-shadow: inset 2px 0 0 #16a06a;
  }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-item-selected > .yupoo-collapse-header > a { color: #0f8f5f !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-item-active > .yupoo-collapse-header > a { color: #101828 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-content-box { border-left-color: #e4e7ec !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-content-item { color: #667085 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-content-item:hover {
    background: #f4f6f8 !important; color: #101828 !important;
  }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-content-item-selected,
  [data-ygx-theme="light"][data-ygx-on] .categories__box-left .yupoo-collapse-content-item-selected:hover {
    color: #0f8f5f !important;
    background: rgba(22,160,106,.10) !important;
    box-shadow: inset 2px 0 0 #16a06a;
  }
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-hide-sidebar,
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-show-sidebar {
    filter: none; background-color: #fff !important; border-color: #e4e7ec !important;
  }
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-hide-sidebar:hover,
  [data-ygx-theme="light"][data-ygx-on] .yupoo-categories-show-sidebar:hover {
    background-color: #f4f6f8 !important; border-color: #cfd4dc !important;
  }

  /* Sub-category pills */
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-category-item {
    background: #fff; border-color: #e4e7ec; color: #475467 !important;
  }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-category-item:hover {
    background: #f4f6f8; border-color: #cfd4dc; color: #101828 !important;
  }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-category-item.ygx-here {
    background: #16a06a; border-color: #16a06a; color: #fff !important;
  }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-categories-toggle { color: #667085 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-categories-toggle:hover { color: #0f8f5f !important; }

  [data-ygx-theme="light"] .ygx-endless-text { color: #667085; }

  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-total,
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-pagination-span { color: #667085 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-pagination a { color: #475467 !important; }
  [data-ygx-theme="light"][data-ygx-on] .categories__box-right-pagination a:hover { color: #0f8f5f !important; }

  /* Control panel */
  [data-ygx-theme="light"] .ygx-panel {
    background: rgba(255,255,255,.97); border-color: #e4e7ec; color: #1c2024;
    box-shadow: 0 18px 44px rgba(16,24,40,.18);
  }
  [data-ygx-theme="light"] .ygx-panel-head { border-bottom-color: #eaecf0; }
  [data-ygx-theme="light"] .ygx-icon-btn:hover { background: #f2f4f7; color: #101828; }
  [data-ygx-theme="light"] .ygx-design-btn { background: #f2f4f7; color: #475467; }
  [data-ygx-theme="light"] .ygx-design-btn:hover { background: #e9ecf1; color: #101828; }
  [data-ygx-theme="light"] .ygx-design-btn.is-active { background: #16a06a; color: #fff; }
  [data-ygx-theme="light"] .ygx-row-label { color: #667085; }
  [data-ygx-theme="light"] .ygx-row.ygx-shelved .ygx-row-label { color: #98a2b3; }
  [data-ygx-theme="light"] .ygx-note { color: #98a2b3; border-color: #e4e7ec; }
  [data-ygx-theme="light"] .ygx-range,
  [data-ygx-theme="light"] .ygx-check input { accent-color: #16a06a; }
  [data-ygx-theme="light"] .ygx-toggle { background: #f2f4f7; color: #475467; border-color: #e4e7ec; }
  [data-ygx-theme="light"] .ygx-toggle:hover { background: #e9ecf1; color: #101828; }
  [data-ygx-theme="light"] .ygx-toggle.is-off { background: #16a06a; color: #fff; border-color: transparent; }
  [data-ygx-theme="light"] .ygx-theme-btn { background: #f2f4f7; color: #475467; }
  [data-ygx-theme="light"] .ygx-theme-btn.is-active { background: #16a06a; color: #fff; }

  .ygx-themes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .ygx-theme-btn {
    all: unset; cursor: pointer; text-align: center; padding: 6px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600; background: #232833; color: #b9c1d0;
    transition: background .15s, color .15s;
  }
  .ygx-theme-btn.is-active { background: #3fbb85; color: #07130d; }
  `;

  function injectCSS() {
    try { if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; } } catch { /* noop */ }
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
    applyTheme();
    applyEnabledAttr();
    applyEndlessAttr();
    applyWiden();
    applyDensity();
    buildPanel();
    render(true);
    syncSubcats();
    startEndless();

    // Each page needs a scroll to re-arm, so a sentinel left in view after a
    // load cannot walk the whole catalogue on its own.
    //
    // Capture on document, not window: Yupoo scrolls <body> as an overflow
    // container rather than the viewport, and scroll events do not bubble from
    // an element, so a window listener never fires and endless scroll would stop
    // dead after one page.
    document.addEventListener('scroll', () => { endless.armed = true; },
      { passive: true, capture: true });

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
        resetEndless();
        setTimeout(() => { render(true); syncSubcats(); startEndless(); }, 400);
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
