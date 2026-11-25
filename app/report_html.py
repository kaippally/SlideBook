"""A Claude-written report as one HTML page, laid out for a phone: 420 px wide pages, large type flowing
page to page, every point with a colour tag, its speaker and a linked timestamp, and the video frames
Claude chose for context. The Reports tab shows this page and StudioMate's bot prints it to PDF — one
renderer, so the screen and the PDF never drift apart."""
import html
import re
import time

TAG_COLOR = [
    (r'FALSE|DODGE|CONTRADICT|WRONG|ERROR|OMISSION', '#dc2626'), (r'MISLEAD', '#ea580c'), (r'PARTLY|PARTIAL|UNEVEN|WEAK', '#ca8a04'),
    (r'FALLAC|BIAS', '#7c3aed'), (r'TRUE|ANSWERED|STRONG|FAIR|RIGHT|CONCED', '#16a34a'), (r'UNPROVEN|UNFALSIF', '#64748b'),
]
FACES = {'Regular': 400, 'SemiBold': 600, 'Bold': 700, 'ExtraBold': 800}


def _e(s):
    return html.escape(str(s or ''), quote=True)


def _secs(v):
    n = 0
    for part in str(v or '').split(':'):
        n = n * 60 + (int(part) if part.isdigit() else 0)
    return n


def _clock(sec):
    s = int(sec)
    return f'{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}' if s >= 3600 else f'{s // 60}:{s % 60:02d}'


def _color(tag):
    return next((c for pat, c in TAG_COLOR if re.search(pat, tag or '', re.I)), '#0369a1')


CSS = '''
@page { size: 420px 747px; margin: 26px 22px 34px }
* { box-sizing: border-box }
html, body { margin: 0; background: #fff; color: #0f172a; font-family: 'Noto Sans Malayalam', 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.5; overflow-wrap: anywhere }
body.screen { max-width: 460px; margin: 0 auto; padding: 24px 20px 60px }
h1 { font-size: 25px; line-height: 1.2; margin: 0 0 6px; font-weight: 800 }
.sub { color: #475569; font-size: 15px; margin: 0 0 6px }
.src { font-size: 12px; color: #64748b; margin-bottom: 12px }
.src a { color: #0369a1 }
.cover { width: 100%; border-radius: 10px; margin: 0 0 14px; display: block }
.summary { background: #f1f5f9; border-radius: 10px; padding: 12px 14px; margin: 0 0 18px }
.summary p { margin: 0 0 8px } .summary p:last-child { margin: 0 }
h2 { font-size: 20px; margin: 22px 0 10px; padding-bottom: 4px; border-bottom: 3px solid #0f172a; break-after: avoid }
.intro { color: #334155; margin: 0 0 10px }
.item { border-left: 5px solid var(--c); padding: 2px 0 2px 12px; margin: 0 0 16px; break-inside: avoid }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; margin-bottom: 3px }
.tag { background: var(--c); color: #fff; font-weight: 800; letter-spacing: .04em; padding: 1px 8px; border-radius: 999px; font-size: 12px }
.who { font-weight: 700; color: #334155 }
.time { font: 700 13px Consolas, monospace; color: #0369a1; text-decoration: none; border-bottom: 1.5px solid #0369a1 }
.headline { font-weight: 700; font-size: 17px; line-height: 1.3; margin-bottom: 3px }
.text { color: #1e293b }
.frame { width: 100%; border-radius: 8px; margin: 8px 0 2px; display: block }
.conclusion { margin-top: 22px; padding: 12px 14px; border-radius: 10px; background: #0f172a; color: #f8fafc; break-inside: avoid }
.conclusion b { display: block; margin-bottom: 4px; letter-spacing: .06em; font-size: 13px; color: #94a3b8 }
.ask { margin: 0 0 14px; font-size: 12px; color: #64748b; font-style: italic }
'''


def render(rep, url='', video_id=None, made_at=None, request='', screen=False):
    def link(t):
        return f'https://www.youtube.com/watch?v={video_id}&t={_secs(t)}s' if video_id and t else ''

    def when(it):
        if not it.get('t'):
            return ''
        label = f'▶ {_clock(_secs(it["t"]))}' + (f'–{_clock(_secs(it["tEnd"]))}' if it.get('tEnd') else '')
        href = link(it['t'])
        return f'<a class="time" href="{_e(href)}">{_e(label)}</a>' if href else f'<span class="time">{_e(label)}</span>'

    def item(it):
        meta = (f'<span class="tag">{_e(it["tag"])}</span>' if it.get('tag') else '') + \
               (f'<span class="who">{_e(it["speaker"])}</span>' if it.get('speaker') else '') + when(it)
        img = f'<img class="frame" src="{_e(it["image"])}" alt="">' if it.get('image') else ''
        return (f'<div class="item" style="--c:{_color(it.get("tag"))}"><div class="meta">{meta}</div>'
                f'<div class="headline">{_e(it.get("headline"))}</div>{img}<div class="text">{_e(it.get("text"))}</div></div>')

    faces = '\n'.join(f"@font-face {{ font-family: 'Noto Sans Malayalam'; font-weight: {w}; src: url('/api/titles/fonts/NotoSansMalayalam-{n}.ttf') }}"
                      for n, w in FACES.items())
    sections = ''.join(f'<section><h2>{_e(s.get("heading"))}</h2>' + (f'<p class="intro">{_e(s["intro"])}</p>' if s.get('intro') else '')
                       + ''.join(item(it) for it in s.get('items') or []) + '</section>' for s in rep.get('sections') or [])
    stamp = time.strftime('%Y-%m-%d %H:%M', time.localtime(made_at or time.time()))
    summary = ''.join(f'<p>{_e(p)}</p>' for p in rep.get('summary') or [])
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{_e(rep.get("title"))}</title>
{'<base target="_blank">' if screen else ''}<style>{faces}{CSS}</style></head><body class="{'screen' if screen else ''}">
<h1>{_e(rep.get("title"))}</h1>{f'<p class="sub">{_e(rep["subtitle"])}</p>' if rep.get('subtitle') else ''}
<div class="src">{f'<a href="{_e(url)}">{_e(url)}</a> · ' if url else ''}{_e(stamp)}</div>
{f'<p class="ask">Asked: {_e(request)}</p>' if request else ''}
{f'<img class="cover" src="{_e(rep["cover"])}" alt="">' if rep.get('cover') else ''}
{f'<div class="summary">{summary}</div>' if summary else ''}
{sections}
{f'<div class="conclusion"><b>CONCLUSION</b>{_e(rep["conclusion"])}</div>' if rep.get('conclusion') else ''}
</body></html>'''
