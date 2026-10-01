/* ============================================================
   ark — audio
   Real .wav files from sounds/ only. No synthesized beeps.

   Anything missing stays silently silent — the app never throws
   because a sound asset hasn't been dropped in yet.
   ============================================================ */

const BASE = 'sounds/';

/* name → filename, and whether it's a looping bed or a one-shot.
   Edit here, not scattered through the app. `bed: true` entries are the
   ones the Noise page offers as toggleable loops.

   Each entry carries its own explicit path, so .wav and .mp3 mix freely
   — whatever you actually recorded is what plays. Several ids may point
   at one file when a single recording does more than one job. */
const FILES = {
  // looping noise beds — these are what the Noise page lists
  rain:    { file: 'rain.wav',  bed: true,  label: 'Rain',        color: 'blue' },
  pink:    { file: 'pink.wav',  bed: true,  label: 'Pink noise',  color: 'pink' },
  brown:   { file: 'brown.wav', bed: true,  label: 'Brown noise', color: 'violet' },

  // one-shots — the pomodoro bell and the ones you mixed yourself
  ring:    { file: 'ring.wav',                         bed: false, label: 'Bell', color: 'amber' },
  done:    { file: 'scratch-off-task-as-completed.mp3', bed: false, label: 'Done' },
  pomo:    { file: 'turn-on-pomodoro-timer-button.mp3', bed: false, label: 'Timer on' },

  // click.mp3 does double duty: general UI feedback, and the palette
  click:   { file: 'click.mp3', bed: false, label: 'Click' },
  open:    { file: 'click.mp3', bed: false, label: 'Palette open' },
  close:   { file: 'click.mp3', bed: false, label: 'Palette close' },
  move:    { file: 'click.mp3', bed: false, label: 'Move' },
};

const warned = new Set();
const loops = new Map();
let enabled = true;
let volume = 0.6;

function filename(name) {
  return FILES[name]?.file ?? null;
}

function warnOnce(name) {
  if (warned.has(name)) return;
  warned.add(name);
  console.info(`[ark] sounds/${filename(name)} not found — "${name}" will stay silent.`);
}

/** Returns an Audio element, or null when the name is unknown. */
function load(name) {
  const file = filename(name);
  if (!file) { warnOnce(name); return null; }

  const el = new Audio(BASE + file);
  el.preload = 'auto';
  el.volume = volume;

  el.addEventListener('error', () => {
    warnOnce(name);
    el.dataset.broken = '1';
  }, { once: true });

  return el;
}

export const sound = {
  /** One-shot — rings, clicks. Overlapping calls each get their own node. */
  play(name, { volume: v } = {}) {
    if (!enabled) return;
    const el = load(name);
    if (!el) return;
    if (typeof v === 'number') el.volume = clamp(v);
    el.play().catch(() => { /* autoplay blocked or missing file — fine */ });
  },

  /** Looping bed — rain, pink noise. Stops any existing loop of the same name. */
  loop(name, { volume: v } = {}) {
    if (!enabled) return;
    this.stop(name);
    const el = load(name);
    if (!el) return;
    el.loop = true;
    if (typeof v === 'number') el.volume = clamp(v);
    el.play().catch(() => {});
    loops.set(name, el);
  },

  stop(name) {
    const el = loops.get(name);
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    loops.delete(name);
  },

  stopAll() {
    loops.forEach((el) => { el.pause(); el.currentTime = 0; });
    loops.clear();
  },

  isLooping(name) {
    return loops.has(name);
  },

  /** Probe: does this asset exist? Useful for greying out the noise cards. */
  async has(name) {
    const file = filename(name);
    if (!file) return false;
    try {
      const res = await fetch(BASE + file, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  },

  /** Just the looping beds, with their labels and colours. */
  beds() {
    return Object.entries(FILES)
      .filter(([, f]) => f.bed)
      .map(([id, f]) => ({ id, ...f }));
  },

  /** Human-readable filename for a sound id — shown under each card. */
  filename,

  names: Object.keys(FILES),

  /* Settings are persisted by app.js into the store, so this stays a
     plain sound engine with no knowledge of localStorage. */
  setEnabled(on) { enabled = on; if (!on) this.stopAll(); },
  setVolume(v) {
    volume = clamp(v);
    loops.forEach((el) => { el.volume = volume; });
  },

  /** Which beds are playing right now — the view paints from this. */
  active() { return [...loops.keys()]; },

  get volume() { return volume; },
  get enabled() { return enabled; },
};

function clamp(n) { return Math.min(1, Math.max(0, n)); }
