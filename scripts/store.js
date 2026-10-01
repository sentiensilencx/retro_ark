/* ============================================================
   ark — store
   localStorage today, Supabase tomorrow.

   Nothing else in the app reads storage directly. When Supabase
   lands, only the read/write functions at the bottom change —
   the public API (getState, subscribe, mutate) stays identical.
   ============================================================ */

const STORAGE_KEY = 'ark.v1';

const DEFAULT_STATE = {
  profile: {
    name: '',              // display name — blank until you set one
    avatar: null,          // object URL or Supabase public URL
  },
  folders: [
    { id: 'f-personal', name: 'Personal',   color: 'pink' },
    { id: 'f-study',    name: 'Study',      color: 'blue' },
    { id: 'f-side',     name: 'Side things', color: 'violet' },
  ],
  tasks: [],
  focusTaskId: null,       // which task the pomodoro is timing, if any
  settings: {
    theme: 'ember',
    soundEnabled: true,
    masterVolume: 0.6,
  },
};

/* Urgency does two jobs: how loud the task looks, and how long a
   focus block on it lasts. Gray is the default and means "nothing
   special" — it keeps the ordinary 25 minute cycle. */
export const URGENCY = [
  { id: 'gray',  label: 'Not urgent', focus: 25 },
  { id: 'amber', label: 'Soon',       focus: 40 },
  { id: 'red',   label: 'Now',        focus: 50 },
];

export function urgencyInfo(id) {
  return URGENCY.find((u) => u.id === id) ?? URGENCY[0];
}

/* ---------- lifecycle ---------- */

let state = read();
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const saved = JSON.parse(raw);
    const data = { ...structuredClone(DEFAULT_STATE), ...saved };

    // The spread above only replaces top-level keys, so a save from an
    // older build that carried a partial `settings` or `profile` object
    // would drop every key it didn't happen to have. Merge those two by
    // hand, or the app boots with undefined volume and a NaN label.
    data.settings = { ...DEFAULT_STATE.settings, ...(saved.settings ?? {}) };
    data.profile  = { ...DEFAULT_STATE.profile,  ...(saved.profile  ?? {}) };

    // early builds defaulted the display name to the placeholder "you",
    // which reads badly next to the avatar — treat it as unset.
    if (data.profile.name === 'you') data.profile.name = '';

    // a saved 0 is a real volume, but NaN/garbage is not
    if (!Number.isFinite(data.settings.masterVolume)) {
      data.settings.masterVolume = DEFAULT_STATE.settings.masterVolume;
    }

    // tasks saved before urgency existed are all the default level
    data.tasks = (data.tasks ?? []).map((t) => ({
      urgency: 'gray', completedAt: null, ...t,
    }));
    if (data.focusTaskId === undefined) data.focusTaskId = null;

    return data;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

/* Local date key — everything that compares dates uses this, so the
   app and the composer never disagree about what "today" is. */
export function todayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function write() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[ark] could not persist state:', err);
  }
}

function emit() {
  listeners.forEach((fn) => {
    try { fn(state); } catch (err) { console.error('[ark] listener failed:', err); }
  });
}

/* ---------- public API ---------- */

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function mutate(fn) {
  fn(state);
  write();
  emit();
  return state;
}

export function reset() {
  state = structuredClone(DEFAULT_STATE);
  write();
  emit();
}

/* ---------- folders ---------- */

export const FOLDER_COLORS = ['pink', 'red', 'blue', 'violet', 'amber', 'mint', 'teal', 'orange'];

export function nextFolderColor() {
  const used = new Set(state.folders.map((f) => f.color));
  return FOLDER_COLORS.find((c) => !used.has(c)) ?? FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length];
}

export function addFolder(name, color = nextFolderColor()) {
  const folder = { id: `f-${Date.now().toString(36)}`, name: name.trim() || 'Untitled', color };
  mutate((s) => s.folders.push(folder));
  return folder;
}

export function removeFolder(id) {
  mutate((s) => {
    s.folders = s.folders.filter((f) => f.id !== id);
    s.tasks = s.tasks.filter((t) => t.folderId !== id);
  });
}

export function renameFolder(id, name) {
  const clean = String(name ?? '').trim();
  if (!clean) return;
  mutate((s) => {
    const f = s.folders.find((x) => x.id === id);
    if (f) f.name = clean;
  });
}

/* no colour passed = step to the next one; pass one to set it directly */
export function recolorFolder(id, color) {
  mutate((s) => {
    const f = s.folders.find((x) => x.id === id);
    if (!f) return;
    if (color && FOLDER_COLORS.includes(color)) {
      f.color = color;
      return;
    }
    const i = FOLDER_COLORS.indexOf(f.color);
    f.color = FOLDER_COLORS[(i + 1) % FOLDER_COLORS.length];
  });
}

export function setAvatar(dataUrl) {
  mutate((s) => { s.profile.avatar = dataUrl || null; });
}

export function setName(name) {
  mutate((s) => { s.profile.name = String(name ?? '').trim(); });
}

export function getFolder(id) {
  return state.folders.find((f) => f.id === id) ?? null;
}

/* ---------- tasks ---------- */

let seq = 0;
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function addTask({ title, folderId = null, due = null, urgency = 'gray' }) {
  const task = {
    id: uid('t'),
    title: title.trim(),
    folderId,
    due,                 // local ISO date string or null
    urgency: urgencyInfo(urgency).id,
    done: false,
    createdAt: Date.now(),
  };
  mutate((s) => s.tasks.push(task));
  return task;
}

export function toggleTask(id) {
  mutate((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
  });
}

export function removeTask(id) {
  mutate((s) => { s.tasks = s.tasks.filter((t) => t.id !== id); });
}

export function setUrgency(id, urgency) {
  mutate((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (t) t.urgency = urgencyInfo(urgency).id;
  });
}

/** Move a task to a folder (pass null to take it out of every folder). */
export function setTaskFolder(id, folderId) {
  const valid = folderId === null
    || state.folders.some((f) => f.id === folderId);
  if (!valid) return;
  mutate((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (t) t.folderId = folderId ?? null;
  });
}

/** Pin a task to the pomodoro (pass null to go back to the default cycle). */
export function setFocusTask(id) {
  mutate((s) => { s.focusTaskId = s.tasks.some((t) => t.id === id) ? id : null; });
}

export function updateTask(id, changes) {
  mutate((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return;
    if (changes.title !== undefined) t.title = changes.title.trim();
    if (changes.due !== undefined) t.due = changes.due;
    if (changes.folderId !== undefined) t.folderId = changes.folderId;
    if (changes.urgency !== undefined) t.urgency = urgencyInfo(changes.urgency).id;
  });
}

export function counts() {
  const open = state.tasks.filter((t) => !t.done);
  const today = todayKey();
  return {
    today: open.filter((t) => !t.due || t.due <= today).length,
    upcoming: open.filter((t) => t.due && t.due > today).length,
    all: state.tasks.length,
    folders: state.folders.length,
  };
}
