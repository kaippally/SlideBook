"""HELP.md — the one help file for the desktop app and StudioMate's Telegram Mini App — as HTML.

The file sits beside the exe (paths.HELP) and is read on every request, so editing it needs no rebuild.
A `<!-- for: a b -->` line before a heading tags that section (and everything under it) with the roles it
is for: everyone, send, photo, transcribe, slidebook, reports, owner, desktop. The desktop shows every
section; the Mini App asks with `?for=` holding the viewer's roles and gets only those sections.
Only the Markdown this file uses is understood: headings, paragraphs, lists, tables, bold, italics,
code and links."""
import html
import re

from paths import HELP

TAG = re.compile(r'^<!--\s*for:\s*([\w\s]+?)\s*-->$')


def _inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'(?<![\w*])\*([^*]+)\*(?![\w*])', r'<i>\1</i>', s)
    return re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', r'<a href="\2">\1</a>', s)


def _slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def _filter(lines, roles):
    """Drop every section whose tag names none of `roles` (None keeps everything)."""
    out, skip_level, pending = [], None, None
    for line in lines:
        m = TAG.match(line.strip())
        if m:
            pending = set(m[1].split())
            continue
        h = re.match(r'^(#{1,6}) ', line)
        if h:
            level = len(h[1])
            if skip_level is not None and level <= skip_level:
                skip_level = None
            if skip_level is None and pending is not None and roles is not None and not (pending & (roles | {'everyone'})):
                skip_level = level
            pending = None
        if skip_level is None:
            out.append(line)
    return out


def render(roles=None):
    """(title, body html, table of contents) for these roles — all of it when roles is None."""
    lines = _filter(HELP.read_text(encoding='utf-8').splitlines(), roles)
    title, parts, toc, i = 'Help', [], [], 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            i += 1
            continue
        h = re.match(r'^(#{1,6}) (.*)$', line)
        if h:
            level, text = len(h[1]), h[2].strip()
            if level == 1:
                title = text
            else:
                sid = _slug(text)
                if level == 2:
                    toc.append((sid, text))
                parts.append(f'<h{level} id="{sid}">{_inline(text)}</h{level}>')
            i += 1
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                    rows.append(cells)
                i += 1
            head, *body = rows
            parts.append('<table><thead><tr>' + ''.join(f'<th>{_inline(c)}</th>' for c in head) + '</tr></thead><tbody>'
                         + ''.join('<tr>' + ''.join(f'<td>{_inline(c)}</td>' for c in r) + '</tr>' for r in body) + '</tbody></table>')
            continue
        lm = re.match(r'^(\s*)([-*]|\d+\.) (.*)$', line)
        if lm:
            tag = 'ol' if lm[2][0].isdigit() else 'ul'
            items, depth0 = [], len(lm[1])
            while i < len(lines):
                m = re.match(r'^(\s*)([-*]|\d+\.) (.*)$', lines[i].rstrip())
                if not m:
                    break
                if len(m[1]) > depth0 and items:
                    items[-1][1].append(m[3])
                else:
                    items.append([m[3], []])
                i += 1
            parts.append(f'<{tag}>' + ''.join(f'<li>{_inline(t)}' + (('<ul>' + ''.join(f'<li>{_inline(s)}</li>' for s in sub) + '</ul>') if sub else '') + '</li>'
                                          for t, sub in items) + f'</{tag}>')
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#{1,6} |\||\s*([-*]|\d+\.) )', lines[i]) and not TAG.match(lines[i].strip()):
            para.append(lines[i].strip())
            i += 1
        parts.append(f'<p>{_inline(" ".join(para))}</p>')
    return title, '\n'.join(parts), toc


CSS = '''
* { box-sizing: border-box }
body { margin: 0; background: #0b0d12; color: #e2e8f0; font: 15px/1.6 'Segoe UI', system-ui, sans-serif }
main { max-width: 820px; margin: 0 auto; padding: 24px 28px 80px }
h1 { font-size: 24px; margin: 0 0 8px } h2 { font-size: 19px; margin: 30px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #334155 }
h3 { font-size: 16px; margin: 20px 0 6px; color: #cbd5e1 }
a { color: #38bdf8 } code { background: #1e293b; padding: 1px 5px; border-radius: 4px; font-size: 13px }
table { border-collapse: collapse; margin: 8px 0 14px; width: 100% } th, td { border: 1px solid #334155; padding: 6px 9px; text-align: left; vertical-align: top }
th { background: #111827 } li { margin: 3px 0 }
nav { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 10px 16px; margin: 14px 0 }
nav a { display: block; text-decoration: none; padding: 2px 0 }
'''


def page(roles=None):
    title, body, toc = render(roles)
    nav = '<nav>' + ''.join(f'<a href="#{sid}">{_inline(t)}</a>' for sid, t in toc) + '</nav>'
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            f'<title>{html.escape(title)}</title><style>{CSS}</style></head><body><main><h1>{_inline(title)}</h1>{nav}{body}</main></body></html>')
