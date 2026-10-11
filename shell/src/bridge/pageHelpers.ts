/**
 * JS helper source shared by every script evaluated in the page. Plain strings
 * so bundling never rewrites them. Read-only: nothing here synthesizes input.
 */
import { SENSITIVE_AUTOCOMPLETE_SOURCE, SENSITIVE_NAME_SOURCE } from './sensitive';

export const BINDING_NAME = '__ggReport';
export const ISOLATED_WORLD = 'gg-listener';
export const MAX_ELEMENTS = 60;

export const SHARED_HELPERS = String.raw`
  const NAME_RE = new RegExp(${JSON.stringify(SENSITIVE_NAME_SOURCE)}, 'i');
  const AC_RE = new RegExp(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_SOURCE)}, 'i');
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) parts.push(n.textContent); });
    if (el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(l.textContent); } catch (e) {} }
    const wrap = el.closest && el.closest('label');
    if (wrap) parts.push(wrap.textContent);
    return clean(parts.join(' '));
  };
  const isField = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || role === 'textbox' || el.isContentEditable;
  };
  const fieldSensitive = (el) => {
    if (!isField(el)) return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    if (AC_RE.test((el.getAttribute('autocomplete') || '').trim())) return true;
    const identity = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), labelOf(el)].filter(Boolean).join(' ');
    return NAME_RE.test(identity);
  };
  const formSensitive = (el) => {
    const form = el.closest && el.closest('form');
    if (!form) return false;
    if (form.__ggSens === undefined) {
      form.__ggSens = Array.from(form.querySelectorAll('input,textarea,select,[role=textbox],[contenteditable]')).some(fieldSensitive);
    }
    return form.__ggSens;
  };
  const isSearchField = (el) => {
    if (!isField(el) || fieldSensitive(el)) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (type === 'search' || role === 'searchbox') return true;
    if (role === 'combobox' && /search/i.test(el.getAttribute('aria-label') || '')) return true;
    const identity = ((el.getAttribute('name') || '') + ' ' + (el.id || '')).toLowerCase();
    if (/(^|[\s_-])(q|query|search|search_query)($|[\s_-])/.test(identity)) return true;
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').toLowerCase().trim();
    return /^search\b/.test(label);
  };
  const byGgId = (id) => document.querySelector('[data-gg-id="' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
`;

/** Fresh rect for one element: { found, rect, inViewport, sensitive, isSearch }. */
export function elementInfoScript(elementId: string): string {
  return `(() => {
    ${SHARED_HELPERS}
    const el = byGgId(${JSON.stringify(elementId)});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    return { found: true, rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      inViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
      sensitive: fieldSensitive(el) || formSensitive(el), isSearch: isSearchField(el) };
  })()`;
}

/**
 * Smoothly scroll one element to the middle of the viewport (works for nested
 * scroll containers too). Scrolling only reveals content: no click, no input.
 */
export function scrollIntoViewScript(elementId: string): string {
  return `(() => {
    ${SHARED_HELPERS}
    const el = byGgId(${JSON.stringify(elementId)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    return true;
  })()`;
}

/** Scroll the page (or its main scroll container) by dy CSS px; returns the new scroll position. */
export function scrollByScript(dy: number): string {
  return `(() => {
    const dy = ${Number(dy) || 0};
    const root = document.scrollingElement || document.documentElement;
    const before = root.scrollTop;
    root.scrollBy({ top: dy, behavior: 'smooth' });
    // Pages that scroll an inner container instead of the document.
    if (root.scrollHeight <= root.clientHeight + 2) {
      const box = Array.from(document.querySelectorAll('main, [role=main], div'))
        .find((n) => n.scrollHeight > n.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(n).overflowY));
      if (box) { box.scrollBy({ top: dy, behavior: 'smooth' }); return { before, container: true }; }
    }
    return { before, container: false };
  })()`;
}

export const SCROLL_Y_SCRIPT = `(() => (document.scrollingElement || document.documentElement).scrollTop)()`;

/**
 * Find the element whose visible label best matches `query`, searching the
 * WHOLE page (not just the 60-element snapshot, which cuts off links further
 * down). Tags the winner with a data-gg-id and returns { id, name, score } or
 * null. Read-only apart from that tag attribute.
 */
export function findByTextScript(query: string): string {
  return `(() => {
    ${SHARED_HELPERS}
    const SELECTOR = 'a[href],button,input[type=submit],input[type=button],summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],h1,h2,h3,h4,label,input:not([type=hidden]),select,textarea';
    const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9\\u0900-\\u097f ]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const STOP = new Set(['the','a','an','to','of','for','option','button','link','page','on','my','me','please','click','here']);
    const q = norm(${JSON.stringify(query)});
    const tokens = q.split(' ').filter((t) => t && !STOP.has(t));
    if (!tokens.length) return null;
    const stem = (t) => t.replace(/(ing|ion|s)$/,'');
    const nameOf = (el) => clean(labelOf(el) || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || (el.querySelector && el.querySelector('img[alt]') && el.querySelector('img[alt]').getAttribute('alt')) || '');
    let best = null;
    for (const el of document.querySelectorAll(SELECTOR)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      const name = nameOf(el).slice(0, 160);
      const n = norm(name);
      if (!n || n.length > 140) continue;
      const words = n.split(' ').map(stem);
      const hits = tokens.filter((t) => n.includes(t) || words.includes(stem(t))).length;
      if (!hits) continue;
      let score = (hits / tokens.length) * 60;
      if (n === q) score += 40; else if (n.includes(q)) score += 25;
      score -= Math.min(15, Math.max(0, words.length - tokens.length) * 1.5); // prefer short, specific labels
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' || tag === 'button' || /button|link|menuitem|tab/.test(el.getAttribute('role') || '')) score += 8;
      if (/^h[1-4]$/.test(tag) || tag === 'label') score -= 4;
      if (!best || score > best.score) best = { el, name, score };
    }
    if (!best || best.score < 35) return null;
    let id = best.el.getAttribute('data-gg-id');
    if (!id) { window.__ggSeq = (window.__ggSeq || 0) + 1; id = 'e' + window.__ggSeq; best.el.setAttribute('data-gg-id', id); }
    return { id, name: best.name, score: Math.round(best.score) };
  })()`;
}

/**
 * The visible element matching a recorded CSS selector (catalog routes). When
 * `expected` is given, the element's label must contain it (or be contained
 * in it), so a stale selector that now hits a different element is ignored.
 * Tags the element with a data-gg-id; read-only otherwise.
 */
export function findBySelectorScript(css: string, expected: string): string {
  return `(() => {
    ${SHARED_HELPERS}
    const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9\\u0900-\\u097f ]+/g, ' ').replace(/\\s+/g, ' ').trim();
    let el = null;
    try { el = document.querySelector(${JSON.stringify(css)}); } catch (e) { return null; }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return null;
    const tag = el.tagName.toLowerCase();
    const text = tag === 'select' ? '' : (el.innerText || el.textContent || '');
    const name = clean(labelOf(el) || text || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 160);
    const want = norm(${JSON.stringify(expected)});
    const have = norm(name);
    if (want && !(have.includes(want) || (have.length >= 3 && want.includes(have)))) return null;
    let id = el.getAttribute('data-gg-id');
    if (!id) { window.__ggSeq = (window.__ggSeq || 0) + 1; id = 'e' + window.__ggSeq; el.setAttribute('data-gg-id', id); }
    return { id, name, score: 100 };
  })()`;
}

/** Up to 4 clickable labels sharing at least one word with `query` (for "did you mean"). */
export function similarLabelsScript(query: string): string {
  return `(() => {
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
    const STOP = new Set(['the','a','an','to','of','for','option','button','link','page','on','my','me','in','and']);
    const tokens = norm(${JSON.stringify(query)}).split(' ').filter((t) => t.length > 2 && !STOP.has(t));
    const seen = new Set(), out = [];
    // Headings too: portals like voters.eci.gov.in title service cards ("Track Appeal") with h3/h4, not links.
    for (const el of document.querySelectorAll('a[href],button,[role=button],[role=link],[role=menuitem],[onclick],h2,h3,h4,h5')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const name = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      const n = norm(name);
      if (!name || name.length > 70 || seen.has(n)) continue;
      const hits = tokens.filter((t) => n.split(' ').some((w) => w.startsWith(t.slice(0, 5)))).length;
      if (hits) { seen.add(n); out.push({ name, hits }); }
    }
    return out.sort((a, b) => b.hits - a.hits || a.name.length - b.name.length).slice(0, 4).map((x) => x.name);
  })()`;
}

/** Focus the granted search field and clear it so insertText types exactly the title. */
export function focusSearchScript(elementId: string): string {
  return `(() => {
    const el = document.querySelector('[data-gg-id="' + ${JSON.stringify(elementId)}.replace(/[^A-Za-z0-9_-]/g, '') + '"]');
    if (!el) return false;
    el.focus();
    if (typeof el.value === 'string' && el.value !== '') {
      el.select && el.select();
    }
    return document.activeElement === el;
  })()`;
}

export function searchValueScript(elementId: string): string {
  return `(() => {
    const el = document.querySelector('[data-gg-id="' + ${JSON.stringify(elementId)}.replace(/[^A-Za-z0-9_-]/g, '') + '"]');
    return el ? String(el.value === undefined ? el.textContent : el.value) : null;
  })()`;
}
