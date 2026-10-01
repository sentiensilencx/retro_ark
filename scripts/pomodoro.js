/* ============================================================
   ark — pomodoro
   25 → 5 → 25 → 15, then loops.
   Ring depletes as time runs down. Double-click the clock to
   change the length of the current phase.

   Pin a task and both focus blocks take that task's urgency
   length — 25 / 40 / 50 minutes — and the ring takes its colour.
   ============================================================ */

import { sound } from './audio.js';
import { getState, subscribe, setFocusTask, urgencyInfo } from './store.js';

const RADIUS = 110;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;   // 691.15

const phases = [
  { label: 'Focus',       seconds: 25 * 60, tone: 'accent' },
  { label: 'Short break', seconds: 5 * 60,  tone: 'blue'   },
  { label: 'Focus',       seconds: 25 * 60, tone: 'accent' },
  { label: 'Long break',  seconds: 15 * 60, tone: 'violet' },
];

const MIN_SECONDS = 10;
const MAX_SECONDS = 180 * 60;

let index = 0;
let total = phases[0].seconds;
let remaining = total;
let running = false;
let endAt = 0;
let ticker = null;
let editing = false;

const el = {};

/* ---------- helpers ---------- */

function formatTime(s) {
  const secs = Math.max(0, Math.round(s));
  const m = Math.floor(secs / 60);
  const r = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function parseTime(input) {
  const raw = String(input).trim();
  if (!raw) return null;

  let seconds;
  if (raw.includes(':')) {
    const [m, s] = raw.split(':').map((n) => parseInt(n, 10));
    if (Number.isNaN(m) || Number.isNaN(s)) return null;
    seconds = m * 60 + s;
  } else {
    const m = parseInt(raw, 10);
    if (Number.isNaN(m)) return null;
    seconds = m * 60;
  }

  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) return null;
  return seconds;
}

/* ---------- what we're timing ---------- */

function currentTarget() {
  const s = getState();
  if (!s.focusTaskId) return null;
  return s.tasks.find((t) => t.id === s.focusTaskId) ?? null;
}

/* Only re-bases the clock when the pinned task or its urgency
   actually changes, so a session you've already started keeps
   counting instead of resetting under you. */
let targetKey = null;

function syncTarget() {
  const t = currentTarget();
  const key = t ? `${t.id}:${t.urgency}` : '';
  if (key === targetKey) return;
  targetKey = key;

  const secs = (t ? urgencyInfo(t.urgency).focus : 25) * 60;
  const tone = t ? t.urgency : 'accent';

  phases[0].seconds = secs;
  phases[2].seconds = secs;
  phases[0].tone = tone;
  phases[2].tone = tone;

  // sitting on a focus block? re-base the clock at its new length
  if (index === 0 || index === 2) {
    total = secs;
    remaining = secs;
    if (running) endAt = Date.now() + remaining * 1000;
  }
  render();
}

/* ---------- render ---------- */

function render() {
  if (!el.time || !el.ring || !el.fill || !el.cycle) return;

  el.time.textContent = formatTime(remaining);
  el.phase.textContent = phases[index].label;
  el.ring.dataset.tone = phases[index].tone;

  const progress = total > 0 ? remaining / total : 0;
  el.fill.style.strokeDasharray = CIRCUMFERENCE;
  el.fill.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);

  el.start.textContent = running ? 'Pause' : (remaining === total ? 'Start' : 'Resume');

  el.cycle.querySelectorAll('[data-phase]').forEach((row) => {
    const i = Number(row.dataset.phase);
    row.classList.toggle('is-current', i === index);

    // keep the focus rows' dots in step with the ring
    const dot = row.querySelector('.dot');
    if (dot && (i === 0 || i === 2)) {
      dot.dataset.color = phases[i].tone === 'gray' ? 'accent' : phases[i].tone;
    }
  });

  el.cycle.querySelectorAll('[data-phase-time]').forEach((span) => {
    const i = Number(span.dataset.phaseTime);
    span.textContent = formatTime(phases[i].seconds);
  });

  renderTarget();
  renderHeader();
}

function renderTarget() {
  if (!el.targetTask) return;
  const t = currentTarget();

  el.targetEmpty.hidden = !!t;
  el.targetTask.hidden = !t;
  if (!t) return;

  el.targetTitle.textContent = t.title;
  el.targetDot.dataset.u = t.urgency;
  el.targetFocus.textContent = `${urgencyInfo(t.urgency).focus} min focus`;
}

function describePhase(s) {
  return s % 60 === 0 ? String(s / 60) : formatTime(s);
}

function renderHeader() {
  if (!el.sub) return;
  el.sub.textContent =
    `${describePhase(phases[0].seconds)} → ${describePhase(phases[1].seconds)} → ` +
    `${describePhase(phases[2].seconds)} → ${describePhase(phases[3].seconds)}, then loop.`;
}

/* ---------- engine ---------- */

function tick() {
  remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  if (remaining <= 0) advance(true);
  render();
}

function start() {
  if (running) return;
  running = true;
  endAt = Date.now() + remaining * 1000;
  ticker = setInterval(tick, 250);
  render();
}

function pause() {
  if (!running) return;
  running = false;
  clearInterval(ticker);
  ticker = null;
  render();
}

/* Starting gets its own recording — the switch-on thunk. Pausing is a
   quieter, ordinary click: you're not turning anything on. */
function toggle() {
  if (running) { sound.play('click'); pause(); }
  else { sound.play('pomo'); start(); }
}

function advance(natural = false) {
  const wasRunning = running;
  clearInterval(ticker);
  ticker = null;
  running = false;

  // a phase that ends on its own rings the bell; a manual skip is just a click
  if (natural) sound.play('ring');
  else sound.play('click');

  index = (index + 1) % phases.length;
  total = phases[index].seconds;
  remaining = total;

  // a natural end keeps the flow going; skipping keeps it going too
  // if you were already running, but stops if you were paused.
  if (natural || wasRunning) start();
  else render();
}

function reset() {
  const wasRunning = running;
  pause();
  remaining = total;
  if (wasRunning || total !== phases[index].seconds) sound.play('click');
  render();
}

function setPhaseLength(seconds) {
  phases[index].seconds = seconds;
  total = seconds;
  remaining = seconds;
  if (running) endAt = Date.now() + remaining * 1000;
  render();
}

/* ---------- inline editing ---------- */

function beginEdit() {
  if (editing) return;
  editing = true;
  pause();

  const input = document.createElement('input');
  input.className = 'pomo-edit';
  input.value = formatTime(total);
  input.setAttribute('aria-label', 'Phase length');
  input.spellcheck = false;

  el.time.replaceWith(input);
  input.focus();
  input.select();

  let closed = false;
  const close = (commit) => {
    if (closed) return;
    closed = true;

    if (commit) {
      const parsed = parseTime(input.value);
      if (parsed === null) {
        // bad input — shake it back and keep editing
        input.style.borderColor = 'var(--danger)';
        setTimeout(() => { input.style.borderColor = ''; }, 400);
        input.select();
        closed = false;
        return;
      }
      // only acknowledge a change that actually changes something
      if (parsed !== phases[index].seconds) sound.play('click');
      setPhaseLength(parsed);
    } else {
      render();
    }

    editing = false;
    input.replaceWith(el.time);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); close(true); }
    else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    e.stopPropagation();
  });

  input.addEventListener('blur', () => close(true));
}

/* ---------- mount ---------- */

export function mountPomodoro() {
  el.ring  = document.getElementById('pomo-ring');
  el.fill  = el.ring?.querySelector('.ring-fill');
  el.time  = document.getElementById('pomo-time');
  el.phase = document.getElementById('pomo-phase');
  el.cycle = document.getElementById('pomo-cycle');
  el.start = document.getElementById('pomo-start');
  el.skip  = document.getElementById('pomo-skip');
  el.reset = document.getElementById('pomo-reset');

  el.targetEmpty = document.getElementById('pomo-target-empty');
  el.targetTask  = document.getElementById('pomo-target-task');
  el.targetTitle = document.getElementById('pomo-target-title');
  el.targetDot   = document.getElementById('pomo-target-dot');
  el.targetFocus = document.getElementById('pomo-target-focus');
  el.unpin       = document.getElementById('pomo-unpin');
  el.sub         = document.querySelector('[data-sub="pomodoro"]');

  if (!el.ring || !el.time) return;

  el.start.addEventListener('click', toggle);
  el.skip.addEventListener('click', () => advance(false));
  el.reset.addEventListener('click', reset);
  el.unpin?.addEventListener('click', () => { sound.play('click'); setFocusTask(null); });

  el.time.addEventListener('dblclick', () => { sound.play('click'); beginEdit(); });
  el.time.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      sound.play('click');
      beginEdit();
    }
  });

  syncTarget();
  render();
  subscribe(syncTarget);   // pick up pin / unpin / urgency edits
}

export const pomodoro = {
  toggle,
  start,
  pause,
  reset,
  skip: () => advance(false),
  get running() { return running; },
  get remaining() { return remaining; },
  get label() { return phases[index].label; },
};
