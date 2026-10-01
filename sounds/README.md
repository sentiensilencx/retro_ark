# sounds/

Drop your recordings here. Everything is coded against the names in the
`FILES` map at the top of `scripts/audio.js` — no other change needed.

Each entry carries its own explicit filename, so **.wav and .mp3 mix
freely**. Use whichever you actually recorded. Several ids can point at
one file when a single recording does more than one job.

## What's wired up

| id | file | plays when |
|---|---|---|
| `ring` | `ring.wav` | pomodoro phase ends **on its own** |
| `pomo` | `turn-on-pomodoro-timer-button.mp3` | you **start** the timer |
| `done` | `scratch-off-task-as-completed.mp3` | you tick a task off |
| `click` | `click.mp3` | nav, folders, theme, composer, un-ticking, noise cards, **pause / skip / reset / unpin**, editing the clock |
| `open` / `close` | `click.mp3` | command palette opens / closes |
| `move` | `click.mp3` | folder deleted |

Starting the timer is deliberately distinct from pausing it — turning
something on gets the switch-on thunk, everything else is an ordinary
click. Sounds live inside the engine functions rather than on the
buttons, so the context menus and `Ctrl+Q` commands get them too.

`click.mp3` does most of the work, so it plays often — that reads as
tactile rather than noisy, but drop it out of `FILES` if it grates.

## Still to add — noise beds

These are `bed: true` and appear on the **Noise** page as looping beds:

| filename | card |
|---|---|
| `rain.wav` | Rain |
| `pink.wav` | Pink noise |
| `brown.wav` | Brown noise |

Without them the Noise page shows three dashed **"not found"** cards and
stays disabled, which is deliberate — a bed you can't play shouldn't look
broken.

## Behaviour

Missing files never break the app. One-shots log a single `console.info`
and stay silent; beds show a disabled "not found" card. The Noise page
probes each bed once on load, so dropping a file in and reloading is
enough to light that card up.

Volume and the on/off switch live on the Noise page **and** under
Settings → App; both persist to localStorage.

To rename or add a sound, edit the `FILES` map — that's the only place
filenames are declared. Anything with `bed: true` also shows up in the
command palette as `Noise: <name>`.
