/* ============================================================
   ark — app boot, view routing, tasks, folders, profile
   ============================================================ */

import {
  getState, subscribe, counts, mutate,
  todayKey, URGENCY, urgencyInfo, FOLDER_COLORS,
  addFolder, removeFolder, renameFolder, recolorFolder, nextFolderColor,
  addTask, toggleTask, removeTask, setUrgency, setTaskFolder, setFocusTask,
  setName, setAvatar, updateTask,
  setNameQuiet, setMasterVolumeQuiet, setSoundEnabled,
} from './store.js';
import { registerAll, openPalette } from './commands.js';
import { mountPomodoro, pomodoro } from './pomodoro.js';
import { sound } from './audio.js';
import { askText, askConfirm, askTask } from './modal.js';
import { openMenu, closeMenu, menuOpen, menuTag, setMousedownGuard } from './menu.js';

const VIEWS = {
  today:     { title: 'Today' },
  upcoming:  { title: 'Upcoming' },
  all:       { title: 'All tasks' },
  folders:   { title: 'Folders' },
  folder:    { title: 'Folder', hidden: true },
  pomodoro:  { title: 'Pomodoro' },
  sounds:    { title: 'Noise' },
  profile:   { title: 'Profile' },
  settings:  { title: 'Settings' },
};

const els = {
  sidebar:   document.getElementById('sidebar'),
  scrim:     document.getElementById('scrim'),
  toggle:    document.getElementById('sidebar-toggle'),
  title:     document.getElementById('view-title'),
  folderGrid:document.getElementById('folder-grid'),
  folderTitle: document.getElementById('folder-title'),
  folderSub:   document.getElementById('folder-sub'),
  trigger:   document.getElementById('palette-trigger'),
  profileBtn:document.getElementById('profile-btn'),
  profileName: document.getElementById('profile-name'),
  avatar:    document.getElementById('avatar'),
  bigAvatar: document.getElementById('profile-avatar'),
  nameInput: document.getElementById('display-name'),
  fileInput: document.getElementById('picture-input'),
  pickBtn:   document.getElementById('pick-picture'),
  pickLabel: document.getElementById('pick-picture-label'),
  clearBtn:  document.getElementById('clear-picture'),
  note:      document.getElementById('picture-note'),
  lists: {
    today:    document.getElementById('list-today'),
    upcoming: document.getElementById('list-upcoming'),
    all:      document.getElementById('list-all'),
    folder:   document.getElementById('list-folder'),
  },
};

let currentView = 'today';
let currentFolderId = null;
/* A long-press fires contextmenu then a stray click on whatever you
   were holding — that one click is swallowed (see the right-click
   handler below). */
let swallowClick = false;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setSub(key, text) {
  const el = document.querySelector(`[data-sub="${key}"]`);
  if (el) el.textContent = text;
}

/* ---------- routing ---------- */

function viewTitle(name) {
  if (name !== 'folder') return VIEWS[name].title;
  const f = getState().folders.find((x) => x.id === currentFolderId);
  return f ? f.name : 'Folder';
}

function setView(name) {
  if (!VIEWS[name]) return;
  if (name === 'folder' && !currentFolderId) name = 'folders';
  currentView = name;

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));

  // one reflow with the target hidden, so its entrance animation
  // restarts from the top every time you switch views.
  const target = document.querySelector(`.view[data-view="${name}"]`);
  if (target) {
    void target.offsetWidth;
    target.classList.add('is-active');
  }

  document.querySelectorAll('[data-nav]').forEach((b) => {
    // the profile row is a shortcut, not a tab — only real nav rows and
    // the gear light up
    const trackable = b.classList.contains('nav-item') || b.classList.contains('profile-gear');
    if (trackable) b.classList.toggle('is-active', b.dataset.nav === name);
  });

  els.title.textContent = viewTitle(name);
  document.getElementById('content').scrollTop = 0;
  closeDrawer();
  closeMenu();
}

function openFolder(id) {
  if (!getState().folders.some((f) => f.id === id)) return;
  currentFolderId = id;
  renderTasks();
  setView('folder');
}

/* ---------- tasks ---------- */

function dueLabel(due) {
  if (!due) return '';
  const today = todayKey();
  if (due === today) return 'Today';
  if (due === todayKey(new Date(Date.now() + 864e5))) return 'Tomorrow';
  if (due < today) return 'Overdue';
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/* gray < amber < red, so the loudest work floats to the top */
const rank = (u) => Math.max(0, URGENCY.findIndex((x) => x.id === u));

function sortTasks(list) {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const r = rank(b.urgency) - rank(a.urgency);
    if (r) return r;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/* the two actions the row and the context menu both need to agree on */
function doToggleTask(id) {
  toggleTask(id);
  const t = getState().tasks.find((x) => x.id === id);
  // finishing a task gets its own recording; un-finishing is just a click
  if (t?.done) sound.play('done');
  else if (t) sound.play('click');
  if (t && t.done && getState().focusTaskId === id) setFocusTask(null);
}

function deleteTask(id) {
  if (getState().focusTaskId === id) setFocusTask(null);
  removeTask(id);
}

function taskRowHTML(t) {
  const s = getState();
  const info = urgencyInfo(t.urgency);
  const folder = t.folderId ? s.folders.find((f) => f.id === t.folderId) : null;
  const bits = [];
  if (folder) bits.push(esc(folder.name));
  const due = dueLabel(t.due);
  if (due) bits.push(esc(due));

  const title = esc(t.title);
  const pinned = s.focusTaskId === t.id;

  return `
      <li class="task${t.done ? ' is-done' : ''}${pinned ? ' is-focus' : ''}"
          data-task="${t.id}" data-urgency="${info.id}">
        <button class="task-check" data-task-toggle="${t.id}"
                role="checkbox" aria-checked="${t.done}"
                aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${title}">
          <svg class="task-tick" width="12" height="12" aria-hidden="true"><use href="#i-check"/></svg>
        </button>
        <div class="task-main">
          <span class="task-title">${title}</span>
          ${bits.length ? `<span class="task-meta">${bits.join(' · ')}</span>` : ''}
        </div>
        <div class="task-tools">
          <button class="urgency-pick" data-urgency-for="${t.id}"
                  title="Urgency — ${info.label}" aria-label="Urgency: ${info.label}. Change">
            <span class="urgency-dot" data-u="${info.id}"></span>
          </button>
          <button class="icon-btn task-focus" data-task-focus="${t.id}"
                  title="Pomodoro on this" aria-label="Time this with the pomodoro">
            <svg width="15" height="15"><use href="#i-timer"/></svg>
          </button>
          <button class="icon-btn task-del" data-task-del="${t.id}"
                  title="Delete" aria-label="Delete task">
            <svg width="15" height="15"><use href="#i-trash"/></svg>
          </button>
        </div>
      </li>`;
}

function renderList(ul, tasks, emptyTitle, emptySub) {
  if (!ul) return;
  if (!tasks.length) {
    ul.innerHTML = `<li class="empty">
        <div class="empty-title">${emptyTitle}</div>
        <div class="empty-sub">${emptySub}</div>
      </li>`;
    return;
  }
  ul.innerHTML = sortTasks(tasks).map(taskRowHTML).join('');
}

function renderTasks() {
  const s = getState();
  const today = todayKey();

  const doneToday = (t) => t.completedAt && todayKey(new Date(t.completedAt)) === today;
  const inToday = s.tasks.filter((t) => {
    if (t.due && t.due > today) return false;
    return t.done ? doneToday(t) : true;        // undated work shows up here
  });
  const upcoming = s.tasks.filter((t) => t.due && t.due > today);

  renderList(els.lists.today, inToday, 'A clear day',
    'Nothing here yet. Make one with the button above.');
  renderList(els.lists.upcoming, upcoming, 'Nothing queued',
    'Anything you date beyond today groups itself here.');
  renderList(els.lists.all, s.tasks, 'No tasks yet',
    'Make your first one with the button above.');

  const openToday = inToday.filter((t) => !t.done).length;
  setSub('today', openToday ? `${openToday} open` : 'Nothing scheduled yet.');
  setSub('upcoming', upcoming.length
    ? `${upcoming.length} coming up` : 'Everything with a date attached.');
  setSub('all', s.tasks.length ? `${s.tasks.length} tasks` : 'Every task across every folder.');

  const folder = s.folders.find((f) => f.id === currentFolderId);
  if (folder) {
    const mine = s.tasks.filter((t) => t.folderId === folder.id);
    const open = mine.filter((t) => !t.done).length;
    renderList(els.lists.folder, mine, 'Nothing in here',
      'Tasks made from this page land in this folder.');
    if (els.folderTitle) els.folderTitle.textContent = folder.name;
    if (els.folderSub) els.folderSub.textContent =
      open ? `${open} open` : 'Nothing open in this folder.';
  } else {
    currentFolderId = null;
    renderList(els.lists.folder, [], 'No folder', 'Pick a folder from the grid.');
  }
}

/* ---------- folders ---------- */

function renderFolders() {
  const { folders, tasks } = getState();

  els.folderGrid.innerHTML = folders.map((f) => {
    const n = tasks.filter((t) => t.folderId === f.id && !t.done).length;
    const name = esc(f.name);
    return `
      <div class="card folder-card" data-folder-card="${f.id}">
        <div class="folder-card-top">
          <button class="dot" data-color="${f.color}" data-folder-action="recolor"
                  data-id="${f.id}" title="Change colour"
                  aria-label="Change the colour of ${name}"></button>
          <div class="folder-card-actions">
            <button class="icon-btn" data-folder-action="rename" data-id="${f.id}"
                    title="Rename" aria-label="Rename ${name}">
              <svg width="15" height="15"><use href="#i-pencil"/></svg>
            </button>
            <button class="icon-btn" data-folder-action="delete" data-id="${f.id}"
                    title="Delete" aria-label="Delete ${name}">
              <svg width="15" height="15"><use href="#i-trash"/></svg>
            </button>
          </div>
        </div>
        <button class="folder-card-open" data-folder-open="${f.id}">
          <span class="folder-card-name">${name}</span>
          <span class="folder-card-count">${n} open</span>
        </button>
      </div>`;
  }).join('') || `<div class="empty" style="grid-column:1/-1">
      <div class="empty-title">No folders</div>
      <div class="empty-sub">Make one with the button above, or <kbd>Ctrl</kbd> <kbd>Q</kbd> → “New folder”.</div>
    </div>`;
}

async function folderAction(action, id) {
  const folder = getState().folders.find((f) => f.id === id);
  if (!folder) return;

  if (action === 'recolor') {
    recolorFolder(id);
  } else if (action === 'rename') {
    const name = await askText({
      title: 'Rename folder',
      hint: 'Everything inside keeps its tasks.',
      value: folder.name,
      placeholder: 'Folder name',
      ok: 'Rename',
    });
    if (name !== null) renameFolder(id, name);
  } else if (action === 'delete') {
    const ok = await askConfirm({
      title: `Delete “${folder.name}”?`,
      hint: 'Any tasks inside it go too.',
      ok: 'Delete',
    });
    if (!ok) return;
    // capture before the store emits: renderTasks nulls the id out from under us
    const wasOpen = currentFolderId === id;
    removeFolder(id);
    sound.play('move');
    if (wasOpen) { currentFolderId = null; setView('folders'); }
  }
}

function renderCounts() {
  const c = counts();
  document.querySelectorAll('[data-count]').forEach((el) => {
    el.textContent = c[el.dataset.count] ?? 0;
  });
}

/* Paint an avatar node from the profile record. */
function paintAvatar(node, profile, size) {
  if (!node) return;
  if (profile.avatar) {
    node.innerHTML = `<img src="${esc(profile.avatar)}" alt="">`;
  } else if (profile.name) {
    node.textContent = profile.name[0].toUpperCase();   // one character, no escaping needed
  } else {
    node.innerHTML = `<svg width="${size}" height="${size}"><use href="#i-user"/></svg>`;
  }
}

/* The sidebar footer is one row — picture, name, gear. Until you name
   yourself the name slot offers to, rather than reading as an error. */
function renderProfile() {
  const { profile } = getState();
  const name = profile.name || '';

  paintAvatar(els.avatar, profile, 16);
  paintAvatar(els.bigAvatar, profile, 32);

  els.profileName.textContent = name || 'Set a name';
  els.profileName.classList.toggle('is-placeholder', !name);
  // the visible words have to appear inside the accessible name, so
  // don't say "Your profile" where the row reads "Set a name"
  els.profileBtn.setAttribute(
    'aria-label', name ? `${name} — profile` : 'Set a name');

  if (els.nameInput && document.activeElement !== els.nameInput) {
    els.nameInput.value = name;
  }
  if (els.clearBtn) els.clearBtn.hidden = !profile.avatar;
  if (els.pickLabel) els.pickLabel.textContent = profile.avatar ? 'Replace picture' : 'Choose picture';
}

/* ---------- themes ---------- */

/* Each entry previews itself in the swatch grid, so the three colours
   here must match that theme's --bg / --surface-raised / --accent.
   `dusk` has no block in themes.css — it IS the :root default in
   tokens.css, which is why it is named DEFAULT_THEME below. */
const THEMES = {
  dusk:  { label: 'Dusk',  bg: '#17110f', card: '#251d19', accent: '#e8809b' },
  amber: { label: 'Amber', bg: '#17100a', card: '#271e15', accent: '#f0a850' },
  sage:  { label: 'Sage',  bg: '#12150f', card: '#20251c', accent: '#a8c47a' },
  plum:  { label: 'Plum',  bg: '#150f18', card: '#251c2b', accent: '#c48ad8' },
  paper: { label: 'Paper', bg: '#ddd5c6', card: '#f5efe4', accent: '#a83a5c' },
};

const DEFAULT_THEME = 'dusk';

/* A save from an older build carries a theme id that no longer exists
   (this build renamed every theme around the warm end of the wheel).
   Rewrite it once, here, where THEMES actually lives — store.js has no
   business knowing the theme list. */
function migrateTheme() {
  const saved = getState().settings.theme;
  if (THEMES[saved]) return;
  setTheme(DEFAULT_THEME);
}

function applyTheme(name) {
  const theme = THEMES[name] ? name : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-pick]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themePick === theme));
  });
}

function setTheme(name) {
  if (!THEMES[name]) return;
  mutate((s) => { s.settings.theme = name; });
  applyTheme(name);
}

function renderAll() {
  renderFolders();
  renderTasks();
  renderCounts();
  renderProfile();
  renderNoise();
  renderAudioSettings();
  applyTheme(getState().settings.theme);
  // renaming the folder we're standing in has to move the topbar title too
  if (currentView === 'folder') els.title.textContent = viewTitle('folder');
}

/* ---------- noise ---------- */

/* The beds are discovered from audio.js and probed once. A missing .wav
   shows a clear "no file" state rather than a dead-looking button. */
const bedState = new Map();   // id -> true when the file is actually there

function renderNoise() {
  const grid = document.getElementById('noise-grid');
  if (!grid) return;

  const beds = sound.beds();
  if (!beds.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <div class="empty-title">No noise beds</div>
        <div class="empty-sub">Nothing is defined in <code>audio.js</code>.</div>
      </div>`;
    return;
  }

  grid.innerHTML = beds.map((b) => {
    const present = bedState.get(b.id) !== false;   // optimistic until probed
    const on = sound.isLooping(b.id);
    const label = `${b.label}${present ? '' : ' — file missing'}`;
    return `
      <button class="card noise-card${on ? ' is-playing' : ''}${present ? '' : ' is-missing'}"
              data-noise="${esc(b.id)}"
              aria-pressed="${on}"
              ${present ? '' : 'disabled'}
              aria-label="${esc(label)}">
        <span class="dot" data-color="${esc(b.color)}"></span>
        <span class="noise-name">${esc(b.label)}</span>
        <span class="mono faint noise-file">${present ? esc(b.file) : 'not found'}</span>
        <span class="noise-state">${on ? 'Playing' : (present ? 'Tap to play' : 'Add the file')}</span>
      </button>`;
  }).join('');

  const playing = beds.filter((b) => sound.isLooping(b.id)).length;
  const stopBtn = document.querySelector('[data-action="stop-noise"]');
  if (stopBtn) stopBtn.hidden = playing === 0;
  setSub('sounds', playing
    ? `${playing} bed${playing > 1 ? 's' : ''} playing`
    : 'Loops for focus. Drop .wav files into sounds/.');
}

function toggleBed(id) {
  if (bedState.get(id) === false) return;
  if (sound.isLooping(id)) sound.stop(id);
  else sound.loop(id, { volume: getState().settings.masterVolume });
  renderNoise();
}

async function probeBeds() {
  const beds = sound.beds();
  await Promise.all(beds.map(async (b) => {
    bedState.set(b.id, await sound.has(b.id));
  }));
  renderNoise();
}

function renderAudioSettings() {
  const s = getState().settings;
  const pct = Math.round(s.masterVolume * 100);

  for (const id of ['noise-volume', 'settings-volume']) {
    const el = document.getElementById(id);
    // don't fight the user while they're dragging
    if (el && document.activeElement !== el) el.value = String(pct);
  }
  for (const id of ['noise-volume-value', 'settings-volume-value']) {
    const el = document.getElementById(id);
    if (el) el.textContent = `${pct}%`;
  }
  for (const id of ['noise-enabled', 'settings-enabled']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = s.soundEnabled ? 'On' : 'Off';
    el.setAttribute('aria-pressed', String(!!s.soundEnabled));
  }
}

/* Fires on every drag event, so it writes quietly and repaints only
   the readouts — going through mutate() would rebuild every task list
   in the app, dozens of times per second. */
function setMasterVolume(v) {
  const pct = Math.max(0, Math.min(100, Math.round(v)));
  setMasterVolumeQuiet(pct / 100);
  sound.setVolume(pct / 100);
  renderAudioSettings();
}

function toggleSoundEnabled() {
  const next = !getState().settings.soundEnabled;
  setSoundEnabled(next);
  sound.setEnabled(next);
  renderAudioSettings();
  renderNoise();
}

/* ---------- task editing ---------- */

async function editTaskFlow(id) {
  const t = getState().tasks.find((x) => x.id === id);
  if (!t) return;
  const draft = await askTask({
    folders: getState().folders,
    defaults: {
      editMode: true,
      title: t.title,
      due: t.due || undefined,
      folderId: t.folderId || '',
      urgency: t.urgency,
    },
  });
  if (!draft) return;
  updateTask(id, draft);
}

/* ---------- context menus ---------- */

/* One helper for each group, so the row's left-click picker and the
   right-click menu can never drift apart. */

function urgencyItems(t) {
  return URGENCY.map((u) => ({
    label: u.label,
    color: u.id,
    hint: `${u.focus}m`,
    checked: u.id === t.urgency,
    run: () => setUrgency(t.id, u.id),
  }));
}

function folderMoveItems(t) {
  return [
    { label: 'No folder', checked: !t.folderId, run: () => setTaskFolder(t.id, null) },
    ...getState().folders.map((f) => ({
      label: f.name,
      color: f.color,
      checked: t.folderId === f.id,
      run: () => setTaskFolder(t.id, f.id),
    })),
  ];
}

function openUrgencyPicker(btn, taskId) {
  const t = getState().tasks.find((x) => x.id === taskId);
  if (!t) return;
  openMenu({
    anchor: btn,
    tag: `urgency:${taskId}`,
    items: [{ heading: 'Urgency' }, ...urgencyItems(t)],
  });
}

function openTaskMenu(id, x, y) {
  const t = getState().tasks.find((a) => a.id === id);
  if (!t) return;

  openMenu({
    anchor: { x, y },
    tag: `task:${id}`,
    returnFocus: document.querySelector(`[data-task="${id}"] .task-check`),
    items: [
      { label: t.done ? 'Mark not done' : 'Mark done', icon: 'i-check',
        run: () => doToggleTask(id) },
      { label: 'Edit task', icon: 'i-pencil', run: () => editTaskFlow(id) },
      { sep: true },
      { heading: 'Urgency' },
      ...urgencyItems(t),
      { sep: true },
      { heading: 'Move to' },
      ...folderMoveItems(t),
      { sep: true },
      { label: 'Pomodoro on this', icon: 'i-timer',
        run: () => { setFocusTask(id); setView('pomodoro'); } },
      { label: 'Delete task', icon: 'i-trash', danger: true, run: () => deleteTask(id) },
    ],
  });
}

function openFolderMenu(id, x, y) {
  const f = getState().folders.find((a) => a.id === id);
  if (!f) return;

  openMenu({
    anchor: { x, y },
    tag: `folder:${id}`,
    returnFocus: document.querySelector(`[data-folder-card="${id}"] [data-folder-open]`),
    items: [
      { label: 'Open', icon: 'i-folder', run: () => openFolder(id) },
      { sep: true },
      { label: 'Rename', icon: 'i-pencil', run: () => folderAction('rename', id) },
      { label: 'Change colour', run: () => openColorMenu(id, f.color, x, y) },
      { sep: true },
      { label: 'Delete folder', icon: 'i-trash', danger: true,
        run: () => folderAction('delete', id) },
    ],
  });
}

/* one menu standing in for a submenu — same place, next layer */
function openColorMenu(id, current, x, y) {
  openMenu({
    anchor: { x, y },
    tag: `color:${id}`,
    returnFocus: document.querySelector(`[data-folder-card="${id}"] [data-folder-open]`),
    items: [
      { heading: 'Colour' },
      ...FOLDER_COLORS.map((c) => ({
        label: c[0].toUpperCase() + c.slice(1),
        color: c,
        checked: c === current,
        run: () => recolorFolder(id, c),
      })),
    ],
  });
}

function navExtras(view) {
  if (view === 'today' || view === 'upcoming' || view === 'all') {
    return [{ label: 'New task', icon: 'i-plus', run: () => newTaskFlow(view) }];
  }
  if (view === 'folders') return [{ label: 'New folder', icon: 'i-plus', run: newFolderFlow }];
  if (view === 'pomodoro') {
    return [
      { label: 'Start / pause', run: () => pomodoro.toggle() },
      { label: 'Skip phase', run: () => pomodoro.skip() },
      { label: 'Reset', run: () => pomodoro.reset() },
    ];
  }
  if (view === 'sounds') {
    return [{ label: 'Stop all noise', run: () => { sound.stopAll(); renderNoise(); } }];
  }
  return [];
}

function openNavMenu(view, x, y, el) {
  const extras = navExtras(view);
  const items = [...extras];
  if (extras.length) items.push({ sep: true });
  items.push({ label: `Go to ${VIEWS[view].title}`, run: () => setView(view) });

  openMenu({ anchor: { x, y }, tag: `nav:${view}`, returnFocus: el, items });
}

function openThemeMenu(x, y, el) {
  openMenu({
    anchor: { x, y },
    tag: 'theme',
    returnFocus: el,
    items: [
      { heading: 'Theme' },
      ...Object.entries(THEMES).map(([id, t]) => ({
        label: t.label,
        checked: getState().settings.theme === id,
        run: () => setTheme(id),
      })),
    ],
  });
}

function openProfileMenu(x, y, el) {
  const hasAvatar = !!getState().profile.avatar;
  const items = [
    { label: 'Open profile', icon: 'i-user', run: () => setView('profile') },
    { label: hasAvatar ? 'Replace picture' : 'Choose picture', icon: 'i-image',
      run: () => { setView('profile'); els.fileInput?.click(); } },
  ];
  if (hasAvatar) {
    items.push({ label: 'Remove picture', icon: 'i-trash', run: () => setAvatar(null) });
  }
  items.push({ sep: true });
  items.push({ label: 'Settings', icon: 'i-settings', run: () => setView('settings') });

  openMenu({ anchor: { x, y }, tag: 'profile', returnFocus: el, items });
}

function openSidebarMenu(x, y, el) {
  const collapsed = document.getElementById('app').classList.contains('is-collapsed');
  openMenu({
    anchor: { x, y },
    tag: 'sidebar',
    returnFocus: el,
    items: [
      { label: collapsed ? 'Expand sidebar' : 'Collapse sidebar', icon: 'i-menu',
        hint: 'Ctrl+\\', run: toggleSidebar },
      { sep: true },
      { label: 'Open command palette', icon: 'i-search', hint: 'Ctrl+Q',
        run: () => openPalette() },
    ],
  });
}

function openPaletteMenu(x, y, el) {
  openMenu({
    anchor: { x, y },
    tag: 'palette',
    returnFocus: el,
    items: [
      { label: 'Open command palette', icon: 'i-search', hint: 'Ctrl+Q',
        run: () => openPalette() },
      { sep: true },
      { label: 'New task', icon: 'i-plus',
        run: () => newTaskFlow(currentView === 'folder' ? 'folder' : 'all') },
      { label: 'New folder', icon: 'i-plus', run: newFolderFlow },
    ],
  });
}

function openPomodoroMenu(x, y, el) {
  const items = [
    { label: 'Start / pause', icon: 'i-timer', run: () => pomodoro.toggle() },
    { label: 'Skip phase', run: () => pomodoro.skip() },
    { label: 'Reset', run: () => pomodoro.reset() },
  ];

  if (getState().focusTaskId) {
    items.push({ label: 'Clear pinned task', run: () => setFocusTask(null) });
  }

  openMenu({ anchor: { x, y }, tag: 'pomodoro', returnFocus: el, items });
}

/* ---------- drawer (mobile) ---------- */

function openDrawer() {
  els.sidebar.classList.add('is-open');
  els.scrim.classList.add('is-visible');
}
function closeDrawer() {
  els.sidebar.classList.remove('is-open');
  els.scrim.classList.remove('is-visible');
}
function drawerOpen() {
  return els.sidebar.classList.contains('is-open');
}

/* Ctrl+\ — drawer on small screens, real collapse on desktop */
function toggleSidebar() {
  if (window.innerWidth <= 860) {
    drawerOpen() ? closeDrawer() : openDrawer();
  } else {
    document.getElementById('app').classList.toggle('is-collapsed');
  }
}

/* ---------- commands ---------- */

async function newFolderFlow() {
  const name = await askText({
    title: 'New folder',
    hint: 'A workspace for grouping tasks.',
    placeholder: 'Folder name',
    ok: 'Create',
  });
  if (name === null) return;
  addFolder(name, nextFolderColor());
  setView('folders');
  renderAll();
}

async function newTaskFlow(scope = 'all') {
  const s = getState();
  const defaults = { due: todayKey() };

  if (scope === 'upcoming') defaults.due = todayKey(new Date(Date.now() + 864e5));
  if (scope === 'folder' && currentFolderId) defaults.folderId = currentFolderId;

  const draft = await askTask({ folders: s.folders, defaults });
  if (!draft) return;
  addTask(draft);
}

registerAll([
  ...Object.entries(VIEWS).filter(([, v]) => !v.hidden).map(([id, v]) => ({
    id: `go-${id}`,
    label: `Go to ${v.title}`,
    group: 'Navigate',
    hint: id === 'settings' ? 'Ctrl+,' : 'view',
    keywords: `open view ${id}`,
    run: () => setView(id),
  })),
  ...Object.entries(THEMES).map(([id, t]) => ({
    id: `theme-${id}`,
    label: `Theme: ${t.label}`,
    group: 'Appearance',
    hint: 'theme',
    keywords: `colour color scheme look ${id}`,
    run: () => setTheme(id),
  })),
  { id: 'new-task', label: 'New task', group: 'Create', hint: 'todo',
    keywords: 'add item make write something up',
    run: () => newTaskFlow(currentView === 'folder' ? 'folder' : 'all') },
  { id: 'new-folder', label: 'New folder', group: 'Create', hint: 'organise',
    keywords: 'add workspace category', run: newFolderFlow },
  { id: 'open-palette', label: 'Open command palette', group: 'App',
    keywords: 'search commands', run: () => setTimeout(openPalette, 0) },
  { id: 'toggle-drawer', label: 'Toggle sidebar', group: 'App', hint: 'Ctrl+\\',
    keywords: 'menu navigation hide show', run: toggleSidebar },
  { id: 'stop-noise', label: 'Stop all noise', group: 'Focus',
    keywords: 'quiet silence audio off', run: () => { sound.stopAll(); renderNoise(); } },
  ...sound.beds().map((b) => ({
    id: `noise-${b.id}`,
    label: `Noise: ${b.label}`,
    group: 'Focus',
    hint: b.file,
    keywords: `ambience sound loop ${b.id}`,
    run: () => toggleBed(b.id),
  })),
  { id: 'pomo-toggle', label: 'Start / pause pomodoro', group: 'Focus', hint: 'timer',
    keywords: '25 focus countdown ring', run: () => { pomodoro.toggle(); } },
  { id: 'pomo-skip', label: 'Skip to next pomodoro phase', group: 'Focus',
    keywords: 'break next forward', run: () => pomodoro.skip() },
  { id: 'pomo-reset', label: 'Reset pomodoro', group: 'Focus',
    keywords: 'restart timer clear', run: () => pomodoro.reset() },
]);

/* ---------- events ---------- */

document.addEventListener('click', (e) => {
  if (swallowClick) { swallowClick = false; return; }

  const swatch = e.target.closest('[data-theme-pick]');
  if (swatch) { sound.play('click'); setTheme(swatch.dataset.themePick); return; }

  const bed = e.target.closest('[data-noise]');
  if (bed) { sound.play('click'); toggleBed(bed.dataset.noise); return; }

  if (e.target.closest('[data-action="stop-noise"]')) {
    sound.play('click');
    sound.stopAll();
    renderNoise();
    setSub('sounds', 'Loops for focus. Drop .wav files into sounds/.');
    return;
  }

  if (e.target.closest('#noise-enabled, #settings-enabled')) {
    sound.play('click');
    toggleSoundEnabled();
    return;
  }

  const fa = e.target.closest('[data-folder-action]');
  if (fa) { folderAction(fa.dataset.folderAction, fa.dataset.id); return; }

  const pick = e.target.closest('[data-urgency-for]');
  if (pick) {
    const id = pick.dataset.urgencyFor;
    if (menuTag() === `urgency:${id}`) closeMenu();
    else openUrgencyPicker(pick, id);
    return;
  }

  const toggle = e.target.closest('[data-task-toggle]');
  if (toggle) { doToggleTask(toggle.dataset.taskToggle); return; }

  const del = e.target.closest('[data-task-del]');
  if (del) { deleteTask(del.dataset.taskDel); return; }

  const foc = e.target.closest('[data-task-focus]');
  if (foc) {
    sound.play('click');
    setFocusTask(foc.dataset.taskFocus);
    setView('pomodoro');
    return;
  }

  const open = e.target.closest('[data-folder-open]');
  if (open) { sound.play('click'); openFolder(open.dataset.folderOpen); return; }

  const nav = e.target.closest('[data-nav]');
  if (nav) { sound.play('click'); setView(nav.dataset.nav); return; }

  if (e.target.closest('[data-action="new-folder"]')) {
    sound.play('click');
    newFolderFlow();
    return;
  }
  const nt = e.target.closest('[data-action="new-task"]');
  if (nt) { sound.play('click'); newTaskFlow(nt.dataset.scope || 'all'); return; }
});

/* clicking the urgency dot again closes its menu rather than reopening it */
setMousedownGuard((target) => !!(target && target.closest('[data-urgency-for]')));

/* ---- right-click ----

   text fields keep the browser's own menu, since that is where cut,
   copy and paste actually matter.

   A long-press on a touchscreen fires contextmenu and then a stray
   click on whatever you were holding — so opening a menu would also
   check a task or jump a view. Swallow that one click. A real click
   always arrives after a mousedown or a keydown, which clears it. */

document.addEventListener('mousedown', () => { swallowClick = false; });
window.addEventListener('keydown', () => { swallowClick = false; });

function menuFor(e) {
  const x = e.clientX;
  const y = e.clientY;
  const btn = e.target.closest('button');

  const task = e.target.closest('[data-task]');
  if (task) return () => openTaskMenu(task.dataset.task, x, y);

  const folder = e.target.closest('[data-folder-card]');
  if (folder) return () => openFolderMenu(folder.dataset.folderCard, x, y);

  const swatch = e.target.closest('[data-theme-pick]');
  if (swatch) return () => openThemeMenu(x, y, swatch);

  const nav = e.target.closest('.nav-item');
  if (nav) return () => openNavMenu(nav.dataset.nav, x, y, nav);

  if (e.target.closest('.profile, #pick-picture, #clear-picture')) {
    return () => openProfileMenu(x, y, btn);
  }
  if (e.target.closest('#palette-trigger')) return () => openPaletteMenu(x, y, btn);
  if (e.target.closest('#sidebar-toggle')) return () => openSidebarMenu(x, y, btn);

  const pomo = e.target.closest(
    '#pomo-start, #pomo-skip, #pomo-reset, #pomo-time, #pomo-unpin');
  if (pomo) return () => openPomodoroMenu(x, y, btn || pomo);

  return null;
}

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('#context-menu')) return;   // the menu doesn't menu itself
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.target.closest('#palette-scrim, #modal-scrim')) return;

  const showMenu = menuFor(e);
  if (!showMenu) return;                 // nothing here — browser keeps its menu

  e.preventDefault();
  swallowClick = true;
  showMenu();
});

/* ---- profile picture: a local file, shrunk to fit localStorage ---- */

function note(text, ms = 3200) {
  if (!els.note) return;
  els.note.textContent = text || '';
  els.note.hidden = !text;
  clearTimeout(note._timer);
  if (text && ms) note._timer = setTimeout(() => { els.note.hidden = true; }, ms);
}

function shrinkToDataUrl(img, max = 320) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function loadPicture(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) {
      reject(new Error('That file is not an image.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be opened.'));
      img.onload = () => {
        try {
          resolve(shrinkToDataUrl(img));     // a few tens of KB, safely under quota
        } catch {
          resolve(reader.result);            // canvas refused — keep it as it came
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* Display name saves as you type — so this is a per-keystroke path.
   setName() would emit and rebuild every view on each character; the
   quiet write plus renderProfile() touches only the avatar and label. */
if (els.nameInput) {
  els.nameInput.value = getState().profile.name;
  els.nameInput.addEventListener('input', () => {
    setNameQuiet(els.nameInput.value);
    renderProfile();
  });
}

if (els.pickBtn && els.fileInput) {
  els.pickBtn.addEventListener('click', () => els.fileInput.click());

  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = '';                // let the same file be picked twice
    if (!file) return;
    note('Adding…', 0);
    try {
      setAvatar(await loadPicture(file));
      note('Picture saved.');
    } catch (err) {
      note(err.message || 'That did not work.');
    }
  });

  els.clearBtn.addEventListener('click', () => {
    setAvatar(null);
    note('Picture removed.');
  });
}

/* ---------- audio settings ---------- */

for (const id of ['noise-volume', 'settings-volume']) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => setMasterVolume(Number(el.value)));
}

els.toggle.addEventListener('click', toggleSidebar);
els.scrim.addEventListener('click', closeDrawer);
els.trigger.addEventListener('click', () => openPalette());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (menuOpen()) { closeMenu(); return; }
    if (drawerOpen()) { closeDrawer(); return; }
  }

  if (!e.ctrlKey && !e.metaKey) return;

  if (e.key === '\\') {                    // toggle the sidebar
    e.preventDefault();
    toggleSidebar();
  } else if (e.key === ',') {              // open settings
    e.preventDefault();
    setView('settings');
  }
});

window.addEventListener('resize', () => {
  const app = document.getElementById('app');
  closeMenu();
  if (window.innerWidth > 860) {
    closeDrawer();
  } else {
    app.classList.remove('is-collapsed');   // narrow screens use the drawer
  }
});

subscribe(renderAll);

/* ---------- boot ---------- */

mountPomodoro();

/* apply persisted audio settings before the first paint, then push the
   real state into the module so loops and one-shots share one volume */
sound.setVolume(getState().settings.masterVolume);
sound.setEnabled(getState().settings.soundEnabled);

migrateTheme();       // rewrite unknown theme ids, then paint
renderAll();
setView('today');
probeBeds();          // async — fills in which .wav files are actually there

/* ---------- keyboard shortcut for task editing ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
  const row = e.target.closest('[data-task]');
  if (row) {
    e.preventDefault();
    editTaskFlow(row.dataset.task);
  }
});
