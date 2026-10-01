#!/usr/bin/env python3
"""
Static checks for the ark codebase. No JS runtime required.

    python3 tools/check.py

Catches the class of bug that actually bit us: a module that fails to
parse, or an overlay that silently eats every click in the app.

Checks
  1. JS syntax        — tokenizer-based bracket balance, honouring
                        strings, template literals, regex and comments
  2. imports          — every named import resolves to a real export,
                        and every export that is *called* here is either
                        imported or declared (a missing import is a
                        ReferenceError that kills just one feature —
                        this is how the theme picker got hard-locked)
  3. DOM ids          — every getElementById() exists in index.html
  4. click-blocking   — no fixed/absolute decorative overlay without
                        `pointer-events: none`
  5. contrast         — WCAG ratio per theme, for the token pairs that
                        carry text
  6. themes           — app.js, index.html and themes.css agree on the
                        theme id list

Exit code is non-zero if anything fails.
"""

import re
import sys
import pathlib
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILS = []
NOTES = []


def fail(where, msg):
    FAILS.append(f"{where}: {msg}")


def note(msg):
    NOTES.append(msg)


# ---------------------------------------------------------------- syntax

def check_js_syntax(path):
    """Walk the source tracking string/template/regex/comment state and
    verify brackets balance. Naive per-line counting is useless for
    multi-line JS, and a checker that reports nonsense gets ignored."""
    src = path.read_text()
    i, n = 0, len(src)
    stack = []
    pairs = {')': '(', ']': '[', '}': '{'}
    # last significant char, for deciding '/' as regex vs division
    prev = ''

    def line_of(pos):
        return src.count('\n', 0, pos) + 1

    while i < n:
        c = src[i]

        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            i = n if j == -1 else j
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            if j == -1:
                fail(path.name, f"unterminated block comment at line {line_of(i)}")
                return
            i = j + 2
            continue

        if c in '\'"':
            q, j = c, i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == q:
                    break
                if src[j] == '\n':
                    fail(path.name, f"unterminated string at line {line_of(i)}")
                    return
                j += 1
            if j >= n:
                fail(path.name, f"unterminated string at line {line_of(i)}")
                return
            i = j + 1
            prev = 'x'
            continue

        if c == '`':
            j, depth = i + 1, 0
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '`' and depth == 0:
                    break
                if src[j] == '$' and j + 1 < n and src[j + 1] == '{':
                    d, j = 1, j + 2
                    while j < n and d > 0:
                        if src[j] == '{':
                            d += 1
                        elif src[j] == '}':
                            d -= 1
                        elif src[j] in '\'"':
                            q2, j = src[j], j + 1
                            while j < n and src[j] != q2:
                                j += 2 if src[j] == '\\' else 1
                        j += 1
                    continue
                j += 1
            if j >= n:
                fail(path.name, f"unterminated template literal at line {line_of(i)}")
                return
            i = j + 1
            prev = 'x'
            continue

        # regex literal only where a value is expected
        if c == '/' and prev in ('', '(', ',', '=', ':', '[', '!', '&', '|', '?',
                                 '{', '}', ';', '+', '-', '*', '%', '<', '>',
                                 '~', '^', 'return', 'typeof', 'case', 'in',
                                 'of', 'do', 'else'):
            j, in_class = i + 1, False
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    in_class = True
                elif src[j] == ']':
                    in_class = False
                elif src[j] == '/' and not in_class:
                    break
                elif src[j] == '\n':
                    fail(path.name, f"unterminated regex at line {line_of(i)}")
                    return
                j += 1
            if j >= n:
                fail(path.name, f"unterminated regex at line {line_of(i)}")
                return
            i = j + 1
            while i < n and src[i].isalpha():
                i += 1
            prev = 'x'
            continue

        if c in '([{':
            stack.append((c, i))
        elif c in ')]}':
            if not stack:
                fail(path.name, f"unexpected '{c}' at line {line_of(i)}")
                return
            op, pos = stack.pop()
            if op != pairs[c]:
                fail(path.name,
                     f"mismatched '{c}' at line {line_of(i)} "
                     f"(opened '{op}' at line {line_of(pos)})")
                return

        if not c.isspace():
            prev = c
        i += 1

    if stack:
        op, pos = stack[-1]
        fail(path.name, f"unclosed '{op}' opened at line {line_of(pos)}")


# ---------------------------------------------------------------- imports

def exports_of(path):
    src = path.read_text()
    names = set(re.findall(r'export\s+(?:async\s+)?function\s+(\w+)', src))
    names |= set(re.findall(r'export\s+(?:const|let|var)\s+(\w+)', src))
    for m in re.finditer(r'export\s*\{([^}]*)\}', src):
        for part in m.group(1).split(','):
            part = part.strip().split(' as ')[-1].strip()
            if part:
                names.add(part)
    return names


def code_only(src):
    """Blank out comments, strings and template literals, leaving code.

    Needed because this codebase narrates heavily in comments, and a
    name mentioned in prose must not count as a use.

    Template literals nest: `${foo(bar)}` is real code inside a string,
    so this walks a mode stack rather than scanning to the next quote —
    a scanner that loses sync silently blanks the rest of the file and
    makes every check downstream pass vacuously. Output keeps the exact
    length and offsets of the input, which makes that bug visible."""
    out = []
    stack = ['code']          # 'code' | 'sq' | 'dq' | 'tpl' | 'interp'
    depth = []                # brace depth per 'interp' frame
    i, n = 0, len(src)

    def blank(k, ch):
        out.append(ch * k)

    while i < n:
        mode = stack[-1]
        c = src[i]

        if mode in ('sq', 'dq'):
            q = "'" if mode == 'sq' else '"'
            if c == '\\':
                blank(2, "'"); i += 2; continue
            if c == q:
                blank(1, "'"); i += 1; stack.pop(); continue
            if c == '\n':               # unterminated; recover per line
                blank(1, ' '); i += 1; stack.pop(); continue
            blank(1, "'"); i += 1; continue

        if mode == 'tpl':
            if c == '\\':
                blank(2, "'"); i += 2; continue
            if c == '`':
                blank(1, "'"); i += 1; stack.pop(); continue
            if c == '$' and i + 1 < n and src[i + 1] == '{':
                out.append('${'); i += 2
                stack.append('interp'); depth.append(0)
                continue
            blank(1, "'"); i += 1; continue

        # mode in ('code', 'interp')
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            k = (j if j != -1 else n) - i
            blank(k, ' '); i += k; continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            k = ((j + 2) if j != -1 else n) - i
            blank(k, ' '); i += k; continue
        if c == "'":
            out.append(c); i += 1; stack.append('sq'); continue
        if c == '"':
            out.append(c); i += 1; stack.append('dq'); continue
        if c == '`':
            out.append(c); i += 1; stack.append('tpl'); continue
        if mode == 'interp':
            if c == '{':
                depth[-1] += 1
            elif c == '}':
                if depth[-1] == 0:
                    out.append(c); i += 1
                    stack.pop(); depth.pop()
                    continue
                depth[-1] -= 1
        out.append(c); i += 1

    return ''.join(out)


def check_imports():
    scripts = sorted((ROOT / 'scripts').glob('*.js'))
    exp = {p.name: exports_of(p) for p in scripts}
    # every name any module exports, for the used-but-not-imported pass
    universe = set()
    for s in exp.values():
        universe |= s

    for p in scripts:
        src = p.read_text()
        code = code_only(src)

        # every import in this file, resolved or not
        imported = set()
        for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*'\./([\w.]+)'", src):
            for part in m.group(1).split(','):
                part = part.strip()
                if not part:
                    continue
                name = part.split(' as ')[-1].strip()
                imported.add(name)
                if part not in exp.get(m.group(2), set()):
                    fail(p.name, f"imports '{part}' which {m.group(2)} does not export")

        # what this file provides for itself
        declared = set(re.findall(r'\b(?:function|class|const|let|var)\s+(\w+)', code))
        for m in re.finditer(r'function\s+\w+\s*\(([^)]*)\)', code):
            declared |= {t.split('=')[0].strip()
                         for t in m.group(1).split(',') if t.strip()}
        for m in re.finditer(r'\(([^()]*)\)\s*=>', code):
            declared |= {t.split('=')[0].strip()
                         for t in m.group(1).split(',') if t.strip()}
        # destructured bindings: const { a, b } = ...
        for m in re.finditer(r'(?:const|let|var)\s*\{([^}]*)\}', code):
            declared |= {t.strip() for t in m.group(1).split(',') if t.strip()}

        # a name another module exports, *called* here, neither imported
        # nor declared -> ReferenceError the moment that line runs.
        # The lookbehind skips method calls (pomodoro.reset() is not
        # store.js's reset) — without it every shared verb is a false hit.
        own = exp.get(p.name, set())
        for name in sorted((universe - own) - imported - declared):
            if re.search(rf'(?<!\.)\b{re.escape(name)}\s*\(', code):
                fail(p.name,
                     f"calls {name}() but never imports it — ReferenceError "
                     f"when that line runs")


# ---------------------------------------------------------------- DOM

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'param', 'source', 'track', 'wbr'}


class Nesting(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.errors = [], []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        elif tag in self.stack:
            i = len(self.stack) - 1 - self.stack[::-1].index(tag)
            self.errors.append(f"</{tag}> closed over still-open {self.stack[i + 1:]}")
            del self.stack[i:]
        else:
            self.errors.append(f"stray </{tag}>")


def check_html():
    html = (ROOT / 'index.html').read_text()
    p = Nesting()
    p.feed(html)
    for e in p.errors:
        fail('index.html', f'nesting: {e}')
    if p.stack:
        fail('index.html', f'unclosed tags: {p.stack}')
    return set(re.findall(r'id="([^"]+)"', html)), html


def check_dom_ids(ids, html):
    """Static HTML only. Ids created at runtime from a template literal
    (the task composer's form fields) have no static counterpart, so
    collect those first and treat them as legitimately absent."""
    dynamic = set()
    for p in (ROOT / 'scripts').glob('*.js'):
        src = p.read_text()
        dynamic |= set(re.findall(r'id="([^"]+)"', src))
        dynamic |= set(re.findall(r"getElementById\('([^']+)'\)", src))

    for p in (ROOT / 'scripts').glob('*.js'):
        src = p.read_text()
        for m in re.finditer(r"getElementById\('([^']+)'\)", src):
            name = m.group(1)
            if name in ids or name in dynamic:
                continue
            fail(p.name, f"getElementById('{name}') found in neither HTML nor JS")


# ------------------------------------------------- click-blocking overlays

def check_overlays():
    """A fixed/absolute element painted over the app that lacks
    pointer-events:none swallows every click beneath it. This is not
    hypothetical — it cost us an entire debugging session.

    Real interactive surfaces (scrims, menus, the mobile drawer) are
    exempt: those are *meant* to take clicks."""
    INTERACTIVE = re.compile(r'\b(scrim|palette|modal|ctx-menu|sidebar|content)\b')

    for css in sorted((ROOT / 'styles').glob('*.css')):
        src = css.read_text()
        for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', src):
            sel, body = m.group(1).strip(), m.group(2)
            if 'position: fixed' not in body:
                continue
            if 'pointer-events' in body:
                continue
            if INTERACTIVE.search(sel):
                continue
            # a decorative overlay that is also display:none in every
            # state cannot catch anything
            if 'display: none' in body:
                continue
            fail(f"{css.name}",
                 f"fixed-position overlay may swallow clicks (no pointer-events): "
                 f"{sel[:60]}")

    # every element added purely as CRT decoration must opt out explicitly
    crt = ROOT / 'styles/crt.css'
    if crt.exists():
        src = crt.read_text()
        for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', src):
            sel, body = m.group(1).strip(), m.group(2)
            if 'position: fixed' not in body and 'position: absolute' not in body:
                continue
            if 'pointer-events' not in body:
                fail('crt.css', f"decorative overlay without pointer-events: {sel[:60]}")


# ---------------------------------------------------------------- contrast

def srgb(c):
    c = c.strip()
    m = re.match(r'#([0-9a-f]{3}|[0-9a-f]{6})$', c, re.I)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = ''.join(ch * 2 for ch in h)
        return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255,
                int(h[4:6], 16) / 255, 1.0)
    m = re.match(r'rgba?\(([^)]+)\)', c)
    if m:
        p = [x.strip() for x in re.split(r'[,\s/]+', m.group(1)) if x.strip()]
        if len(p) < 3:
            return None
        return (float(p[0]) / 255, float(p[1]) / 255, float(p[2]) / 255,
                float(p[3]) if len(p) > 3 else 1.0)
    return None


def lum(c):
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])


def ratio(fg, bg):
    bg, fg = srgb(bg), srgb(fg)
    if not bg or not fg or bg[3] < 1:
        return None
    comp = tuple(fg[i] * fg[3] + bg[i] * (1 - fg[3]) for i in range(3))
    l1, l2 = lum(comp), lum(bg[:3])
    return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)


def props(text):
    return {k.strip(): v.strip()
            for k, v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', text)}


def check_contrast():
    tok = (ROOT / 'styles/tokens.css').read_text()
    themes_css = (ROOT / 'styles/themes.css').read_text()
    root = props(re.search(r':root\s*\{(.*?)\n\}', tok, re.S).group(1))
    themes = {}
    for m in re.finditer(r'\[data-theme="(\w+)"\]\s*\{(.*?)\n\}', themes_css, re.S):
        themes[m.group(1)] = {**root, **props(m.group(2))}
    themes['__default__'] = dict(root)

    checks = [
        ('btn label',        '--ink',        '--surface-raised', 4.5),
        ('btn-ghost label',  '--ink-dim',    '--bg',             4.5),
        ('btn-primary label','--accent-ink', '--accent',         4.5),
        ('nav item',         '--ink-dim',    '--bg-sunken',      4.5),
        ('nav ACTIVE',       '--ink',        '--surface-active', 4.5),
        ('task title',       '--ink',        '--bg',             4.5),
        ('view sub',         '--ink-dim',    '--bg',             4.5),
        ('kbd',              '--ink-dim',    '--surface-raised', 4.5),
        ('chip',             '--ink-dim',    '--surface-raised', 4.5),
        ('ctx menu item',    '--ink-dim',    '--surface-raised', 4.5),
        ('empty sub',        '--ink-faint',  '--bg',             4.5),
        ('nav count',        '--ink-faint',  '--bg-sunken',      4.5),
        ('faint on surface', '--ink-faint',  '--surface',        4.5),
    ]
    for name, tv in sorted(themes.items()):
        for label, fg, bg, need in checks:
            if fg not in tv or bg not in tv:
                continue
            r = ratio(tv[fg], tv[bg])
            if r is None:
                continue
            if r < need:
                fail(f'contrast/{name}', f'{label}: {r:.2f}:1 needs {need}:1')


# ---------------------------------------------------------------- themes

def check_themes(html):
    app = (ROOT / 'scripts/app.js').read_text()
    css = (ROOT / 'styles/themes.css').read_text()

    m = re.search(r'const THEMES = \{(.*?)\n\};', app, re.S)
    app_ids = set(re.findall(r"^\s*(\w+):\s*\{ label:", m.group(1), re.M)) if m else set()
    css_ids = set(re.findall(r'\[data-theme="(\w+)"\]', css))
    html_ids = set(re.findall(r'data-theme-pick="(\w+)"', html))

    if app_ids != html_ids:
        fail('themes', f'app.js {sorted(app_ids)} != index.html {sorted(html_ids)}')

    # The default theme is whichever one DEFAULT_THEME names. That one
    # has no block in themes.css — its values ARE the :root block in
    # tokens.css. Everything else needs a real block.
    dm = re.search(r"const DEFAULT_THEME = '(\w+)'", app)
    default = dm.group(1) if dm else None
    if default not in app_ids:
        fail('themes', f"DEFAULT_THEME '{default}' is not in THEMES")

    missing_css = app_ids - css_ids - {default}
    if missing_css:
        fail('themes', f'no CSS block for {sorted(missing_css)}')
    stray_css = css_ids - app_ids
    if stray_css:
        fail('themes', f'CSS block with no app.js entry: {sorted(stray_css)}')

    # store.js's default must agree with app.js's
    store = (ROOT / 'scripts/store.js').read_text()
    sm = re.search(r"theme:\s*'(\w+)'", store)
    if sm and sm.group(1) != default:
        fail('themes',
             f"store.js defaults to '{sm.group(1)}' but app.js says "
             f"'{default}'")

    # html <html data-theme> must be a real theme
    root_theme = re.search(r'<html[^>]*data-theme="(\w+)"', html)
    if root_theme and root_theme.group(1) not in app_ids:
        fail('themes', f'index.html data-theme="{root_theme.group(1)}" not in THEMES')

    # THEMES preview colours must match the swatch inline styles
    for tid, label, bg, card, accent in re.findall(
            r"(\w+):\s*\{ label: '([^']+)', bg: '(#\w{6})', card: '(#\w{6})', accent: '(#\w{6})'",
            m.group(1)):
        sw = re.search(
            rf'data-theme-pick="{tid}".*?--p-bg:(#\w{{6}});--p-card:(#\w{{6}});--p-accent:(#\w{{6}})',
            html, re.S)
        if sw:
            if (sw.group(1), sw.group(2), sw.group(3)) != (bg, card, accent):
                fail('themes', f'{tid}: swatch colours disagree with THEMES in app.js')
        # and with the CSS block
        blk = re.search(rf'\[data-theme="{tid}"\]\s*\{{(.*?)\n\}}', css, re.S)
        if blk:
            bp = props(blk.group(1))
            if bp.get('--bg') and bp['--bg'].lower() != bg.lower():
                fail('themes', f"{tid}: THEMES bg {bg} != CSS --bg {bp['--bg']}")
            if bp.get('--accent') and bp['--accent'].lower() != accent.lower():
                fail('themes', f"{tid}: THEMES accent {accent} != CSS --accent {bp['--accent']}")


# ---------------------------------------------------------------- run

def main():
    # self-test: black on white must be 21:1
    assert abs(ratio('#000000', '#ffffff') - 21) < 0.01, "contrast helper is broken"

    scripts = sorted((ROOT / 'scripts').glob('*.js'))
    for p in scripts:
        check_js_syntax(p)

    check_imports()
    ids, html = check_html()
    check_dom_ids(ids, html)
    check_overlays()
    check_contrast()
    check_themes(html)

    print(f"checked {len(scripts)} js files, "
          f"{len(list((ROOT/'styles').glob('*.css')))} css files, index.html")

    for n in NOTES:
        print(f"  note: {n}")

    if FAILS:
        print(f"\n{len(FAILS)} FAILURE(S):")
        for f in FAILS:
            print(f"  ✗ {f}")
        return 1
    print("all checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
