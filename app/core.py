"""Shared state for the HTTP server: books, the live/preview cursor, the link queue.

Navigation is server-authoritative: every surface (canvas, strip, keys, Telegram, the output page)
sends a command, and the one broadcast that follows is the only way any of them moves.
"""
import asyncio, hashlib, io, json, logging, subprocess, time, traceback
from pathlib import Path

from PIL import Image

import analysis, db
from paths import DATA, MEDIA, tool

log = logging.getLogger('slidebook')

# ── broadcast hub ─────────────────────────────────────────────────────────────

clients = set()
listeners = []  # callables(msg) — relay.py hears job updates through this


async def broadcast(msg):
    data = json.dumps(msg)
    for ws in list(clients):
        try:
            await ws.send_str(data)
        except Exception:
            clients.discard(ws)
    for fn in listeners:
        try:
            r = fn(msg)
            if asyncio.iscoroutine(r):
                await r
        except Exception:
            log.exception('listener failed')


def book_changed(book_id):
    b = db.get_book(book_id)
    return broadcast({'type': 'book', 'id': book_id, 'rev': b['rev'] if b else None, 'deleted': b is None})


# ── live / preview cursor ─────────────────────────────────────────────────────

state = {'view': db.get_setting('view'), 'live': db.get_setting('live')}
# Plain: slides drawn flat and front-on, on the canvas AND on air (the video object keeps its pose).
plain = bool(db.get_setting('plain'))
for _k in ('view', 'live'):
    if state[_k]:
        state[_k].pop('clip', None)

# ── clip before the card ──────────────────────────────────────────────────────
# Stepping on air to a timed fact-check or fallacy card first plays the moment it is about, PRE seconds
# before to POST seconds after, as the video object on the stage (`styles.video`), and only then shows
# the card. `/output` plays it and reports the end; it announces itself, so with no output open the
# card shows at once.
DEFAULT_CLIP = {'on': True, 'pre': 3, 'post': 3, 'maxLen': 60}
player_seen = 0.0
sfx_seen = 0.0
_clip_seq = 0
_last_step = ('', 0.0)


def poster_file(name, t):
    """The cached JPEG of `name` (a file in media/video) at second `t`, rounded to 0.1 s (the client
    rounds the same way, so the URLs meet). Made with ffmpeg on first ask."""
    src = MEDIA / 'video' / Path(name).name
    if not src.is_file():
        return None
    t = round(max(0.0, float(t)), 1)
    out = MEDIA / 'posters' / f'{src.stem}@{t:.1f}.jpg'
    if out.is_file():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix('.part.jpg')
    try:
        subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', f'{t:.1f}', '-i', str(src), '-frames:v', '1',
                        '-vf', 'scale=1280:-2', '-q:v', '3', str(tmp)],
                       check=True, capture_output=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        tmp.replace(out)
        return out
    except (OSError, subprocess.SubprocessError):
        tmp.unlink(missing_ok=True)
        return None


def warm_posters(book_id):
    """Make every segment's start and end posters ahead of time, so a step never waits on ffmpeg."""
    book = db.get_book(book_id)
    if not book or not (book.get('source') or {}).get('video'):
        return
    name = Path(book['source']['video']).name
    groups = _seg_groups(book['manifest'])
    for g in dict.fromkeys(groups):
        spec = _clip_span(book, groups.index(g) + 1)
        if spec:
            poster_file(name, spec['t0'])
            poster_file(name, _play_span(book, groups.index(g) + 1)['t0'])
            poster_file(name, max(spec['t0'], spec['t1'] - 0.35))


def seg_time(p):
    """A page's place on the video: a card's statement time, or the time slot an image / video slide was
    moved into (`t`, set when it is moved next to a timed slide). None = untimed, a segment of its own."""
    if not p:
        return None
    return (p.get('card') or {}).get('t') if p.get('kind') in db.CARD_KINDS else p.get('t')


def _seg_key(p):
    t = seg_time(p)
    return None if t is None else round(float(t))


def _seg_groups(manifest):
    """Time segments: consecutive pages at the same second of the video share one (web/src/lib/segments.ts)."""
    out, g, prev = [], -1, None
    for p in manifest:
        k = _seg_key(p)
        if k is None or k != prev:
            g += 1
        prev = k
        out.append(g)
    return out


def _video_cfg(book):
    return {**DEFAULT_CLIP, **((book.get('styles') or {}).get('video') or {})}


def _after_mode(book):
    """"Card after video": the clip is a stop of its own. "Together" (`mode: together`) keeps the old flow."""
    return _video_cfg(book).get('mode') != 'together'


def _clip_for(book, page, came_from=None):
    """Together mode: the clip a step to `page` plays beside its card, with `/output` there to play it."""
    if time.time() - player_seen > 8:
        return None
    groups = _seg_groups(book['manifest'])
    if came_from and 0 < came_from <= len(groups) and groups[came_from - 1] == groups[page - 1]:
        return None
    return _play_span(book, page)


def _clip_span(book, page):
    """The clip of `page`'s segment: its earliest statement to its latest, PRE before and POST after,
    no longer than `maxLen`. None when the page has no timed card or the book no video."""
    cfg = _video_cfg(book)
    manifest = book['manifest']
    if not cfg['on'] or not 0 < page <= len(manifest) or not (book.get('source') or {}).get('video'):
        return None
    groups = _seg_groups(manifest)
    timed = [p for i, p in enumerate(manifest) if groups[i] == groups[page - 1]
             and p.get('kind') in db.CARD_KINDS and (p.get('card') or {}).get('t') is not None]
    if not timed:
        return None
    # A range set by hand on the clip timeline, kept against the segment's first timed card, wins.
    own = (cfg.get('ranges') or {}).get(timed[0]['id'])
    if own and own.get('t1', 0) > own.get('t0', 0):
        return {'t0': float(own['t0']), 't1': float(own['t1'])}
    cards = [p['card'] for p in timed]
    t = min(float(c['t']) for c in cards)
    end = max(float(c.get('tEnd') or float(c['t']) + 8) for c in cards)
    t0, t1 = max(0.0, t - float(cfg['pre'])), end + float(cfg['post'])
    # A question's span is its whole answer, minutes long; the clip stops at the longest the show wants.
    if float(cfg.get('maxLen') or 0) > 0:
        t1 = min(t1, t0 + float(cfg['maxLen']))
    return {'t0': t0, 't1': t1}


def _play_span(book, page):
    """What a step to `page` plays: its segment's clip, started early enough to run through every hidden
    segment just before it — a hidden segment's slides are skipped, its video is not. Mirrors playRange."""
    spec = _clip_span(book, page)
    if not spec:
        return None
    manifest, groups = book['manifest'], _seg_groups(book['manifest'])
    first = groups.index(groups[page - 1])
    while first > 0:
        prev = groups.index(groups[first - 1])
        pages = [p for i, p in enumerate(manifest) if groups[i] == groups[prev]]
        own = _clip_span(book, prev + 1) if all(p.get('hidden') for p in pages) else None
        if not own:
            break
        spec = {**spec, 't0': min(spec['t0'], own['t0'])}
        first = prev
    return spec


async def refresh_clip(book_id):
    """A book's clip settings changed (a range dragged on the clip timeline, Before / After, Longest).
    A clip stop on screen for it is re-cut at once, in place: same seq, so the players keep their
    element and playhead and simply run on to the new end."""
    book = db.get_book(book_id)
    changed = False
    for key in ('view', 'live'):
        cur = state[key]
        clip = (cur or {}).get('clip') or {}
        if not cur or cur['bookId'] != book_id or not clip.get('hold'):
            continue
        spec = _play_span(book, cur['page'])
        if not spec or (abs(spec['t0'] - clip['t0']) < 0.05 and abs(spec['t1'] - clip['t1']) < 0.05):
            continue
        cur['clip'] = {**clip, **spec}
        changed = True
    if state['live'] and state['view'] and state['live']['bookId'] == state['view']['bookId'] and 'clip' in state['live']:
        state['view']['clip'] = dict(state['live']['clip'])   # one clip, seen in both
    if changed:
        await broadcast(snapshot({'event': 'clip-range'}))


async def clip_done(book_id, page, seq=None):
    live = state['live']
    if not live or live['bookId'] != book_id or live['page'] != page or 'clip' not in live:
        return
    if seq is not None and live['clip'].get('seq') != seq:
        return
    live.pop('clip')
    await broadcast(snapshot({'event': 'reveal'}))


async def _clip_guard(book_id, page, seq, secs):
    await asyncio.sleep(secs + 15)
    await clip_done(book_id, page, seq)


def _visible(book):
    return [i + 1 for i, p in enumerate(book['manifest']) if not p.get('hidden')]


def snapshot(extra=None):
    return {'type': 'state', 'view': state['view'], 'live': state['live'], 'plain': plain, **(extra or {})}


async def control(action, book_id=None, page=None, on_air=False, replay=False, edit=False):
    """`replay` (a segment's timestamp clicked): play that segment's clip even from inside it.
    `edit` (the canvas is in Edit mode): step straight between pages, no clip stops."""
    global _clip_seq, _last_step
    # One key press can reach here twice — the SlideBook window's own arrow handler AND an OBS global
    # hotkey on the same key — which jumped two pages and looked like an auto-advance. A repeat of the
    # same step within a third of a second is that echo, never a second intention.
    if action in ('next', 'prev'):
        now = time.monotonic()
        if _last_step[0] == action and now - _last_step[1] < 0.33:
            return snapshot()
        _last_step = (action, now)
    view, live = state['view'], state['live']
    target = book_id or (on_air and live or view or {}).get('bookId')
    book = db.get_book(target) if target else None
    extra = {}
    if action == 'unair':
        if live:
            extra = {'event': 'hide'}
        state['live'] = None
    elif not book:
        return snapshot()
    elif action == 'select':
        start = live['page'] if live and live['bookId'] == target else (page or (_visible(book) or [1])[0])
        state['view'] = {'bookId': target, 'page': start}
        asyncio.ensure_future(asyncio.to_thread(warm_posters, target))
    elif action == 'air':
        start = page or (view['page'] if view and view['bookId'] == target else (_visible(book) or [1])[0])
        state['live'] = {'bookId': target, 'page': start}
        state['view'] = dict(state['live'])
        extra = {'event': 'show'}
        asyncio.ensure_future(asyncio.to_thread(warm_posters, target))
    elif action in ('next', 'prev', 'goto'):
        cursor = live if live and live['bookId'] == target else view if view and view['bookId'] == target else {'page': 1}
        cur = cursor['page']
        vis = _visible(book)
        groups = _seg_groups(book['manifest'])
        seg = lambda n: groups[n - 1] if 0 < n <= len(groups) else None
        later = [n for n in vis if n > cur]
        earlier = [n for n in vis if n < cur]
        after = _after_mode(book) and not edit
        at_clip = after and bool((cursor.get('clip') or {}).get('hold'))
        stop = None   # "Card after video": the clip stop the step lands on, {'frozen': bool}
        if action == 'goto':
            nxt = page if page and 1 <= page <= len(book['manifest']) else cur
            if after and (replay or seg(nxt) != seg(cur)):
                stop = {'frozen': False}
        elif action == 'next':
            if at_clip:
                nxt = cur                       # the clip is waiting: its card comes in
            else:
                nxt = min(later) if later else cur
                if after and nxt != cur and seg(nxt) != seg(cur):
                    stop = {'frozen': False}    # into a new segment: its clip plays, then waits
        else:
            if at_clip:
                nxt = max(earlier) if earlier else cur
            else:
                prv = max(earlier) if earlier else None
                if after and (prv is None or seg(prv) != seg(cur)) and _clip_span(book, cur):
                    nxt, stop = cur, {'frozen': True}   # back onto this segment's clip — not played again
                else:
                    nxt = prv or cur
        spec = _play_span(book, nxt) if stop else None
        if nxt == cur and action != 'goto' and bool(spec) == at_clip:
            return snapshot()
        reverse = nxt < cur
        dest = {'bookId': target, 'page': nxt}
        if spec:
            _clip_seq += 1
            dest['clip'] = {**spec, 'seq': _clip_seq, 'hold': True, 'frozen': stop['frozen']}
        state['view'] = dict(dest)
        if live and live['bookId'] == target:
            state['live'] = dict(dest)
            extra = {'event': 'goto', 'reverse': reverse, 'action': action, 'replay': replay}
            if not after and not edit:
                # Together: the clip plays beside the card, which shows at once.
                clip = None if reverse and action == 'prev' else _clip_for(book, nxt, None if replay else cur)
                if clip:
                    _clip_seq += 1
                    clip['seq'] = _clip_seq
                    state['live']['clip'] = clip
                    asyncio.ensure_future(_clip_guard(target, nxt, _clip_seq, clip['t1'] - clip['t0']))
        else:
            extra = {'event': 'preview', 'reverse': reverse, 'action': action, 'replay': replay}
    db.set_setting('view', state['view'] and {k: v for k, v in state['view'].items() if k != 'clip'})
    db.set_setting('live', state['live'] and {k: v for k, v in state['live'].items() if k != 'clip'})
    msg = snapshot(extra)
    await broadcast(msg)
    return msg


async def repin(book_id, old_manifest, new_manifest):
    """A page was inserted/moved/deleted in a book somebody is looking at: keep the cursor on the same
    page (found by its stable id) rather than on whatever slid into its slot."""
    changed = False
    for key in ('view', 'live'):
        cur = state[key]
        if not cur or cur['bookId'] != book_id:
            continue
        pid = old_manifest[cur['page'] - 1]['id'] if 0 < cur['page'] <= len(old_manifest) else None
        idx = next((i + 1 for i, p in enumerate(new_manifest) if p['id'] == pid), None)
        if idx is None:
            idx = max(1, min(cur['page'], len(new_manifest)))
        if idx != cur['page']:
            state[key] = {'bookId': book_id, 'page': idx}
            changed = True
    if changed:
        db.set_setting('view', state['view'])
        db.set_setting('live', state['live'])
        await broadcast(snapshot({'event': 'repin'}))


async def edit_manifest(book_id, fn):
    before = db.get_book(book_id)
    if not before:
        return None
    after = db.mutate_manifest(book_id, fn)
    await repin(book_id, before['manifest'], after['manifest'])
    await book_changed(book_id)
    return after


# ── media ─────────────────────────────────────────────────────────────────────

def write_image(data: bytes, ext: str):
    """The one way an image enters the store: content-hashed under media/images, returns (ref, aspect)."""
    ext = (ext or 'jpg').lower().lstrip('.')
    if ext == 'jpeg':
        ext = 'jpg'
    with Image.open(io.BytesIO(data)) as im:
        w, h = im.size
        if ext not in ('jpg', 'png', 'webp', 'gif'):
            buf = io.BytesIO()
            im.convert('RGB').save(buf, 'JPEG', quality=90)
            data, ext = buf.getvalue(), 'jpg'
    name = f'{hashlib.sha1(data).hexdigest()}.{ext}'
    path = MEDIA / 'images' / name
    if not path.exists():
        path.write_bytes(data)
    return f'images/{name}', (w / h if h else 16 / 9)


def write_audio(data: bytes, ext: str):
    name = f'{hashlib.sha1(data).hexdigest()}.{(ext or "mp3").lower().lstrip(".")}'
    path = MEDIA / 'audio' / name
    if not path.exists():
        path.write_bytes(data)
    return f'/media/audio/{name}'


def pdf_pages(data: bytes):
    import fitz
    pages = []
    with fitz.open(stream=data, filetype='pdf') as doc:
        for i, pg in enumerate(doc):
            pix = pg.get_pixmap(dpi=150)
            ref, aspect = write_image(pix.tobytes('jpeg', jpg_quality=85), 'jpg')
            pages.append({'id': db.new_id('p'), 'kind': 'pdf', 'ref': ref, 'aspect': aspect, 'label': f'p{i + 1}'})
    return pages


def gc_media():
    refs = db.referenced_media()
    gone = 0
    for f in (MEDIA / 'images').iterdir():
        if f'images/{f.name}' not in refs:
            f.unlink(missing_ok=True)
            gone += 1
    return gone


VIDEO_EXTS = ('.mp4', '.webm', '.mov', '.mkv', '.m4v')


def video_page(path, label):
    """A video slide: the file under media/video plays in the slide's box; `ref` is its opening frame,
    so thumbnails, the page strip and the entrance (held until the poster decodes) work as for an image."""
    out = DATA / 'work' / f'poster-{time.time_ns()}.jpg'
    out.parent.mkdir(parents=True, exist_ok=True)
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    for t in ('0.5', '0'):
        subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', t, '-i', str(path), '-frames:v', '1',
                        '-vf', 'scale=1280:-2', '-q:v', '3', str(out)], capture_output=True, timeout=60, creationflags=flags)
        if out.is_file() and out.stat().st_size:
            break
    if not out.is_file():
        raise analysis.AnalysisError(f'Could not read a frame from {Path(path).name}.')
    try:
        ref, aspect = write_image(out.read_bytes(), 'jpg')
    finally:
        out.unlink(missing_ok=True)
    return {'id': db.new_id('vid-'), 'kind': 'video', 'ref': ref, 'aspect': aspect,
            'video': f'video/{Path(path).name}', 'label': str(label)[:60]}


def insert_pages(manifest, pages, after=None):
    at = len(manifest) if after is None else max(0, min(len(manifest), after))
    return manifest[:at] + pages + manifest[at:]


# ── link queue worker ─────────────────────────────────────────────────────────

MAX_ATTEMPTS = 3


def brief(opts):
    """The operator's own words for this job: the app's instruction and the Mini App's expectation."""
    parts = [opts.get('instruction'), opts.get('context') and f"Background, from the person who sent this link: {opts['context']}",
             opts.get('expectation') and f"The person who sent this link expects: {opts['expectation']}",
             opts.get('speakers') and f"Speakers: {opts['speakers']}"]
    return '\n'.join(p for p in parts if p)


FULL_EXAMINE = ['claims', 'fallacies', 'answers', 'moderation', 'tally', 'contradictions']


def video_key(url):
    """One name for a video across every link to it: the YouTube id, else the link without its query."""
    vid = analysis.youtube_id(url)
    return f'yt:{vid}' if vid else url.split('?')[0].rstrip('/')


def _stance_line(stance):
    # The house rules already carry the rationalist standard; another stance picked for this link is added to the brief.
    return stance.get('standing', '') if stance.get('id') not in ('neutral', 'rationalist') else ''


def _claude_cards(rec, brief_text, language, examine, base=None, max_claims=25, progress=None):
    import reasoning
    if progress:
        progress(f'Claude is analysing record v{rec["version"]} ({language})' + (f' — refining v{base["version"]}' if base else ''))
    res = reasoning.analyse(rec, brief_text, language=language, examine=examine, base=base, max_claims=max_claims)
    cards = analysis.build_debate_cards(res, rec['lines'], examine)
    run = db.add_run(rec['vkey'], rec['id'], 'analyse', brief_text, res['model'], res['raw'],
                     {**res['usage'], 'cost': res['cost'], 'examine': examine, 'language': language},
                     base_run=base['id'] if base else None)
    return res, cards, run


def _reanalyse_job(opts, crit, progress):
    """A fresh Claude pass over a saved record — no download, no transcription."""
    rec = db.get_record(int(opts['recordId']))
    if not rec:
        raise analysis.AnalysisError('That record no longer exists.')
    base = db.get_run(int(opts['baseRun'])) if opts.get('baseRun') else None
    prev = db.list_runs(rec['vkey'], 'analyse')
    last_usage = (base or (prev[0] if prev else None) or {}).get('usage') or {}
    examine = opts.get('examine') or last_usage.get('examine') or (FULL_EXAMINE if rec['kind'] == 'debate' else ['claims', 'fallacies'])
    language = opts.get('language') or last_usage.get('language') or analysis.lang_for(crit.get('language'), rec['lang'])
    res, cards, run = _claude_cards(rec, opts.get('prompt', ''), language, examine, base=base,
                                    max_claims=int(crit.get('maxResults') or 25), progress=progress)
    vid = analysis.youtube_id(rec['url'])
    source = {'url': rec['url'], 'title': f'{rec["title"] or rec["url"]} — v{run["version"]}', 'duration': rec['duration'],
              'videoId': vid, 'start': 0, 'platform': 'youtube' if vid else 'other', 'video': rec['video'],
              'lines': rec['lines'], 'langCode': rec['lang'], 'transcriptVia': rec['via'], 'speakers': rec['speakers'],
              'recordId': rec['id'], 'runId': run['id'], 'analysedAt': time.time(), 'model': res['model'], 'language': language,
              'claims': len(res['claims']), 'fallacies': len(res['fallacies']), 'exchanges': len(res['exchanges'])}
    return source, cards


def process_job(job, progress):
    url = job['url']
    opts = job['options']
    crit = analysis.critique()
    stance = next((s for s in crit['stances'] if s['id'] == (opts.get('stanceId') or crit['activeId'])), crit['stances'][0])

    if opts.get('recordId'):
        return _reanalyse_job(opts, crit, progress)
    if opts.get('video'):
        return _process_range_job(opts, crit, stance, progress)
    progress('Reading the link')
    meta = analysis.probe(url)
    vid = analysis.youtube_id(url)
    source = {'url': url, 'title': meta['title'], 'uploader': meta['uploader'], 'duration': meta['duration'],
              'videoId': vid, 'start': analysis.youtube_start(url) if vid else 0, 'platform': 'youtube' if vid else 'other'}
    debate = opts.get('kind') in ('debate', 'panel')

    # The record is the one transcription of this video. A debate needs a speaker-labelled one; a speaker-
    # labelled record serves a plain analysis too.
    rec = db.latest_record(video_key(url))
    if rec and (rec['kind'] == 'debate' or not debate):
        progress(f'Using the saved record v{rec["version"]} — no new transcription')
        if rec['video'] and (MEDIA / rec['video'][len('/media/'):]).exists():
            source['video'] = rec['video']
        else:
            progress('Downloading the video')
            source['video'] = f'/media/video/{analysis.download_media(url, f"job{job["id"]}").name}'
        return _analyse_record(rec, source, opts, crit, stance, debate, progress)
    rec = None

    tr = None
    if vid:
        progress('Fetching captions')
        try:
            tr = analysis.youtube_captions(vid)
        except Exception as e:
            log.info('captions unavailable for %s: %s', vid, e)
    debate = opts.get('kind') in ('debate', 'panel')
    if debate:
        tr = None   # captions carry no speakers: a debate is always transcribed by ear
    # A video already in the library with its whole transcript is reused as it is — a plain transcript
    # carries no speakers, so a debate still needs its own.
    import videos   # videos imports core
    known = None if debate else videos.transcribed(url)
    if known:
        progress('Already transcribed — reusing the library copy')
        tr = db.get_video(known['id'], full=True)['transcript']
    # A finished transcription is kept with the job, so a retry after a failed analysis does not pay
    # for (or wait on) the transcription again.
    tr_cache = DATA / 'work' / f'job{job["id"]}-{"debate" if debate else "plain"}.transcript.json'
    if not tr and tr_cache.exists():
        tr = json.loads(tr_cache.read_text(encoding='utf-8'))
    # The video is always fetched: the canvas plays the clip before each fact-check and fallacy card.
    if known:
        path = videos._file(known)
        source['video'] = known['video']
    else:
        progress('Downloading the video')
        path = analysis.download_media(url, f'job{job["id"]}')
        source['video'] = f'/media/video/{path.name}'
    if not tr:
        progress('Transcribing who said what' if debate else 'Transcribing with Gemini')
        who = ' '.join(p for p in (opts.get('speakers'), opts.get('context') and f"(background: {opts['context']})") if p)
        tr = analysis.gemini_transcribe(path, speakers=who if debate else None, progress=progress)
        tr_cache.write_text(json.dumps(tr, ensure_ascii=False), encoding='utf-8')
    if not tr or not tr['lines']:
        raise analysis.AnalysisError('No speech found to analyse.')
    if source['duration']:
        # Gemini's clock can run a little past the end of the final part; the recording's own length wins.
        for l in tr['lines']:
            l['t'] = min(l['t'], max(0, source['duration'] - 1))
    speakers = tr.get('speakers') or sorted({l.get('speaker') for l in tr['lines'] if l.get('speaker')})
    rec = db.save_record(video_key(url), 'debate' if debate else 'plain', url, meta['title'], meta['duration'] or 0,
                         source['video'], tr['lines'], speakers, tr.get('langCode') or '', tr.get('via') or '')
    if opts.get('notify') and speakers:
        import relay
        relay.post_sync({'type': 'slidebook-record', **opts['notify'], 'recordId': rec['id'], 'title': rec['title'],
                         'speakers': speakers, 'url': url})
    return _analyse_record(rec, source, opts, crit, stance, debate, progress)


def _analyse_record(rec, source, opts, crit, stance, debate, progress):
    language = analysis.lang_for(opts.get('language') or crit.get('language'), rec['lang'])
    examine = (opts.get('examine') or FULL_EXAMINE) if debate else ['claims', 'fallacies']
    brief_text = '\n'.join(p for p in (brief(opts), _stance_line(stance)) if p)
    res, cards, run = _claude_cards(rec, brief_text, language, examine, max_claims=int(crit.get('maxResults') or 25), progress=progress)
    source.update(lines=rec['lines'], langCode=rec['lang'], transcriptVia=rec['via'], generated=True, speakers=rec['speakers'],
                  recordId=rec['id'], runId=run['id'], analysedAt=time.time(), model=res['model'], language=language,
                  stance=stance['name'], kind=opts.get('kind') or 'single', claims=len(res['claims']),
                  fallacies=len(res['fallacies']), exchanges=len(res['exchanges']))
    return source, cards


def _fmt(t):
    t = int(t)
    return f'{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}' if t >= 3600 else f'{t // 60}:{t % 60:02d}'


def _process_range_job(opts, crit, stance, progress):
    """A fact-check of one range of a video from the Videos window: the file is already downloaded and
    only the lines inside the range are analysed."""
    import videos
    v = db.get_video(opts['video'])
    if not v or v['status'] != 'ready':
        raise analysis.AnalysisError('The video is not downloaded yet.')
    start, end = opts['range']
    vid = analysis.youtube_id(v['url'])
    tr = videos.range_lines(v, start, end, progress)
    if not tr['lines']:
        raise analysis.AnalysisError('No speech in that range.')
    language = analysis.lang_for(opts.get('language') or crit.get('language'), tr.get('langCode') or 'en')
    progress(f'Fact-checking {_fmt(start)}–{_fmt(end)} ({language})')
    res = analysis.analyse_transcript(
        [{'ts': int(l['t'] * 1000), 'text': l['text']} for l in tr['lines']],
        language=language, temperature=float(crit.get('temperature', 0.3)), ridicule=float(crit.get('ridicule', 0)),
        max_results=int(crit.get('maxResults') or 0), custom_instruction=crit.get('customInstruction', ''),
        standing_instructions=stance.get('standing', ''))
    source = {'url': v['url'], 'title': f"{v['title'] or v['url']} ({_fmt(start)}–{_fmt(end)})", 'uploader': v['uploader'],
              'duration': v['duration'], 'videoId': vid, 'start': start, 'platform': 'youtube' if vid else 'other',
              'video': v['video'], 'range': [start, end], 'lines': tr['lines'], 'langCode': tr.get('langCode'),
              'transcriptVia': tr.get('via'), 'generated': tr.get('generated'), 'analysedAt': time.time(), 'model': res['model'],
              'language': language, 'stance': stance['name'], 'claims': len(res['claims']), 'fallacies': len(res['fallacies'])}
    return source, analysis.build_cards(res, tr['lines'])


async def worker():
    while True:
        job = db.claim_job()
        if not job:
            await asyncio.sleep(1.5)
            continue
        loop = asyncio.get_running_loop()

        def progress(step, jid=job['id']):
            db.update_job(jid, step=step)
            asyncio.run_coroutine_threadsafe(broadcast({'type': 'job', 'job': db.get_job(jid)}), loop)

        await broadcast({'type': 'job', 'job': db.get_job(job['id'])})
        try:
            source, cards = await asyncio.to_thread(process_job, job, progress)
            target = job['book_id'] if job['mode'] == 'append' and job['book_id'] and db.get_book(job['book_id']) else None
            if target:
                await edit_manifest(target, lambda m: m + cards)
                book_id = target
            else:
                book = db.create_book(source['title'][:120], manifest=cards, source=source)
                book_id = book['id']
                await book_changed(book_id)
            if source.get('runId'):
                db.set_run_book(source['runId'], book_id)
            db.update_job(job['id'], status='done', step=f'{source["claims"]} claims, {source["fallacies"]} fallacies', book_id=book_id, error='')
        except Exception as e:
            log.warning('job %s failed: %s', job['id'], traceback.format_exc())
            attempts = job['attempts'] + 1
            permanent = isinstance(e, analysis.AnalysisError) or attempts >= MAX_ATTEMPTS
            db.update_job(job['id'], attempts=attempts, error=str(e)[:500],
                          status='failed' if permanent else 'pending', next_at=time.time() + 30 * 2 ** attempts,
                          step='Failed' if permanent else f'Retrying (attempt {attempts + 1})')
        await broadcast({'type': 'job', 'job': db.get_job(job['id'])})
