/* ============================================================
   ark — context menus
   One element and one set of handlers for every right-click in
   the app. The urgency picker uses it too, so there is only one
   popup to position, focus, dismiss and take focus back from.
   ============================================================ */

const root = document.getElementById('context-menu');

let actions = [];      // actionable items, indexed by data-act
let tag = null;        // whatever the caller identifies this menu by
let returnTo = null;   // where focus goes when the menu closes
let guard = null;      // extra rule for what may be clicked without dismissing

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function setMousedownGuard(fn) { guard = fn; }
export function menuOpen() { return !!root && !root.hidden; }
export function menuTag() { return menuOpen() ? tag : null; }

/* ---------- rendering ---------- */

function itemHTML(it, idx) {
  const checkable = it.checked !== undefined;
  const role = checkable ? 'menuitemradio' : 'menuitem';
  const state = checkable ? ` aria-checked="${it.checked ? 'true' : 'false'}"` : '';
  const cls = it.danger ? 'ctx-item is-danger' : 'ctx-item';

  // a colour dot wins over an icon — urgency and folders both read as colour
  const lead = it.color
    ? `<span class="dot" data-color="${esc(it.color)}"></span>`
    : it.icon
      ? `<span class="ctx-icon"><svg width="15" height="15" aria-hidden="true"><use href="#${esc(it.icon)}"/></svg></span>`
      : '';

  const tick = it.checked
    ? '<span class="ctx-tick" aria-hidden="true"><svg width="13" height="13"><use href="#i-check"/></svg></span>'
    : '';

  const hint = it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : '';

  return `<button type="button" class="${cls}" role="${role}"${state} data-act="${idx}">` +
         `${lead}<span class="ctx-label">${esc(it.label)}</span>${tick}${hint}</button>`;
}

function render(list) {
  actions = [];
  let html = '';

  for (const it of list) {
    if (!it) continue;
    if (it.sep) { html += '<div class="ctx-sep" role="separator"></div>'; continue; }
    if (it.heading) { html += `<div class="ctx-heading" role="presentation">${esc(it.heading)}</div>`; continue; }

    const idx = actions.length;
    actions.push(it);
    html += itemHTML(it, idx);
  }

  if (root) root.innerHTML = html;
}

/* ---------- open / close ---------- */

function hide(restore) {
  if (root) root.hidden = true;
  actions = [];
  tag = null;
  document.removeEventListener('keydown', onKeydown, true);

  if (restore && returnTo && document.contains(returnTo)) {
    try { returnTo.focus(); } catch { /* nothing focusable left — leave it */ }
  }
  returnTo = null;
}

export function closeMenu() { hide(true); }

function place(anchor) {
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x;
  let y;

  if (anchor && typeof anchor.getBoundingClientRect === 'function') {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 6;
    if (y + h > vh - 8) y = r.top - h - 6;      // flip above rather than clip
  } else {
    x = anchor.x;
    y = anchor.y;
    if (y + h > vh - 8) y = anchor.y - h;
  }

  x = Math.max(8, Math.min(x, vw - w - 8));
  y = Math.max(8, Math.min(y, vh - h - 8));

  root.style.left = `${Math.round(x)}px`;
  root.style.top = `${Math.round(y)}px`;
}

/**
 * openMenu({ anchor, items, tag, returnFocus })
 *   anchor     — an element (menu hangs off it) or { x, y } (the cursor)
 *   items      — { label, icon?, color?, hint?, danger?, checked?, run? }
 *                plus { sep: true } and { heading: '…' }
 *   tag        — any string, readable back with menuTag()
 *   returnFocus— element to focus again on close; defaults sensibly
 */
export function openMenu({ anchor, items = [], tag: id = null, returnFocus = null } = {}) {
  hide(false);
  render(items);
  if (!root || !actions.length) return;          // nothing worth showing

  root.hidden = false;
  place(anchor);
  tag = id;

  if (returnFocus) {
    returnTo = returnFocus;
  } else if (anchor && typeof anchor.getBoundingClientRect === 'function') {
    returnTo = anchor;
  } else if (document.activeElement && document.activeElement !== document.body) {
    returnTo = document.activeElement;
  }

  document.addEventListener('keydown', onKeydown, true);
  // preventScroll so taking focus can't itself fire a scroll event —
  // that would immediately close the menu we just opened.
  root.querySelector('.ctx-item')?.focus({ preventScroll: true });
}

/* ---------- interaction ---------- */

function onActivate(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;

  const it = actions[Number(btn.dataset.act)];
  closeMenu();                                   // focus first, so the action
  if (it && typeof it.run === 'function') it.run();  // lands on a sane element
}

function onKeydown(e) {
  if (!menuOpen()) return;

  const list = [...root.querySelectorAll('.ctx-item')];
  if (!list.length) return;

  const i = list.indexOf(document.activeElement);

  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      break;

    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      list[i < 0 ? 0 : (i + dir + list.length) % list.length].focus();
      break;
    }

    case 'Home':
      e.preventDefault();
      e.stopPropagation();
      list[0].focus();
      break;

    case 'End':
      e.preventDefault();
      e.stopPropagation();
      list[list.length - 1].focus();
      break;

    case 'Enter':
    case ' ':
      if (e.ctrlKey || e.metaKey || e.altKey) break;   // leave shortcuts alone
      e.preventDefault();
      e.stopPropagation();
      if (i >= 0) list[i].click();
      break;

    case 'Tab':
      closeMenu();
      break;

    default:
      break;
  }
}

function onMousedown(e) {
  if (!menuOpen()) return;
  if (e.target.closest('#context-menu')) return;
  if (guard && guard(e.target)) return;
  closeMenu();
}

function onScroll(e) {
  if (!menuOpen()) return;           // never pay for a scroll handler when idle
  // scrolling inside the menu is the menu's own business
  if (root && e.target && root.contains(e.target)) return;
  closeMenu();
}

if (root) root.addEventListener('click', onActivate);

document.addEventListener('mousedown', onMousedown);
window.addEventListener('scroll', onScroll, true);
window.addEventListener('resize', () => { if (menuOpen()) closeMenu(); });
