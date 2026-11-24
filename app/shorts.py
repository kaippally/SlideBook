"""The Short builder: one video → its whole transcript → every short worth cutting, each one complete idea
edited to fit under three minutes → a vertical 1080x1920 render with styled subtitles, a title and sound
effects. Cuts are chosen in whole transcript lines, so a short never starts or stops mid-sentence, and its
length is known exactly before the finder's suggestion is accepted."""
import asyncio
import io
import json
import logging
import shutil
import subprocess
import threading
import time

import analysis
import core
import db
import videos
from paths import DATA, FONTS, MEDIA, SFX, USER_SFX, tool

log = logging.getLogger('slidebook.shorts')
NO_WINDOW = videos.NO_WINDOW
LIMIT = 179.0     # a Short must be under 3:00
TARGET = 170.0    # what the finder aims for, so a small adjustment afterwards still fits
MIN_LEN = 120.0   # a found Short runs more than 2:00 — long enough to carry a whole argument
W, H = 1080, 1920
_locks = {}


class ShortError(analysis.AnalysisError):
    pass


def _lock(vid):
    return _locks.setdefault(vid, threading.Lock())


# ── transcript ────────────────────────────────────────────────────────────────

def transcript(v, progress=None):
    """The whole video's transcript, made once and kept with the video. Hand-made YouTube captions are used
    as they are; auto-generated ones have no sentence boundaries, which the cuts depend on, so Gemini listens."""
    with _lock(v['id']):
        tr = db.get_video(v['id'], full=True).get('transcript') or {}
        if tr.get('lines'):
            return tr
        vid = analysis.youtube_id(v['url'])
        tr = {}
        if vid:
            if progress:
                progress('Fetching captions')
            try:
                tr = analysis.youtube_captions(vid)
            except Exception as e:
                log.info('captions unavailable for %s: %s', vid, e)
            if tr.get('generated'):
                tr = {}
        if not tr.get('lines'):
            tr = analysis.gemini_transcribe(videos._file(v), progress=progress)
        db.update_video(v['id'], transcript=tr)
        old = RETX / f'{v["id"]}.json'
        if old.exists() and tr.get('lines'):
            remap_plans(v['id'], json.loads(old.read_text(encoding='utf-8')), tr['lines'])
            old.unlink(missing_ok=True)
        return tr


RETX = DATA / 'retranscribe'


def keep_for_retranscribe(v):
    """Re-transcribing keeps the shorts: the old lines are set aside so each short can be found again in the new
    transcript by its words (its line numbers mean nothing there, and the old times can be ~20 s off)."""
    lines = ((db.get_video(v['id'], full=True).get('transcript') or {}).get('lines')) or []
    if lines and v.get('plans'):
        RETX.mkdir(parents=True, exist_ok=True)
        (RETX / f'{v["id"]}.json').write_text(json.dumps(lines, ensure_ascii=False), encoding='utf-8')


def _norm(s):
    return ''.join(ch for ch in s.lower() if ch.isalnum())


def line_map(old, new):
    """old line index -> new line index, by the words each line starts with, in order, near its old time."""
    from difflib import SequenceMatcher
    out, j0 = {}, 0
    nn = [_norm(l['text'])[:40] for l in new]
    for i, l in enumerate(old):
        o, t = _norm(l['text'])[:40], float(l['t'])
        best, score = None, 0.5
        for j in range(j0, len(new)):
            dt = float(new[j]['t']) - t
            if dt < -60:
                continue
            if dt > 60:
                break
            r = SequenceMatcher(None, o, nn[j]).ratio()
            if r > score:
                best, score = j, r
        if best is not None:
            out[i] = best
            j0 = best
    return out


def remap_plans(vid, old, new):
    v = db.get_video(vid)
    m = line_map(old, new)
    ends = ends_of(new, v['duration'])
    old_ends = ends_of(old, v['duration'])

    if not m:
        log.warning('re-transcribe of video %s: no line of the old transcript was found in the new one', vid)
        return

    def shift(t):   # an old time moved by the correction of the nearest line that was found
        k = min(m, key=lambda i: abs(float(old[i]['t']) - t))
        return t + float(new[m[k]]['t']) - float(old[k]['t'])

    def first(a):   # the new line where old line a starts: its match, or the first line at its corrected time
        if a in m:
            return m[a]
        t = shift(float(old[a]['t']))
        return next((j for j, l in enumerate(new) if float(l['t']) >= t - 0.3), None)

    def last(b, lo):   # the last new line that starts before old line b's speech ends, at its corrected time
        e = shift(old_ends[b])
        j = lo
        while j + 1 < len(new) and float(new[j + 1]['t']) < e - 0.3:
            j += 1
        return j

    plans, lost = [], []
    for p in v.get('plans') or []:
        keep = []
        for a, b in p.get('keep') or []:
            na = first(a)
            if na is None:
                continue
            nb = last(b, na)
            if keep and na <= keep[-1][1]:
                keep[-1][1] = max(keep[-1][1], nb)
            else:
                keep.append([na, nb])
        if not keep:
            lost.append(p.get('title', ''))
            continue
        sa = first(p['span'][0])
        span = [min(sa if sa is not None else keep[0][0], keep[0][0]), max(last(p['span'][1], keep[-1][1]), keep[-1][1])]
        plans.append({**p, 'keep': keep, 'span': span, 'subs': {},
                      'sfx': [{**s, 't': round(shift(float(s['t'])), 2)} for s in p.get('sfx') or []],
                      'length': edit(keep, new, ends)[1]})
    db.update_video(vid, plans=plans)
    log.info('re-transcribe of video %s: %d shorts carried over, %d lost %s', vid, len(plans), len(lost), lost)


async def transcribe_worker():
    """Every downloaded video is transcribed in the background, newest first, one at a time."""
    loop = asyncio.get_running_loop()
    while True:
        v = db.next_untranscribed_video()
        if not v:
            await asyncio.sleep(5)
            continue

        def progress(text, vid=v['id']):
            videos.transcribing[vid] = text
            asyncio.run_coroutine_threadsafe(videos.publish(vid), loop)

        progress('Transcribing')
        try:
            await asyncio.to_thread(transcript, v, progress)
        except Exception as e:
            log.warning('transcript failed for video %s: %s', v['id'], e)
            db.update_video(v['id'], transcript={'lines': [], 'error': str(e)[:300]})
        videos.transcribing.pop(v['id'], None)
        await videos.publish(v['id'])


def ends_of(lines, total):
    """When each line's speech ends. A short gap to the next line is speech running on, so the cut waits for
    the next line; overlapping caption durations are clipped to the next start."""
    out = []
    for i, l in enumerate(lines):
        t = float(l['t'])
        e = t + float(l.get('d') or 3)
        nxt = float(lines[i + 1]['t']) if i + 1 < len(lines) else max(total or 0, e)
        if nxt > t:
            e = nxt if nxt - e < 1.0 else min(e + 0.25, nxt)
        out.append(round(max(e, t + 0.3), 2))
    return out


def norm_keep(keep, span, n):
    a0, b0 = max(0, span[0]), min(n - 1, span[1])
    idx = sorted({i for r in keep for i in range(max(int(r[0]), a0), min(int(r[1]), b0) + 1)})
    runs = []
    for i in idx:
        if runs and i == runs[-1][1] + 1:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    return runs


def edit(keep, lines, ends):
    """Kept line runs → source segments with where each lands in the short (`o`), and the total length."""
    out, off = [], 0.0
    for a, b in keep:
        s = max(0.0, float(lines[a]['t']) - 0.08)
        if out:
            s = max(s, out[-1]['e'])
        e = ends[b]
        if e - s < 0.2:
            continue
        out.append({'a': a, 'b': b, 's': round(s, 3), 'e': round(e, 3), 'o': round(off, 3)})
        off += e - s
    return out, round(off, 2)


def _ctx(v, progress=None):
    tr = transcript(v, progress)
    lines = tr.get('lines') or []
    if not lines:
        raise ShortError('This video has no transcript yet.')
    return tr, lines, ends_of(lines, v['duration'])


def _lang(tr):
    return analysis.CODE_LANGS.get(tr.get('langCode') or '', 'the language of the transcript')


def _listing(lines, ends, lo=0, hi=None):
    return '\n'.join(f'[{i}] {core._fmt(l["t"])} ({ends[i] - l["t"]:.1f}s) {l["text"]}'
                     for i, l in enumerate(lines[lo:hi], lo))


def _ask(prompt, temperature=0.4, images=()):
    from google.genai import types
    client = analysis.gemini_client()
    contents = [types.Part.from_bytes(data=b, mime_type='image/jpeg') for b in images] + [prompt]
    # A reply cut off mid-answer is asked once more before giving up.
    for attempt in range(2):
        r = client.models.generate_content(model=analysis.DEFAULT_MODEL, contents=contents,
                                           config={'temperature': temperature, 'response_mime_type': 'application/json',
                                                   'max_output_tokens': 65536})
        try:
            return json.loads(analysis._strip(r.text or ''))
        except ValueError:
            reason = r.candidates[0].finish_reason if r.candidates else None
            log.info('unreadable Gemini reply (attempt %d, %s, %d chars)', attempt + 1, reason, len(r.text or ''))
    raise ShortError('Gemini returned something that was not JSON.')


# ── sound effects ─────────────────────────────────────────────────────────────

def sfx_library():
    out = {}
    for d in (SFX, USER_SFX):
        if not d.is_dir():
            continue
        try:
            man = json.loads((d / 'manifest.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            man = {}
        for f in sorted(d.iterdir()):
            if f.suffix.lower() in ('.mp3', '.wav', '.ogg', '.m4a'):
                m = man.get(f.name) or {}
                out[f.name] = {'file': f.name, 'name': m.get('name') or f.stem.replace('-', ' ').replace('_', ' ').capitalize(),
                               'use': m.get('use') or '', 'url': f'/api/soundfx/file/{f.name}', 'user': d == USER_SFX}
    return sorted(out.values(), key=lambda s: s['name'].lower())


def sfx_path(name):
    for d in (USER_SFX, SFX):
        p = (d / name).resolve()
        if d.resolve() in p.parents and p.is_file():
            return p
    return None


# ── layout ────────────────────────────────────────────────────────────────────

def default_layout(lang_code, hook):
    sub_font = 'NotoKufiArabic-Bold' if lang_code == 'ar' else 'NotoSansMalayalam-Bold'
    return {'mode': 'fill', 'zoom': 1.0, 'x': 0.5, 'y': 0.5, 'split': 0.5,
            'panels': [{'zoom': 1.0, 'x': 0.25, 'y': 0.5}, {'zoom': 1.0, 'x': 0.75, 'y': 0.5}],
            'sub': {'show': True, 'font': sub_font, 'size': 68, 'color': '#FFFFFF', 'highlight': '#FFD21F',
                    'outline': '#000000', 'box': False, 'y': 0.70, 'words': 4, 'karaoke': True, 'lang': 'Original'},
            'title': {'show': True, 'text': hook, 'font': 'NotoSansMalayalam-Black', 'size': 74, 'color': '#FFFFFF',
                      'bg': '#E63946', 'y': 0.13}}


def layout_of(plan):
    base = default_layout('', plan.get('hook', ''))
    lay = plan.get('layout') or {}
    return {**base, **lay, 'sub': {**base['sub'], **(lay.get('sub') or {})}, 'title': {**base['title'], **(lay.get('title') or {})}}


# ── finding shorts ────────────────────────────────────────────────────────────

VIRALITY = ('"virality":{"score":<0-100>,"hook":<0-10>,"emotion":<0-10>,"clarity":<0-10>,"shareability":<0-10>,'
            '"novelty":<0-10>,"why":"<one sentence>","tips":"<one concrete change that would make it travel further>"}')


def _find_prompt(listing, lang, lib):
    names = '\n'.join(f'- {s["file"]}: {s["use"] or s["name"]}' for s in lib)
    return f'''You are a senior short-form video editor. Below is the numbered transcript of a long video, one line per row: [line index] start time (duration) text.

Find the MOST RELEVANT AND PROVOCATIVE statements in this video — the claims, challenges, admissions and comebacks a viewer would argue about, share or quote — and build a vertical Short around each (up to 15). Skip small talk, introductions, procedure and anything that only makes sense with the rest of the video. For each one:
1. COMPLETE IDEA. It must contain one complete idea by the speaker: the claim or setup, the reasoning, and the conclusion or punchline. A viewer who has seen nothing else must understand it. Never start on a line that leans on something said before it (a dangling "so", "and", "that is why", a pronoun with nothing to point to); never end before the point lands.
2. "span" is [first, last] line index of the stretch where the idea lives.
3. "keep" is the ordered list of [from, to] line-index ranges inside the span that make the final edit. Cut digressions, repetition, false starts, filler, asides and cross-talk, but never a line the idea depends on. Lines stay in their original order.
4. LENGTH. The durations of the kept lines MUST add up to MORE than {int(MIN_LEN)} seconds and at most {int(TARGET)} seconds. Work this out before you choose the span: add up the (duration) of every kept line. If the statement is shorter, widen the span to include the setup, the reasoning and the reply that make it land; if the idea cannot be told completely in {int(TARGET)} seconds, choose a tighter self-contained stretch or leave it out.
5. The first kept line is the hook: it should grab attention within 3 seconds.
6. "funny": lines inside the kept part where the speaker says something ridiculous, absurd, self-contradictory or funny (intentionally or not). For each, pick the best sound effect from this library by file name:
{names}
7. Score virality honestly — most ideas are not viral.

Write "title" (at most 60 characters) and "hook" (on-screen text, at most 8 words) in {lang}.

Respond ONLY with JSON: {{"shorts":[{{"title":"...","hook":"...","idea":"<one sentence: the complete idea>","span":[a,b],"keep":[[a,b],...],{VIRALITY},"funny":[{{"line":<index>,"why":"...","sfx":"<file name>"}}]}}]}}

Transcript:
{listing}'''


def _clean_virality(raw):
    v = raw if isinstance(raw, dict) else {}
    out = {'score': max(0, min(100, int(v.get('score') or 0)))}
    for k in ('hook', 'emotion', 'clarity', 'shareability', 'novelty'):
        try:
            out[k] = max(0, min(10, float(v.get(k) or 0)))
        except (TypeError, ValueError):
            out[k] = 0
    out['why'] = str(v.get('why') or '')[:400]
    out['tips'] = str(v.get('tips') or '')[:400]
    if isinstance(v.get('hooks'), list):
        out['hooks'] = [str(h)[:120] for h in v['hooks'][:5]]
    return out


def _plan_from(raw, lines, ends, lang_code, lib_names, pid):
    n = len(lines)
    try:
        a, b = sorted((int(raw['span'][0]), int(raw['span'][1])))
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    a, b = max(0, a), min(n - 1, b)
    keep = norm_keep([r for r in raw.get('keep') or [] if isinstance(r, list) and len(r) == 2] or [[a, b]], [a, b], n)
    if not keep:
        return None
    kept = {i for x, y in keep for i in range(x, y + 1)}
    sfx = []
    for f in raw.get('funny') or []:
        try:
            line = int(f.get('line'))
        except (TypeError, ValueError):
            continue
        if line in kept and f.get('sfx') in lib_names:
            sfx.append({'t': ends[line], 'file': f['sfx'], 'gain': -4, 'why': str(f.get('why') or '')[:200]})
    hook = str(raw.get('hook') or '')[:120]
    plan = {'id': pid, 'title': str(raw.get('title') or 'Short')[:120], 'hook': hook, 'idea': str(raw.get('idea') or '')[:400],
            'span': [a, b], 'keep': keep, 'virality': _clean_virality(raw.get('virality')), 'sfx': sfx,
            'layout': default_layout(lang_code, hook), 'renders': [], 'thumbPrompt': '', 'subs': {}, 'edited': False,
            'at': time.time()}
    plan['length'] = edit(keep, lines, ends)[1]
    return plan


def _tighten(plan, lines, ends):
    a, b = plan['span']
    prompt = (f'This Short runs {plan["length"]:.0f} seconds; it must be more than {int(MIN_LEN)} and at most {int(TARGET)}. Choose a tighter "keep" list '
              f'(ordered [from, to] line-index ranges inside lines {a}–{b}) that still tells this complete idea: "{plan["idea"]}". '
              'Cut repetition and asides first; keep the setup and the conclusion. Respond ONLY with JSON {"keep":[[a,b],...]}.\n\n'
              + _listing(lines, ends, a, b + 1))
    keep = norm_keep(_ask(prompt, 0.2).get('keep') or [], plan['span'], len(lines))
    if keep:
        plan['keep'] = keep
        plan['length'] = edit(keep, lines, ends)[1]


def _widen(plan, lines, ends):
    """A Short under 2:00: let Gemini take in the surrounding setup and reply, up to 90 s either side."""
    a, b = plan['span']
    while a > 0 and lines[plan['span'][0]]['t'] - lines[a - 1]['t'] <= 90:
        a -= 1
    while b < len(lines) - 1 and lines[b + 1]['t'] - lines[plan['span'][1]]['t'] <= 90:
        b += 1
    prompt = (f'This Short runs {plan["length"]:.0f} seconds; it must be more than {int(MIN_LEN)} and at most {int(TARGET)}. '
              f'Choose a "keep" list (ordered [from, to] line-index ranges inside lines {a}–{b}) that tells this idea completely, '
              f'with the setup that leads into it and the reasoning or reply that makes it land: "{plan["idea"]}". Add up the '
              '(duration) of every kept line before answering. Respond ONLY with JSON {"keep":[[a,b],...]}.\n\n'
              + _listing(lines, ends, a, b + 1))
    keep = norm_keep(_ask(prompt, 0.2).get('keep') or [], [a, b], len(lines))
    if keep:
        plan['keep'] = keep
        plan['span'] = [keep[0][0], keep[-1][1]]
        plan['length'] = edit(keep, lines, ends)[1]


def find(v, progress):
    tr, lines, ends = _ctx(v, progress)
    lib = sfx_library()
    progress('Finding shorts')
    data = _ask(_find_prompt(_listing(lines, ends), _lang(tr), lib))
    lang_code = tr.get('langCode') or ''
    names = {s['file'] for s in lib}
    found, spans = [], set()
    base = int(time.time() * 1000)
    for i, raw in enumerate(data.get('shorts') or []):
        p = _plan_from(raw, lines, ends, lang_code, names, base + i)
        if p and tuple(p['span']) not in spans:
            spans.add(tuple(p['span']))
            found.append(p)
    short = [p for p in found if p['length'] <= MIN_LEN]
    for n, p in enumerate(short, 1):
        progress(f'Widening short ones to 2–3 minutes — {n} of {len(short)}')
        try:
            _widen(p, lines, ends)
        except Exception as e:
            log.info('widen failed: %s', e)
    over = [p for p in found if p['length'] > LIMIT]
    for n, p in enumerate(over, 1):
        progress(f'Tightening long shorts — {n} of {len(over)}')
        try:
            _tighten(p, lines, ends)
        except Exception as e:
            log.info('tighten failed: %s', e)
    # Only what lands between 2:00 and 3:00 is kept — the brief is a Short long enough to carry an argument.
    found = [p for p in found if MIN_LEN < p['length'] <= LIMIT]
    for p in found:
        p['over'] = False
    found.sort(key=lambda p: -p['virality']['score'])
    kept = [p for p in db.get_video(v['id'])['plans'] if p.get('edited') or p.get('renders')]
    db.update_video(v['id'], plans=kept + found)
    return len(found)


def new_from_range(v, start, end):
    """A short by hand: every transcript line that starts inside the range, all kept."""
    tr, lines, ends = _ctx(v)
    idx = [i for i, l in enumerate(lines) if start - 0.5 <= l['t'] < end]
    if not idx:
        raise ShortError('No speech starts inside that range.')
    lang_code = tr.get('langCode') or ''
    plan = {'id': int(time.time() * 1000), 'title': f'{v["title"][:60]} ({core._fmt(start)})', 'hook': '', 'idea': '',
            'span': [idx[0], idx[-1]], 'keep': [[idx[0], idx[-1]]], 'virality': _clean_virality({}), 'sfx': [],
            'layout': default_layout(lang_code, ''), 'renders': [], 'thumbPrompt': '', 'subs': {}, 'edited': True, 'at': time.time()}
    plan['length'] = edit(plan['keep'], lines, ends)[1]
    plan['over'] = plan['length'] > LIMIT
    db.update_video(v['id'], plans=[plan] + db.get_video(v['id'])['plans'])
    return plan


# ── per-short work ────────────────────────────────────────────────────────────

def get_plan(v, pid):
    p = next((p for p in db.get_video(v['id'])['plans'] if p['id'] == pid), None)
    if not p:
        raise ShortError('That short is gone.')
    return p


def save_plan(vid, pid, **fields):
    plans = db.get_video(vid)['plans']
    for p in plans:
        if p['id'] == pid:
            p.update(fields)
    db.update_video(vid, plans=plans)


def update_plan(v, pid, body):
    """The builder's edits: title, hook, the kept lines, the span, the layout, the sound effects."""
    tr, lines, ends = _ctx(v)
    p = get_plan(v, pid)
    fields = {'edited': True}
    for k in ('title', 'hook'):
        if isinstance(body.get(k), str):
            fields[k] = body[k][:200]
    if isinstance(body.get('span'), list) and len(body['span']) == 2:
        a, b = sorted(int(x) for x in body['span'])
        fields['span'] = [max(0, a), min(len(lines) - 1, b)]
    if isinstance(body.get('keep'), list):
        fields['keep'] = norm_keep(body['keep'], fields.get('span') or p['span'], len(lines))
    if isinstance(body.get('layout'), dict):
        fields['layout'] = body['layout']
    if isinstance(body.get('sfx'), list):
        fields['sfx'] = [{'t': float(s['t']), 'file': str(s['file']), 'gain': float(s.get('gain', -4)), 'why': str(s.get('why') or '')}
                         for s in body['sfx'] if s.get('file')]
    if isinstance(body.get('images'), list):
        fields['images'] = [clean_image(im) for im in body['images'] if pic_path(str(im.get('url') or ''))]
    if 'keep' in fields or 'span' in fields:
        fields['length'] = edit(fields.get('keep') or p['keep'], lines, ends)[1]
        fields['over'] = fields['length'] > LIMIT
    save_plan(v['id'], pid, **fields)
    return get_plan(v, pid)


def _kept_text(plan, lines, ends):
    segs, _ = edit(plan['keep'], lines, ends)
    return '\n'.join(f'[{core._fmt(s["o"] + float(lines[i]["t"]) - s["s"])}] {lines[i]["text"]}'
                     for s in segs for i in range(s['a'], s['b'] + 1))


def virality(v, pid, progress):
    tr, lines, ends = _ctx(v)
    p = get_plan(v, pid)
    progress('Checking virality')
    prompt = (f'You judge vertical Shorts for YouTube, Instagram Reels and TikTok. Score this edit honestly — most Shorts are '
              f'not viral. Title: "{p["title"]}". On-screen hook: "{p["hook"]}". Length {p.get("length", 0):.0f} s. '
              'Judge the first 3 seconds hardest. Also write three stronger alternative on-screen hooks (at most 8 words each) '
              f'in {_lang(tr)}. Respond ONLY with JSON: {{{VIRALITY},"hooks":["...","...","..."]}}'
              '\n\nThe edit, with times inside the short:\n' + _kept_text(p, lines, ends))
    raw = _ask(prompt, 0.3)
    vir = raw.get('virality') if isinstance(raw.get('virality'), dict) else raw
    save_plan(v['id'], pid, virality=_clean_virality({**vir, 'hooks': raw.get('hooks') or vir.get('hooks')}))


def _frame(path, t):
    out = DATA / 'work' / f'frame-{time.time_ns()}.jpg'
    subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', f'{t:.2f}', '-i', str(path), '-frames:v', '1',
                    '-vf', 'scale=768:-2', str(out)], check=True, capture_output=True, creationflags=NO_WINDOW)
    try:
        return out.read_bytes()
    finally:
        out.unlink(missing_ok=True)


def thumb_prompt(v, pid, progress):
    tr, lines, ends = _ctx(v)
    p = get_plan(v, pid)
    segs, total = edit(p['keep'], lines, ends)
    progress('Writing the thumbnail prompt')
    frames = []
    for f in (0.15, 0.5, 0.85):
        at = total * f
        s = next((s for s in segs if s['o'] + (s['e'] - s['s']) >= at), segs[-1])
        frames.append(_frame(videos._file(v), s['s'] + max(0.0, at - s['o'])))
    lang = _lang(tr)
    prompt = ('Write ONE self-contained English prompt, ready to paste into ChatGPT image generation, for the cover image of '
              'this YouTube Short: a vertical 1080x1920 (9:16) image. Cover the concept, the composition, the speaker(s) '
              'described by their appearance as seen in the attached frames (age, hair, beard, glasses, clothing, headphones, '
              'microphone, setting) — never by name — their expression, props, a colour palette and graphic style that '
              f'suit the topic, and the exact headline text (3 to 5 words, in {lang}) in quotes, with font weight and '
              'placement. Keep the face and the headline in the centre safe area: nothing important in the bottom 25% or along '
              'the right edge, where YouTube draws its buttons and caption. Ask for very high contrast and readability at '
              'phone size. Respond ONLY with JSON {"prompt":"..."}.\n\n'
              f'Title: {p["title"]}\nHook: {p["hook"]}\nThe idea: {p["idea"]}\n\nWhat is said:\n' + _kept_text(p, lines, ends)[:4000])
    text = str(_ask(prompt, 0.6, frames).get('prompt') or '').strip()
    if not text:
        raise ShortError('Gemini wrote no prompt.')
    save_plan(v['id'], pid, thumbPrompt=text)


def _sub_texts(v, plan, lang, lines, ends, progress):
    """Caption text per kept line index, translated (and kept with the short) when the language is not Original."""
    kept = [i for a, b in plan['keep'] for i in range(a, b + 1)]
    if lang == 'Original':
        return {i: lines[i]['text'] for i in kept}
    have = dict((plan.get('subs') or {}).get(lang) or {})
    missing = [i for i in kept if str(i) not in have]
    if missing:
        progress(f'Translating subtitles into {lang}')
        for i, t in zip(missing, videos._translate([lines[i]['text'] for i in missing], lang)):
            have[str(i)] = t
        subs = {**(plan.get('subs') or {}), lang: have}
        save_plan(v['id'], plan['id'], subs=subs)
        plan['subs'] = subs
    return {i: have[str(i)] for i in kept}


def translate(v, pid, lang, progress):
    if lang not in videos.SUB_LANGS:
        raise ShortError(f'Subtitles come in: {", ".join(videos.SUB_LANGS)}')
    tr, lines, ends = _ctx(v)
    _sub_texts(v, get_plan(v, pid), lang, lines, ends, progress)


# ── render ────────────────────────────────────────────────────────────────────

def phrases(text, t0, t1, words):
    """A caption line shown a few words at a time; each phrase gets time in proportion to its letters."""
    ws = text.split()
    if not ws or t1 <= t0:
        return []
    groups = [ws[i:i + max(1, words)] for i in range(0, len(ws), max(1, words))]
    total = sum(len(w) + 1 for w in ws)
    out, t = [], t0
    for g in groups:
        d = (t1 - t0) * sum(len(w) + 1 for w in g) / total
        out.append((t, t + d, g))
        t += d
    return out


def _ass_time(t):
    cs = int(round(max(0.0, t) * 100))
    return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'


def _ass_color(hex_, alpha=0):
    h = (hex_ or '#FFFFFF').lstrip('#').ljust(6, 'F')[:6]
    return f'&H{alpha:02X}{h[4:6]}{h[2:4]}{h[0:2]}'.upper()


def _font_file(stem):
    for ext in ('.ttf', '.otf'):
        p = FONTS / f'{stem}{ext}'
        if p.is_file():
            return p
    return None


def _font_name(stem):
    """The family name libass matches on, read from the font itself, and whether its style is bold."""
    p = _font_file(stem)
    if not p:
        return stem, False
    try:
        from PIL import ImageFont
        fam, style = ImageFont.truetype(str(p), 12).getname()
        return fam, 'bold' in (style or '').lower()
    except Exception:
        return stem, False


def _esc(text):
    return str(text).replace('\\', '').replace('{', '(').replace('}', ')').replace('\n', ' ')


def write_ass(path, plan, lay, segs, total, lines, ends, texts):
    sub, title = lay['sub'], lay['title']
    sfam, sbold = _font_name(sub['font'])
    tfam, tbold = _font_name(title['font'])
    ssize, tsize = int(sub['size']), int(title['size'])
    if sub.get('karaoke'):
        prim, sec = _ass_color(sub['highlight']), _ass_color(sub['color'])
    else:
        prim = sec = _ass_color(sub['color'])
    if sub.get('box'):
        s_border, s_out, s_outc = 3, max(8, ssize // 5), _ass_color('#000000', 0x50)
    else:
        s_border, s_out, s_outc = 1, max(2, round(ssize * 0.07)), _ass_color(sub['outline'])
    rows = ['[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {W}', f'PlayResY: {H}', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, '
            'StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            f'Style: Sub,{sfam},{ssize},{prim},{sec},{s_outc},&H80000000,{-1 if sbold else 0},0,0,0,100,100,0,0,{s_border},{s_out},0,5,70,70,0,1',
            f'Style: Title,{tfam},{tsize},{_ass_color(title["color"])},{_ass_color(title["color"])},{_ass_color(title["bg"])},&H80000000,'
            f'{-1 if tbold else 0},0,0,0,100,100,0,0,3,{max(10, tsize // 4)},0,5,80,80,0,1',
            '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    if title.get('show') and (title.get('text') or '').strip():
        rows.append(f'Dialogue: 1,{_ass_time(0)},{_ass_time(total)},Title,,0,0,0,,{{\\pos({W // 2},{int(title["y"] * H)})}}{_esc(title["text"])}')
    if sub.get('show'):
        pos = f'{{\\pos({W // 2},{int(sub["y"] * H)})}}'
        for s in segs:
            for i in range(s['a'], s['b'] + 1):
                a = max(float(lines[i]['t']), s['s'])
                b = min(ends[i], s['e'])
                for p0, p1, words in phrases(texts.get(i, ''), s['o'] + a - s['s'], s['o'] + b - s['s'], int(sub['words'])):
                    if sub.get('karaoke'):
                        n = sum(len(w) + 1 for w in words)
                        body = ' '.join(f'{{\\k{max(1, round((p1 - p0) * 100 * (len(w) + 1) / n))}}}{_esc(w)}' for w in words)
                    else:
                        body = _esc(' '.join(words))
                    rows.append(f'Dialogue: 0,{_ass_time(p0)},{_ass_time(p1)},Sub,,0,0,0,,{pos}{body}')
    path.write_text('\n'.join(rows) + '\n', encoding='utf-8')


def _dims(path):
    out = subprocess.run([tool('ffprobe'), '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                          '-of', 'csv=p=0', str(path)], capture_output=True, text=True, check=True, creationflags=NO_WINDOW)
    w, h = out.stdout.strip().split(',')[:2]
    return int(w), int(h)


def _even(x):
    return max(2, int(round(x / 2)) * 2)


def video_filter(lay, vw, vh):
    zoom = max(0.3, float(lay.get('zoom') or 1))
    x, y = float(lay.get('x', 0.5)), float(lay.get('y', 0.5))
    if lay.get('mode') == 'fit':
        fw = W * zoom
        fh = fw * vh / vw
        left = W / 2 - fw / 2 + (0.5 - x) * max(0.0, fw - W)
        top = y * H - fh / 2
        return (f'[vc]split[bgs][fgs];[bgs]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},gblur=sigma=40,'
                f'eq=brightness=-0.08[bg];[fgs]scale={_even(fw)}:{_even(fh)}[fg];[bg][fg]overlay={int(left)}:{int(top)}[vl]')
    if lay.get('mode') == 'split':
        h1 = _even(H * min(0.85, max(0.15, float(lay.get('split') or 0.5))))
        top, bot = (lay.get('panels') or [{}, {}])[:2]
        return (f'[vc]split[pt][pb];[pt]{_crop(top, vw, vh, W, h1, PANEL_MIN_ZOOM)}[vt];'
                f'[pb]{_crop(bot, vw, vh, W, H - h1, PANEL_MIN_ZOOM)}[vb];[vt][vb]vstack[vl]')
    return f'[vc]{_crop(lay, vw, vh, W, H)}[vl]'


PANEL_MIN_ZOOM = 0.3


def _crop(p, vw, vh, tw, th, lo=1.0):
    """The source in a tw x th box: the builder's cropBox. Zoom 1 just covers the box; below it the whole picture
    sits centred on black on the axis where it is smaller."""
    s = max(tw / vw, th / vh) * max(lo, float(p.get('zoom') or 1))
    dw, dh = vw * s, vh * s

    def place(box, d, f):
        return min(0.0, max(box - d, box / 2 - f * d)) if d >= box else (box - d) / 2

    left, top = place(tw, dw, float(p.get('x', 0.5))), place(th, dh, float(p.get('y', 0.5)))
    ow, oh = _even(min(dw, tw)), _even(min(dh, th))
    cw, ch = min(vw, ow / s), min(vh, oh / s)
    cx, cy = min(max(0.0, -left / s), vw - cw), min(max(0.0, -top / s), vh - ch)
    return (f'crop={int(cw)}:{int(ch)}:{int(cx)}:{int(cy)},scale={ow}:{oh},setsar=1,'
            f'pad={tw}:{th}:{min(int(max(0.0, left)), tw - ow)}:{min(int(max(0.0, top)), th - oh)}:black')


def out_time(t, segs):
    for s in segs:
        if t < s['s']:
            return s['o']
        if t <= s['e']:
            return s['o'] + t - s['s']
    return None


def full_source(v, progress):
    """The full-resolution copy of the source, downloaded once and kept with the video."""
    v = db.get_video(v['id'])
    if v.get('full'):
        p = MEDIA / v['full'][len('/media/'):]
        if p.exists():
            return p
    progress('Downloading the full-resolution source')
    p = analysis.download_full(v['url'], f'v{v["id"]}-full')
    db.update_video(v['id'], full=f'/media/video/{p.name}')
    return p


def render(v, pid, folder, full, progress):
    tr, lines, ends = _ctx(v)
    p = get_plan(v, pid)
    segs, total = edit(p['keep'], lines, ends)
    if not segs:
        raise ShortError('Nothing is kept in this short.')
    if total > LIMIT:
        raise ShortError(f'This short runs {core._fmt(total)}: cut lines until it is under 3:00.')
    lay = layout_of(p)
    texts = _sub_texts(v, p, lay['sub'].get('lang') or 'Original', lines, ends, progress) if lay['sub'].get('show') else {}
    progress('Rendering the short')
    work = DATA / 'work' / f'short-{v["id"]}-{pid}'
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    for stem in {lay['sub']['font'], lay['title']['font']}:
        f = _font_file(stem)
        if f:
            shutil.copy2(f, work / f.name)
    write_ass(work / 's.ass', p, lay, segs, total, lines, ends, texts)
    fp = fingerprint(v, p, lay, segs, work)
    same = next((r for q in v.get('plans') or [] for r in q.get('renders') or []
                 if r.get('hash') == fp and (r.get('full') or not full) and (MEDIA / r['url'][len('/media/'):]).exists()), None)
    if same:
        shutil.rmtree(work, ignore_errors=True)
        when = time.strftime('%d %b %H:%M', time.localtime(same['at']))
        if folder:
            dest = _save_copy(MEDIA / same['url'][len('/media/'):], folder, p['title'])
            raise ShortError(f'Already rendered exactly like this on {when}: copied that file to {dest} instead of rendering again.')
        raise ShortError(f'Already rendered exactly like this on {when} (see the Shorts tab). Change something to render a new one.')
    src = full_source(v, progress) if full else videos._file(v)
    progress('Rendering the short' + (' at full resolution' if full else ''))
    vw, vh = _dims(src)
    graph = []
    for i, s in enumerate(segs):
        d = s['e'] - s['s']
        fd = min(0.03, d / 4)
        graph.append(f'[0:v]trim=start={s["s"]:.3f}:end={s["e"]:.3f},setpts=PTS-STARTPTS[v{i}]')
        graph.append(f'[0:a]atrim=start={s["s"]:.3f}:end={s["e"]:.3f},asetpts=PTS-STARTPTS,'
                     f'afade=t=in:d={fd:.3f},afade=t=out:st={d - fd:.3f}:d={fd:.3f}[a{i}]')
    graph.append(''.join(f'[v{i}][a{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=1[vc][ac]')
    graph.append(video_filter(lay, vw, vh))
    inputs, mix, cur = ['-i', str(src)], [], 'vl'
    for j, (im, f, a, b) in enumerate(placed_images(p, segs, total)):
        k = len(inputs) // 2
        inputs += ['-i', str(f)]
        graph.append(f'[{k}:v]scale={_even(W * im["w"])}:-2,format=rgba[im{j}]')
        graph.append(f"[{cur}][im{j}]overlay=x={W * im['x']:.0f}-w/2:y={H * im['y']:.0f}-h/2:enable='between(t,{a:.3f},{b:.3f})'[ov{j}]")
        cur = f'ov{j}'
    graph.append(f'[{cur}]ass=filename=s.ass:fontsdir=.:shaping=complex[vout]')
    for s in p.get('sfx') or []:
        f, at = sfx_path(s['file']), out_time(float(s['t']), segs)
        if not f or at is None or at >= total:
            continue
        k = len(inputs) // 2
        inputs += ['-i', str(f)]
        ms = int(at * 1000)
        graph.append(f'[{k}:a]aresample=48000,volume={float(s.get("gain", -4)):.1f}dB,adelay={ms}|{ms}[s{k}]')
        mix.append(f'[s{k}]')
    if mix:
        graph.append(f'[ac]aresample=48000[am];[am]{"".join(mix)}amix=inputs={len(mix) + 1}:duration=first:normalize=0[aout]')
    out_dir = MEDIA / 'shorts'
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f'v{v["id"]}-s{pid}-{int(time.time())}.mp4'
    subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', *inputs, '-filter_complex', ';'.join(graph),
                    '-map', '[vout]', '-map', '[aout]' if mix else '[ac]', '-c:v', 'libx264', *(['-preset', 'medium', '-crf', '18'] if full else ['-preset', 'veryfast', '-crf', '20']),
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(out)],
                   check=True, capture_output=True, cwd=str(work), creationflags=NO_WINDOW)
    shutil.rmtree(work, ignore_errors=True)
    saved = _save_copy(out, folder, p['title']) if folder else ''
    p = get_plan(db.get_video(v['id']), pid)
    renders = [{'url': f'/media/shorts/{out.name}', 'length': total, 'saved': saved, 'at': time.time(), 'full': bool(full),
                'source': f'{vw}x{vh}', 'hash': fp}] + (p.get('renders') or [])
    save_plan(v['id'], pid, renders=renders, **({'queue': {**p['queue'], 'state': 'done', 'error': ''}} if p.get('queue') else {}))


def _save_copy(src, folder, title):
    from pathlib import Path
    dest = Path(folder) / f'{videos._safe_name(title)}.mp4'
    n = 2
    while dest.exists():
        dest = Path(folder) / f'{videos._safe_name(title)} ({n}).mp4'
        n += 1
    shutil.copy2(src, dest)
    return str(dest)


def fingerprint(v, p, lay, segs, work):
    """SHA-256 of everything a render is made from, taken before the encode: the cuts, the subtitle file (its
    words, timing and style), the picture layout, the title, the sound effects and the fonts. The source's
    resolution is left out, so a full-resolution render also stands for a later preview of the same content."""
    import hashlib

    def stat(f):
        return [f.name, f.stat().st_size, int(f.stat().st_mtime)] if f and f.exists() else None

    sfx = [[s.get('file'), round(float(s['t']), 3), float(s.get('gain', -4)), stat(sfx_path(s['file']))] for s in p.get('sfx') or []]
    body = {'video': v['id'], 'url': v['url'], 'segs': [[round(s['s'], 3), round(s['e'], 3)] for s in segs],
            'picture': {k: lay.get(k) for k in ('mode', 'zoom', 'x', 'y', 'split', 'panels')},
            'ass': (work / 's.ass').read_text(encoding='utf-8'), 'sfx': sfx,
            'images': [[stat(f), round(a, 3), round(b, 3), im['x'], im['y'], im['w']]
                       for im, f, a, b in placed_images(p, segs, sum(s['e'] - s['s'] for s in segs))],
            'fonts': sorted(stat(f) or [] for f in work.iterdir() if f.suffix.lower() in ('.ttf', '.otf')),
            'size': [W, H], 'encoder': 1}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


# ── pictures ──────────────────────────────────────────────────────────────────
# Gemini reads the short with the whole video as context, picks the moments that want a picture and draws each
# one. A picture sits on the short's own frame (x, y = its centre, w = its width, as fractions of 1080x1920) and
# is anchored at a source time `t`, like a sound effect, so it stays with its words when the cuts change.

IMAGE_MODEL = 'gemini-3.1-flash-image'
PICS = MEDIA / 'pics'


def pic_path(url):
    if not url.startswith('/media/pics/'):
        return None
    f = (MEDIA / url[len('/media/'):]).resolve()
    return f if PICS.resolve() in f.parents and f.is_file() else None


def _num(x, lo, hi, d):
    try:
        return min(hi, max(lo, float(x)))
    except (TypeError, ValueError):
        return d


def clean_image(im):
    return {'id': int(im.get('id') or time.time_ns() // 1000), 'url': str(im['url']), 'prompt': str(im.get('prompt') or '')[:2000],
            'why': str(im.get('why') or '')[:300], 't': round(_num(im.get('t'), 0, 1e6, 0), 3), 'd': round(_num(im.get('d'), 0.3, 60, 4), 3),
            'x': round(_num(im.get('x'), -0.5, 1.5, 0.5), 4), 'y': round(_num(im.get('y'), -0.5, 1.5, 0.4), 4),
            'w': round(_num(im.get('w'), 0.05, 2, 0.8), 4)}


def src_time(o, segs):
    for s in segs:
        if o <= s['o'] + (s['e'] - s['s']):
            return s['s'] + max(0.0, o - s['o'])
    return segs[-1]['e'] if segs else 0.0


def placed_images(p, segs, total):
    """(image, file, from, to) on the short's clock, for every picture whose moment is still in the cut."""
    out = []
    for im in p.get('images') or []:
        f, at = pic_path(im.get('url') or ''), out_time(float(im.get('t') or 0), segs)
        if f and at is not None and at < total:
            out.append((im, f, at, min(total, at + float(im.get('d') or 4))))
    return out


def _draw(prompt):
    from google.genai import types
    client = analysis.gemini_client()
    err = 'no picture came back'
    for _ in range(2):
        try:
            r = client.models.generate_content(model=IMAGE_MODEL, contents=[prompt], config=types.GenerateContentConfig(
                response_modalities=['IMAGE'], image_config=types.ImageConfig(aspect_ratio='1:1')))
            parts = r.candidates[0].content.parts if r.candidates and r.candidates[0].content else None
            for part in parts or []:
                if part.inline_data and part.inline_data.data:
                    return part.inline_data.data
        except Exception as e:
            err = str(e)
    raise ShortError(f'Gemini drew nothing: {err[:200]}')


def pictures(v, pid, progress):
    from PIL import Image
    tr, lines, ends = _ctx(v)
    p = get_plan(v, pid)
    segs, total = edit(p['keep'], lines, ends)
    if not segs:
        raise ShortError('Nothing is kept in this short.')
    progress('Choosing moments for pictures')
    n = max(2, min(8, round(total / 20)))
    whole = _listing(lines, ends)
    if len(whole) > 24000:
        whole = whole[:24000] + '\n…'
    prompt = (f'You are the picture editor of a vertical YouTube Short cut from a longer video. Pick up to {n} moments in the '
              'short where a picture on screen would help the viewer see or feel what is being said: a place, an object, an '
              'event, a historical scene, a creature, a concept or a simple diagram. Spread them through the short; never two '
              'at once. Never picture the speakers themselves, and never draw a recognisable real person. The picture must '
              'contain NO text, letters, numbers, captions, logos or watermarks. For each moment give: "at" (seconds into the '
              'short, from the times in the edit below, when the thing is first mentioned), "dur" (2 to 6 seconds, while it is '
              'talked about), "prompt" (a detailed English image-generation prompt: subject, composition, setting, lighting; '
              'photorealistic editorial style unless a diagram or illustration explains it better; square framing with the '
              'subject centred) and "why" (one short English line). Respond ONLY with JSON '
              '{"pictures":[{"at":0,"dur":4,"prompt":"...","why":"..."}]}.\n\n'
              f'Title: {p["title"]}\nThe idea: {p.get("idea") or ""}\n\nThe edit, with times inside the short:\n'
              + _kept_text(p, lines, ends)[:8000] + '\n\nThe whole video, for context only:\n' + whole)
    raw = _ask(prompt, 0.5)
    picks = raw.get('pictures') if isinstance(raw, dict) else raw
    picks = [x for x in picks or [] if isinstance(x, dict) and x.get('prompt')][:n]
    if not picks:
        raise ShortError('Gemini found no moment that wants a picture.')
    PICS.mkdir(parents=True, exist_ok=True)
    made = []
    for k, it in enumerate(sorted(picks, key=lambda x: _num(x.get('at'), 0, total, 0)), 1):
        progress(f'Drawing picture {k} of {len(picks)}')
        data = _draw(str(it['prompt']) + ' No text, no letters, no logos, no watermark.')
        f = PICS / f'v{v["id"]}-s{pid}-{time.time_ns()}.jpg'
        Image.open(io.BytesIO(data)).convert('RGB').save(f, 'JPEG', quality=92)
        at = _num(it.get('at'), 0, max(0.0, total - 1), 0)
        made.append(clean_image({'url': f'/media/pics/{f.name}', 'prompt': it['prompt'], 'why': it.get('why'),
                                 't': src_time(at, segs), 'd': _num(it.get('dur'), 1.5, 8, 4), 'x': 0.5, 'y': 0.4, 'w': 0.8}))
        # Each picture shows up as soon as it is drawn (the next progress call publishes); an earlier run's are replaced.
        save_plan(v['id'], pid, images=made, picturesAt=time.time())
    progress('Pictures done')


# ── the render queue ──────────────────────────────────────────────────────────
# A short added to the queue is worked first come, first served by one worker: its pictures are fetched
# ('waiting' → 'pictures' → 'ready'), then it is rendered at full resolution ('rendering' → 'done'). The state
# lives on the plan as queue = {state, error, at}; `at` is when it was added, which sets the order.

def set_queue(vid, pid, state, error=''):
    p = next((p for p in db.get_video(vid)['plans'] if p['id'] == pid), None)
    if p is not None:
        save_plan(vid, pid, queue={**(p.get('queue') or {'at': time.time()}), 'state': state, 'error': error[:400]})


_working = False


async def queue_worker():
    global _working
    if _working:
        return
    _working = True
    try:
        while True:
            todo = sorted(((p['queue'].get('at') or 0), v['id'], p['id'], p['queue']['state'])
                          for v in db.list_videos() for p in v.get('plans') or []
                          if (p.get('queue') or {}).get('state') in ('waiting', 'ready'))
            if not todo:
                break
            _, vid, pid, state = todo[0]
            while videos.busy.get(vid):
                await asyncio.sleep(2)
            if state == 'waiting':
                set_queue(vid, pid, 'pictures')
                err = await run(db.get_video(vid), 'pictures', pictures, pid)
                if err:
                    set_queue(vid, pid, 'failed', f'Pictures: {err}')
                    await videos.publish(vid)
                    continue
            set_queue(vid, pid, 'rendering')
            err = await run(db.get_video(vid), 'render', render, pid, '', True)
            fine = not err or err.startswith('Already rendered')
            set_queue(vid, pid, 'done' if fine else 'failed', '' if fine else err)
            await videos.publish(vid)
    finally:
        _working = False


def resume_queue():
    """After a restart, work that was cut off mid-way goes back in line."""
    for v in db.list_videos():
        for p in v.get('plans') or []:
            st = (p.get('queue') or {}).get('state')
            if st in ('pictures', 'rendering'):
                set_queue(v['id'], p['id'], 'waiting' if st == 'pictures' else 'ready')


# ── runner ────────────────────────────────────────────────────────────────────

LABELS = {'pictures': 'Making pictures', 'find': 'Finding shorts', 'virality': 'Checking virality', 'thumbprompt': 'Writing the thumbnail prompt',
          'render': 'Rendering the short', 'translate': 'Translating subtitles'}


async def run(v, kind, fn, *args, on_step=None):
    """Runs one piece of short work in a thread; returns the error text, '' on success."""
    vid = v['id']
    loop = asyncio.get_running_loop()
    videos.busy[vid] = LABELS[kind]
    await videos.publish(vid)

    def progress(text):
        videos.busy[vid] = text
        asyncio.run_coroutine_threadsafe(videos.publish(vid), loop)
        if on_step:
            on_step(text)

    err = ''
    try:
        await asyncio.to_thread(fn, v, *args, progress)
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b'').decode(errors='replace').strip()[-400:] or str(e)
    except Exception as e:
        if not isinstance(e, analysis.AnalysisError):
            log.exception('%s failed for video %s', kind, vid)
        err = str(e)[:400]
    videos.busy.pop(vid, None)
    await videos.publish(vid)
    if err:
        await core.broadcast({'type': 'videoError', 'videoId': vid, 'error': f'{LABELS[kind]} failed: {err}'})
    return err


# ── shorts marked from Telegram ───────────────────────────────────────────────
# A link sent with "Mark shorts" carries tg = {chatId, messageId, via, shorts: 'pending'}. Once the video is
# downloaded, Find shorts runs and the proposals go back to the chat as a checklist; the ticked ones are
# confirmed through /shorts/confirm and the rest are dropped. `via` is 'studiomate' (StudioMate's bot, over its
# /event server) or 'own' (SlideBook's fallback bot).

def confirm(v, ids):
    ids = {int(i) for i in ids}
    kept, plans = [], []
    for p in db.get_video(v['id'])['plans']:
        if p['id'] in ids:
            p.update(confirmed=True, edited=True)
            kept.append(p)
        elif not (p.get('edited') or p.get('renders') or p.get('confirmed')):
            continue
        plans.append(p)
    db.update_video(v['id'], plans=plans)
    return kept


def drop_render(v, pid, url):
    p = get_plan(v, pid)
    f = (MEDIA / url[len('/media/'):]).resolve() if url.startswith('/media/shorts/') else None
    if f and (MEDIA / 'shorts').resolve() in f.parents:
        f.unlink(missing_ok=True)
    save_plan(v['id'], pid, renders=[r for r in p.get('renders') or [] if r['url'] != url])


async def confirm_and_render(v, ids):
    """Keep the ticked shorts, then render each at full resolution in the background, telling the chat."""
    kept = confirm(v, ids)
    if kept:
        asyncio.ensure_future(_render_confirmed(v['id'], [p['id'] for p in kept], [p['title'] for p in kept]))
    return kept


async def _render_confirmed(vid, ids, titles):
    v = db.get_video(vid)
    tg = v['tg'] if (v['tg'] or {}).get('chatId') else None
    base = {'videoId': vid, 'title': v['title'] or v['url'], 'url': v['url'], 'kept': titles}
    done = []
    for n, pid in enumerate(ids, 1):
        while videos.busy.get(vid):
            await asyncio.sleep(2)
        if tg:
            await _tell(tg, {**base, 'status': 'rendering', 'step': f'Rendering {n} of {len(ids)}'})
        err = await run(db.get_video(vid), 'render', render, pid, '', True)
        if not err or err.startswith('Already rendered'):
            done.append(titles[n - 1])
    if tg:
        await _tell(tg, {**base, 'status': 'rendered', 'rendered': done, 'failed': len(ids) - len(done)})


async def _tell(tg, payload):
    if tg.get('via') == 'own':
        import bot
        await bot.shorts_message(tg, payload)
        return
    import relay
    await relay.post({'type': 'slidebook-shorts', 'chatId': tg.get('chatId'), 'messageId': tg.get('messageId'), **payload})


async def _mark(v):
    vid, tg = v['id'], dict(v['tg'])
    db.update_video(vid, tg={**tg, 'shorts': 'running'})
    base = {'videoId': vid, 'title': v['title'] or v['url'], 'url': v['url']}
    loop = asyncio.get_running_loop()
    last = ['']

    def on_step(text):
        if text != last[0]:
            last[0] = text
            asyncio.run_coroutine_threadsafe(_tell(tg, {**base, 'status': 'working', 'step': text}), loop)

    await _tell(tg, {**base, 'status': 'working', 'step': 'Transcribing' if v['transcriptState'] != 'ready' else 'Finding shorts'})
    started = time.time()
    err = await run(v, 'find', find, on_step=on_step)
    if err:
        db.update_video(vid, tg={**tg, 'shorts': 'failed'})
        await _tell(tg, {**base, 'status': 'failed', 'error': err})
        return
    found = [p for p in db.get_video(vid)['plans'] if p.get('at', 0) >= started - 1 and not p.get('edited')]
    db.update_video(vid, tg={**tg, 'shorts': 'sent'})
    await _tell(tg, {**base, 'status': 'done', 'shorts': [
        {'id': p['id'], 'title': p['title'], 'idea': p['idea'], 'length': p['length'], 'score': p['virality'].get('score', 0)}
        for p in found]})


async def mark_worker():
    while True:
        await asyncio.sleep(3)
        for v in db.list_videos():
            if (v['tg'] or {}).get('shorts') != 'pending' or videos.busy.get(v['id']):
                continue
            if v['status'] == 'failed':
                db.update_video(v['id'], tg={**v['tg'], 'shorts': 'failed'})
                await _tell(v['tg'], {'videoId': v['id'], 'title': v['title'] or v['url'], 'url': v['url'], 'status': 'failed',
                                      'error': f'the download failed: {v["error"]}'})
            elif v['status'] == 'ready':
                try:
                    await _mark(v)
                except Exception:
                    log.exception('marking shorts for video %s failed', v['id'])
