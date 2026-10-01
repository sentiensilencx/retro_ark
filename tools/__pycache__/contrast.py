#!/usr/bin/env python3
"""
Print the contrast table for every theme, and solve for replacement
values when something falls short.

    python3 tools/contrast.py          # report
    python3 tools/contrast.py --fix    # also print solved replacements

Contrast is checked against 4.5:1 (WCAG AA, normal text). Anything that
carries text must clear it *before* the CRT scanlines darken it further,
which is why the thresholds here are not negotiable.
"""

import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGET = 4.5


def props(text):
    return {k.strip(): v.strip()
            for k, v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', text)}


def hex2rgb(h):
    h = h.strip().lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def lin(v):
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4


def lum(c):
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])


def cr(a, b):
    la, lb = lum(hex2rgb(a)), lum(hex2rgb(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def tohex(c):
    return '#%02x%02x%02x' % tuple(round(v * 255) for v in c)


def solve(fg, bgs, toward):
    """Walk fg toward `toward` until it clears TARGET against every bg."""
    cur, tgt = hex2rgb(fg), hex2rgb(toward)
    for step in range(401):
        f = step / 400
        cand = [cur[i] + (tgt[i] - cur[i]) * f for i in range(3)]
        if all(cr(tohex(cand), b) >= TARGET for b in bgs):
            return tohex(cand)
    return fg


def load():
    tok = (ROOT / 'styles/tokens.css').read_text()
    css = (ROOT / 'styles/themes.css').read_text()
    root = props(re.search(r':root\s*\{(.*?)\n\}', tok, re.S).group(1))
    themes = {'__default__': dict(root)}
    for m in re.finditer(r'\[data-theme="(\w+)"\]\s*\{(.*?)\n\}', css, re.S):
        themes[m.group(1)] = {**root, **props(m.group(2))}
    return themes


CHECKS = [
    ('btn label',        '--ink',        '--surface-raised'),
    ('btn-ghost label',  '--ink-dim',    '--bg'),
    ('btn-primary label','--accent-ink', '--accent'),
    ('nav item',         '--ink-dim',    '--bg-sunken'),
    ('nav ACTIVE',       '--ink',        '--surface-active'),
    ('task title',       '--ink',        '--bg'),
    ('view sub',         '--ink-dim',    '--bg'),
    ('kbd',              '--ink-dim',    '--surface-raised'),
    ('chip',             '--ink-dim',    '--surface-raised'),
    ('ctx menu item',    '--ink-dim',    '--surface-raised'),
    ('empty sub',        '--ink-faint',  '--bg'),
    ('nav count',        '--ink-faint',  '--bg-sunken'),
    ('faint on surface', '--ink-faint',  '--surface'),
]

# which token groups need solving against which backgrounds
FAINT_BGS = ['--bg', '--bg-sunken', '--surface', '--surface-raised',
             '--surface-active', '--surface-hover']
DIM_BGS = ['--bg', '--bg-sunken', '--surface', '--surface-hover']


def main():
    assert abs(cr('#000000', '#ffffff') - 21) < 0.01, "helper broken"

    themes = load()
    names = list(themes)

    print(f"{'element':20}" + ''.join(f"{n:>13}" for n in names))
    print('-' * (20 + 13 * len(names)))

    short = []
    for label, fg, bg in CHECKS:
        row = ''
        for n in names:
            tv = themes[n]
            if fg not in tv or bg not in tv:
                row += f"{'?':>13}"
                continue
            r = cr(tv[fg], tv[bg])
            if r < TARGET:
                row += f"{r:>11.2f}!"
                short.append((n, label, r))
            else:
                row += f"{r:>13.2f}"
        print(f"{label:20}{row}")

    print(f"\n{'BELOW 4.5:1: ' + str(len(short)) if short else 'all pairs pass'}")
    for n, label, r in short:
        print(f"  ✗ {n:12} {label:20} {r:5.2f}")

    print("\n=== solved replacements ===")
    for n, tv in themes.items():
        for tok, bgs in (('--ink-faint', FAINT_BGS), ('--ink-dim', DIM_BGS)):
            vals = [tv[b] for b in bgs if b in tv]
            if not vals or tok not in tv:
                continue
            before = min(cr(tv[tok], b) for b in vals)
            new = solve(tv[tok], vals, tv['--ink'])
            after = min(cr(new, b) for b in vals)
            if after > before + 0.01:
                flag = '' if after >= TARGET else '   <-- STILL SHORT'
                print(f"{n:12} {tok:12} {tv[tok]:>8} -> {new}  ({before:.2f} -> {after:.2f}){flag}")

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
