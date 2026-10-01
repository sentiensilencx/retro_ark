/* ============================================================
   ark — command palette (Ctrl/Cmd+Q)
   Registry + fuzzy matching + the palette UI.
   ============================================================ */

import { sound } from './audio.js';
import { closeMenu } from './menu.js';

const commands = [];
const listeners = new Set();

let open = false;
let cursor = 0;
let results = [];

const scrim  = document.getElementById('palette-scrim');
const input  = document.getElementById('palette-input');
const list   = document.getElementById('palette-list');

/* ---------- registry ---------- */

export function register(cmd) {
  // cmd: { id, label, group?, hint?, keywords?, run() }
  if (commands.some((c) => c.id === cmd.id)) return;
  commands.push(cmd);
  builtFor = null;               // the palette's list is now stale
  listeners.forEach((fn) => fn());
}

export function registerAll(cmds) {
  cmds.forEach(register);
}

export function onChange(fn) {
  listeners.add(fn);
}

export function allCommands() {
  return [...commands];
}

/* ---------- matching ---------- */

function match(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return 100 - direct;

  let i = 0;
  let gap = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, i);
    if (found === -1) return -1;
    gap += found - i;
    i = found + 1;
  }
  return 50 - gap;
}

function search(query) {
  const haystack = commands.map((cmd) => {
    const text = `${cmd.label} ${cmd.keywords ?? ''}`;
    return { cmd, score: Math.max(match(query, cmd.label), match(query, text)) };
  });

  return haystack
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.cmd);
}

/* ---------- rendering ---------- */

/* Signature of the results the current DOM was built from. Rebuilding
   tears down every button, which restarts the drop-in animation — so it
   only happens when the result set actually changes. */
let builtFor = null;

function buildList() {
  if (!results.length) {
    list.innerHTML = '<div class="palette-empty">No matching command</div>';
    return;
  }

  let html = '';
  let group = null;

  results.forEach((cmd, i) => {
    if (cmd.group !== group) {
      group = cmd.group;
      html += `<div class="palette-group">${escapeHtml(group ?? 'Commands')}</div>`;
    }
    html += `
      <button class="palette-item" role="option" aria-selected="false" data-index="${i}">
        <span class="pi-label">${escapeHtml(cmd.label)}</span>
        ${cmd.hint ? `<span class="pi-hint">${escapeHtml(cmd.hint)}</span>` : ''}
      </button>`;
  });

  list.innerHTML = html;
}

/* Moving the cursor only flips two classes — the list itself stays
   untouched, so arrow keys don't make it re-animate or jump. */
function moveCursor() {
  const items = [...list.querySelectorAll('.palette-item')];
  const shown = items.findIndex((el) => el.classList.contains('is-cursor'));

  cursor = Math.max(0, Math.min(cursor, items.length - 1));

  items.forEach((el, i) => {
    const on = i === cursor;
    if (el.classList.contains('is-cursor') === on) return;
    el.classList.toggle('is-cursor', on);
    el.setAttribute('aria-selected', String(on));
  });

  if (shown !== cursor) {
    list.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }
}

function render() {
  results = search(input.value ?? '');

  const signature = results.map((c) => c.id).join('\u0000');
  if (signature !== builtFor) {
    builtFor = signature;
    buildList();
  }

  moveCursor();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- open / close ---------- */

export function togglePalette() {
  open ? closePalette() : openPalette();
}

export function openPalette() {
  if (open) return;
  closeMenu();                   // one popup at a time
  open = true;
  cursor = 0;
  input.value = '';
  scrim.hidden = false;
  render();
  requestAnimationFrame(() => input.focus());
  sound.play('open');
}

export function closePalette() {
  if (!open) return;
  open = false;
  scrim.hidden = true;
  input.blur();
  sound.play('close');
}

export function isPaletteOpen() {
  return open;
}

function runCursor() {
  const cmd = results[cursor];
  if (!cmd) return;
  closePalette();
  cmd.run();
}

/* ---------- events ---------- */

input.addEventListener('input', () => { cursor = 0; render(); });

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cursor = Math.min(cursor + 1, results.length - 1);
    moveCursor();                 // never rebuild — that's what made it flicker
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cursor = Math.max(cursor - 1, 0);
    moveCursor();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runCursor();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});

list.addEventListener('click', (e) => {
  const item = e.target.closest('.palette-item');
  if (!item) return;
  cursor = Number(item.dataset.index);
  runCursor();
});

scrim.addEventListener('mousedown', (e) => {
  if (e.target === scrim) closePalette();
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  // Ctrl/Cmd + Q — the spec'd binding.
  // Ctrl/Cmd + K — alias, in case Q is taken by the browser or window manager.
  if (mod && (e.key === 'q' || e.key === 'Q' || e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    togglePalette();
    return;
  }

  if (e.key === 'Escape' && open) {
    e.preventDefault();
    closePalette();
  }
});
