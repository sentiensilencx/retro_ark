/* ============================================================
   ark — in-app dialogs
   window.prompt and window.confirm drag the browser's grey
   system UI straight across a warm interface, so this asks the
   same questions inside the app instead. Everything returns a
   promise: a value / true on confirm, null / false on cancel.
   ============================================================ */

import { URGENCY, todayKey } from './store.js';
import { closeMenu } from './menu.js';

const els = {
  scrim:  document.getElementById('modal-scrim'),
  title:  document.getElementById('modal-title'),
  hint:   document.getElementById('modal-hint'),
  input:  document.getElementById('modal-input'),
  form:   document.getElementById('modal-form'),
  cancel: document.getElementById('modal-cancel'),
  ok:     document.getElementById('modal-ok'),
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let settle = null;     // the promise's resolver
let collect = null;    // () => { ok, value, focus }
let returnTo = null;   // whatever had focus before we opened

function close(result) {
  if (!settle) return;
  const resolve = settle;
  settle = null;
  collect = null;

  els.scrim.hidden = true;
  els.scrim.classList.remove('is-danger');
  els.form.innerHTML = '';
  document.removeEventListener('keydown', onKeydown);

  if (returnTo && typeof returnTo.focus === 'function') returnTo.focus();
  returnTo = null;
  resolve(result);
}

function confirmNow() {
  if (!settle || !collect) return;
  const out = collect();
  if (!out.ok) {
    if (out.focus) out.focus();
    else els.input.focus();
    return;
  }
  close(out.value);
}

function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
  else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmNow(); }
}

function show(opts) {
  return new Promise((resolve) => {
    closeMenu();                 // never leave a menu holding focus behind a dialog
    settle = resolve;
    collect = opts.collect;
    returnTo = document.activeElement;

    els.title.textContent = opts.title;
    els.hint.textContent = opts.hint || '';
    els.hint.hidden = !opts.hint;

    els.input.hidden = !opts.input;
    if (opts.input) {
      els.input.value = opts.input.value || '';
      els.input.placeholder = opts.input.placeholder || '';
    }

    els.form.hidden = !opts.form;
    els.form.innerHTML = opts.form || '';

    els.cancel.textContent = opts.cancel || 'Cancel';
    els.ok.textContent = opts.ok || 'Save';
    els.ok.classList.toggle('btn-danger', !!opts.danger);
    els.scrim.classList.toggle('is-danger', !!opts.danger);

    els.scrim.hidden = false;
    document.addEventListener('keydown', onKeydown);

    requestAnimationFrame(() => {
      if (opts.input) { els.input.focus(); els.input.select(); }
      else { els.ok.focus(); }
    });
  });
}

/** Ask for a short piece of text. Resolves to the string, or null. */
export function askText({ title, hint = '', value = '', placeholder = '', ok = 'Save' } = {}) {
  return show({
    title, hint, ok, cancel: 'Cancel',
    input: { value, placeholder },
    collect: () => {
      const v = els.input.value.trim();
      if (!v) return { ok: false, focus: () => els.input.focus() };
      return { ok: true, value: v };
    },
  });
}

/** Ask yes/no. Resolves to true or false. */
export function askConfirm({ title, hint = '', ok = 'Delete', cancel = 'Cancel', danger = true } = {}) {
  return show({
    title, hint, ok, cancel, danger,
    collect: () => ({ ok: true, value: true }),
  });
}

/** Compose a task. Resolves to { title, due, folderId, urgency } or null. */
export function askTask({ folders = [], defaults = {} } = {}) {
  const due = defaults.due ?? todayKey();
  const urgency = defaults.urgency ?? 'gray';
  const folderId = defaults.folderId ?? '';

  const form = `
    <label class="field">
      <span class="field-label">Due</span>
      <input type="date" class="input" id="task-due" value="${esc(due)}">
    </label>
    <label class="field">
      <span class="field-label">Folder</span>
      <select class="input" id="task-folder">
        <option value="">No folder</option>
        ${folders.map((f) =>
          `<option value="${esc(f.id)}"${f.id === folderId ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
      </select>
    </label>
    <div class="field">
      <span class="field-label">Urgency</span>
      <div class="urgency-row" role="radiogroup" aria-label="Urgency">
        ${URGENCY.map((u) => `
        <button type="button" class="urgency-chip${u.id === urgency ? ' is-active' : ''}"
                role="radio" aria-checked="${u.id === urgency}" data-urgency-set="${u.id}">
          <span class="urgency-dot" data-u="${u.id}"></span>${u.label}
          <span class="urgency-chip-hint">${u.focus}m</span>
        </button>`).join('')}
      </div>
    </div>`;

  return show({
    title: defaults.editMode ? 'Edit task' : 'New task',
    hint: defaults.editMode ? 'Update this task.' : 'It lands in Today unless you push the date out.',
    ok: defaults.editMode ? 'Save' : 'Add task',
    cancel: 'Cancel',
    input: { placeholder: 'What needs doing?', value: defaults.title || '' },
    form,
    collect: () => {
      const title = els.input.value.trim();
      if (!title) return { ok: false, focus: () => els.input.focus() };

      const dueEl = document.getElementById('task-due');
      const folderEl = document.getElementById('task-folder');
      const active = els.form.querySelector('[data-urgency-set].is-active');

      return {
        ok: true,
        value: {
          title,
          due: dueEl && dueEl.value ? dueEl.value : null,
          folderId: folderEl && folderEl.value ? folderEl.value : null,
          urgency: active ? active.dataset.urgencySet : 'gray',
        },
      };
    },
  });
}

/* urgency chips inside the composer */
els.form.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-urgency-set]');
  if (!chip) return;
  els.form.querySelectorAll('[data-urgency-set]').forEach((c) => {
    const on = c === chip;
    c.classList.toggle('is-active', on);
    c.setAttribute('aria-checked', String(on));
  });
});

els.cancel.addEventListener('click', () => close(null));
els.ok.addEventListener('click', confirmNow);

// click the backdrop, not the dialog, to back out
els.scrim.addEventListener('mousedown', (e) => {
  if (e.target === els.scrim) close(null);
});
