import asyncio, json, logging, mimetypes, re, time
from pathlib import Path

from aiohttp import WSMsgType, web

import analysis, bot, core, db, relay, shorts, videos
from paths import DATA, DIST, FONTS, MEDIA, PORT, USER_SFX

log = logging.getLogger('slidebook')
routes = web.RouteTableDef()


def ok(data=None, status=200):
    return web.json_response(data if data is not None else {'ok': True}, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


def already(body, what, at=None):
    """An AI action that was already done: the app asks before it runs again (409; resent with force)."""
    if body.get('force') or not what:
        return None
    when = f' on {time.strftime("%d %b %H:%M", time.localtime(at))}' if at else ''
    text = what.replace('{when}', when) if '{when}' in what else f'{what}{when}.'
    return web.json_response({'already': text}, status=409)


def _same(a, b):
    return abs(float(a) - float(b)) < 0.5


def bad(msg, status=400):
    return web.json_response({'error': msg}, status=status)


def book_or_404(book_id):
    b = db.get_book(book_id)
    if not b:
        raise web.HTTPNotFound(text='no such book')
    return b


# ── pages ─────────────────────────────────────────────────────────────────────

def _page(name):
    async def handler(_):
        f = DIST / name
        if not f.exists():
            return web.Response(text='Frontend not built — run npm run build in web/.', status=500)
        return web.FileResponse(f, headers={'Cache-Control': 'no-store'})
    return handler


# ── books ─────────────────────────────────────────────────────────────────────

@routes.get('/api/books')
async def books(_):
    return ok(db.list_books())


@routes.get('/api/books/open')
async def book_open(_):
    """The book open in the editor (for the bot's "add to the open SlideBook")."""
    bid = (core.state.get('view') or {}).get('bookId')
    b = db.get_book(bid) if bid else None
    return ok({'bookId': b['id'], 'title': b['title'], 'pages': len(b['manifest'])} if b else {'bookId': None})


@routes.post('/api/books')
async def book_create(req):
    body = await req.json()
    b = db.create_book((body.get('title') or 'Untitled book').strip()[:120], group=body.get('group', ''))
    await core.book_changed(b['id'])
    return ok(b)


@routes.get('/api/books/{id}')
async def book_get(req):
    return ok(book_or_404(req.match_info['id']))


@routes.patch('/api/books/{id}')
async def book_patch(req):
    bid = req.match_info['id']
    book_or_404(bid)
    body = await req.json()
    b = db.update_book(bid, **{k: v for k, v in body.items() if k in ('title', 'group', 'styles', 'cardAspect')})
    await core.book_changed(bid)
    if 'styles' in body:
        await core.refresh_clip(bid)
    return ok(b)


@routes.delete('/api/books/{id}')
async def book_delete(req):
    bid = req.match_info['id']
    db.delete_book(bid)
    for key in ('view', 'live'):
        if core.state[key] and core.state[key]['bookId'] == bid:
            await core.control('unair') if key == 'live' else None
            core.state[key] = None
            db.set_setting(key, None)
    await core.book_changed(bid)
    await core.broadcast(core.snapshot())
    return ok()


def _after(v):
    try:
        return int(v) if v not in (None, '', 'null') else None
    except ValueError:
        return None


@routes.post('/api/books/{id}/pages/files')
async def pages_files(req):
    """Images and PDFs from disk, in the order given, inserted after `afterIndex` (0-based count)."""
    bid = req.match_info['id']
    book_or_404(bid)
    reader = await req.multipart()
    after, pages = None, []
    while (part := await reader.next()) is not None:
        if part.name == 'afterIndex':
            after = _after(await part.text())
            continue
        fname = part.filename or 'file'
        ext = Path(fname).suffix.lower()
        if ext in core.VIDEO_EXTS:
            # Streamed to disk (a video can be hundreds of MB), named by its content so a re-add reuses the file.
            import hashlib
            (MEDIA / 'video').mkdir(parents=True, exist_ok=True)
            tmp, h = MEDIA / 'video' / f'up-{time.time_ns()}{ext}', hashlib.sha1()
            with open(tmp, 'wb') as f:
                while chunk := await part.read_chunk(1 << 20):
                    h.update(chunk)
                    f.write(chunk)
            dest = MEDIA / 'video' / f'slide-{h.hexdigest()[:16]}{ext}'
            if dest.exists():
                tmp.unlink()
            else:
                tmp.replace(dest)
            try:
                pages.append(await asyncio.to_thread(core.video_page, dest, Path(fname).stem))
            except analysis.AnalysisError:
                continue
            continue
        data = await part.read(decode=False)
        if ext == '.pdf':
            pages += await asyncio.to_thread(core.pdf_pages, bytes(data))
        else:
            try:
                ref, aspect = core.write_image(bytes(data), ext)
            except Exception:
                continue
            pages.append({'id': db.new_id('img-'), 'kind': 'image', 'ref': ref, 'aspect': aspect, 'label': Path(fname).stem[:40]})
    if not pages:
        return bad('no readable image, PDF or video in the upload')
    b = await core.edit_manifest(bid, lambda m: core.insert_pages(m, pages, after))
    return ok({'book': b, 'added': len(pages)})


async def add_video_slide(bid, url, label=''):
    """A link as a video slide at the end of the book: the Videos library's copy when it has one,
    otherwise downloaded (in the background; the slide appears when the file is in)."""
    lib = db.video_by_url(url)
    if lib and lib.get('video'):
        path = MEDIA / lib['video'][len('/media/'):]
        label = label or lib.get('title') or ''
    else:
        await core.broadcast({'type': 'videoFetch', 'bookId': bid, 'status': 'running'})
        path = await asyncio.to_thread(analysis.download_media, url, f'slide-{int(time.time())}')
    page = await asyncio.to_thread(core.video_page, path, label or path.stem)
    b = await core.edit_manifest(bid, lambda m: core.insert_pages(m, [page]))
    await core.broadcast({'type': 'videoFetch', 'bookId': bid, 'status': 'done'})
    return b, page


@routes.post('/api/books/{id}/pages/video')
async def pages_video(req):
    bid = req.match_info['id']
    book_or_404(bid)
    url = ((await req.json()).get('url') or '').strip()
    if not url.startswith(('http://', 'https://')):
        return bad('Paste a video link.')

    async def run():
        try:
            await add_video_slide(bid, url)
        except Exception as e:
            log.exception('video slide failed')
            await core.broadcast({'type': 'videoFetch', 'bookId': bid, 'status': 'failed', 'error': str(e)[:300]})
    asyncio.ensure_future(run())
    return ok({'started': True})


@routes.post('/api/books/{id}/pages/card')
async def page_card(req):
    bid = req.match_info['id']
    book_or_404(bid)
    body = await req.json()
    kind = body.get('kind') if body.get('kind') in ('claim', 'fallacy') else 'claim'
    card = {'title': '', 'body': '', 'verdict': 'FALSE' if kind == 'claim' else '', 'severity': 'MEDIUM' if kind == 'claim' else '',
            'passage': '', 'sources': [], **(body.get('card') or {})}
    page = {'id': db.new_id('c-'), 'kind': kind, 'card': card}
    b = await core.edit_manifest(bid, lambda m: core.insert_pages(m, [page], _after(body.get('afterIndex'))))
    return ok({'book': b, 'page': page})


@routes.patch('/api/books/{id}/pages/{pid}')
async def page_patch(req):
    bid, pid = req.match_info['id'], req.match_info['pid']
    book_or_404(bid)
    body = await req.json()

    def fn(m):
        for p in m:
            if p['id'] == pid:
                if 'hidden' in body:
                    p['hidden'] = bool(body['hidden'])
                if 't' in body and p['kind'] not in db.CARD_KINDS:
                    if body['t'] is None:
                        p.pop('t', None)
                    else:
                        p['t'] = float(body['t'])
                if 'card' in body and p['kind'] in db.CARD_KINDS:
                    p['card'] = {**p.get('card', {}), **body['card']}
                if 'kind' in body and body['kind'] in ('claim', 'fallacy') and p['kind'] in ('claim', 'fallacy'):
                    p['kind'] = body['kind']
        return m
    return ok(await core.edit_manifest(bid, fn))


@routes.post('/api/books/{id}/pages/delete')
async def pages_delete(req):
    bid = req.match_info['id']
    book_or_404(bid)
    ids = set((await req.json()).get('pageIds') or [])
    return ok(await core.edit_manifest(bid, lambda m: [p for p in m if p['id'] not in ids]))


@routes.post('/api/books/{id}/pages/reorder')
async def pages_reorder(req):
    bid = req.match_info['id']
    book_or_404(bid)
    body = await req.json()
    frm, to = int(body['from']) - 1, int(body['to']) - 1

    def fn(m):
        if 0 <= frm < len(m) and 0 <= to < len(m):
            p = m.pop(frm)
            m.insert(to, p)
            # An image or video slide joins the time slot it is moved into: moved up, the one of the slide now
            # below it; moved down, the one above. A card keeps its own statement time.
            if p.get('kind') not in db.CARD_KINDS:
                nb = (m[to + 1] if to + 1 < len(m) else None) if to < frm else (m[to - 1] if to > 0 else None)
                t = core.seg_time(nb)
                if t is None:
                    p.pop('t', None)
                else:
                    p['t'] = t
        return m
    return ok(await core.edit_manifest(bid, fn))


@routes.post('/api/books/{id}/pages/copy')
async def pages_copy(req):
    bid = req.match_info['id']
    book_or_404(bid)
    body = await req.json()
    src = book_or_404(body['fromBookId'])
    want = body.get('pageIds') or []
    picked = [p for pid in want for p in src['manifest'] if p['id'] == pid]
    styles = src['styles'].get('pages') or {}
    copies, style_copies = [], {}
    for p in picked:
        c = json.loads(json.dumps(p))
        c['id'] = db.new_id('c-' if p['kind'] in db.CARD_KINDS else 'img-')
        copies.append(c)
        if p['id'] in styles:
            style_copies[c['id']] = styles[p['id']]
    if style_copies:
        dst = db.get_book(bid)
        st = dst['styles']
        st['pages'] = {**(st.get('pages') or {}), **style_copies}
        db.update_book(bid, styles=st)
    return ok(await core.edit_manifest(bid, lambda m: core.insert_pages(m, copies, _after(body.get('afterIndex')))))


@routes.post('/api/media/audio')
async def media_audio(req):
    reader = await req.multipart()
    part = await reader.next()
    data = await part.read(decode=False)
    return ok({'url': core.write_audio(bytes(data), Path(part.filename or 'a.mp3').suffix)})


@routes.get('/media/{path:.+}')
async def media(req):
    p = (MEDIA / req.match_info['path']).resolve()
    if MEDIA.resolve() not in p.parents or not p.is_file():
        raise web.HTTPNotFound()
    # Videos are never cached: Chrome lets only one request at a time fill a cache entry, so while one
    # player was still buffering a long file, the next player of the same file sat with nothing loaded
    # (the blank clip box). They are local and range-read, so caching bought nothing.
    if req.match_info['path'].startswith('video/'):
        return web.FileResponse(p, headers={'Cache-Control': 'no-store'})
    return web.FileResponse(p, headers={'Cache-Control': 'public, max-age=31536000, immutable'})


# ── fonts (the bundled library; the renderer asks /api/titles/fonts/<id>.ttf) ─

@routes.get('/api/fonts')
async def fonts(_):
    out = []
    if FONTS.exists():
        for f in sorted(FONTS.iterdir()):
            if f.suffix.lower() in ('.ttf', '.otf'):
                out.append({'family': f.stem, 'label': f.stem.replace('-', ' ').replace('_', ' '), 'url': f'/api/titles/fonts/{f.name}'})
    return ok(out)


@routes.get('/api/titles/fonts/{name}')
async def font_file(req):
    p = (FONTS / req.match_info['name']).resolve()
    if FONTS.resolve() not in p.parents or not p.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(p, headers={'Cache-Control': 'public, max-age=86400'})


# ── control + live state ──────────────────────────────────────────────────────

@routes.get('/api/state')
async def get_state(_):
    return ok(core.snapshot())


@routes.post('/api/control')
async def post_control(req):
    body = await req.json()
    return ok(await core.control(body.get('action'), body.get('bookId'), body.get('page'), body.get('target') == 'live',
                                 replay=bool(body.get('replay')), edit=bool(body.get('edit'))))


@routes.post('/api/plain')
async def post_plain(req):
    core.plain = bool((await req.json()).get('on'))
    db.set_setting('plain', core.plain)
    await core.broadcast(core.snapshot({'event': 'plain'}))
    return ok({'plain': core.plain})


@routes.post('/api/cue')
async def post_cue(req):
    """Ask the Video window to jump to a second of the book's source video."""
    body = await req.json()
    await core.broadcast({'type': 'cue', 'bookId': body.get('bookId'), 't': float(body.get('t') or 0)})
    return ok()


@routes.post('/api/due')
async def post_due(req):
    """The Video window, following the slides, has played past the next card's moment: the editor
    pulses that page so the presenter knows to step. Never steps by itself (SLIDEBOOK_PLAN.md §11.5)."""
    body = await req.json()
    await core.broadcast({'type': 'due', 'bookId': body.get('bookId'), 'page': body.get('page')})
    return ok()


_fetching = set()


@routes.post('/api/books/{id}/video/fetch')
async def video_fetch(req):
    """Download a book's source video for the canvas (books analysed before it was kept had audio only)."""
    bid = req.match_info['id']
    b = book_or_404(bid)
    url = (b.get('source') or {}).get('url')
    if not url:
        raise web.HTTPBadRequest(text='This book has no source link.')
    if bid in _fetching:
        return ok({'fetching': True})
    _fetching.add(bid)

    async def run():
        await core.broadcast({'type': 'videoFetch', 'bookId': bid, 'status': 'running'})
        try:
            path = await asyncio.to_thread(analysis.download_media, url, f'book{bid}')
            cur = db.get_book(bid)
            if cur:
                db.update_book(bid, source={**(cur.get('source') or {}), 'video': f'/media/video/{path.name}'})
                await core.book_changed(bid)
            await core.broadcast({'type': 'videoFetch', 'bookId': bid, 'status': 'done'})
        except Exception as e:
            log.exception('video fetch failed')
            await core.broadcast({'type': 'videoFetch', 'bookId': bid, 'status': 'failed', 'error': str(e)[:300]})
        finally:
            _fetching.discard(bid)
    asyncio.ensure_future(run())
    return ok({'fetching': True})


@routes.get('/api/poster/{name}')
async def poster(req):
    """One frame of a book's video as a JPEG — what a clip shows while it flies in and before it plays,
    and all a frozen clip ever needs. Made once by ffmpeg and cached (an image, so cacheable)."""
    try:
        t = float(req.query.get('t', '0'))
    except ValueError:
        raise web.HTTPBadRequest()
    p = await asyncio.to_thread(core.poster_file, req.match_info['name'], t)
    if not p:
        raise web.HTTPNotFound()
    return web.FileResponse(p, headers={'Cache-Control': 'public, max-age=31536000, immutable'})


@routes.post('/api/transport')
async def post_transport(req):
    """The clip panel's play / pause: every window showing a clip follows it (the canvas, `/output`)."""
    body = await req.json()
    if body.get('action') in ('play', 'pause'):
        await core.broadcast({'type': 'transport', 'bookId': body.get('bookId'), 'action': body['action']})
    elif body.get('action') == 'seek':
        await core.broadcast({'type': 'transport', 'bookId': body.get('bookId'), 'action': 'seek', 't': float(body.get('t') or 0)})
    return ok()


@routes.post('/api/clipclock')
async def post_clipclock(req):
    """`/output`'s playhead for the clip on air, ~4 times a second; the canvas copy follows it."""
    body = await req.json()
    await core.broadcast({'type': 'clipclock', 'seq': body.get('seq'), 't': float(body.get('t') or 0), 'playing': bool(body.get('playing'))})
    return ok()


@routes.post('/api/books/{id}/video/loudness')
async def video_loudness(req):
    """Bring a book's already-downloaded video to broadcast loudness (files fetched before the pass)."""
    bid = req.match_info['id']
    b = book_or_404(bid)
    rel = (b.get('source') or {}).get('video') or ''
    if not rel.startswith('/media/'):
        raise web.HTTPBadRequest(text='This book has no downloaded video.')
    src = MEDIA / rel[len('/media/'):]
    path = await asyncio.to_thread(analysis.normalize_audio, src)
    if path != src or path.stem.endswith('.loud'):
        cur = db.get_book(bid)
        db.update_book(bid, source={**(cur.get('source') or {}), 'video': f'/media/video/{path.name}'})
        await core.book_changed(bid)
    return ok({'video': f'/media/video/{path.name}', 'normalized': path.stem.endswith('.loud')})


@routes.post('/api/clip')
async def post_clip(req):
    """`/output`: `here` (a heartbeat, so a step knows the clip will be played) or `done` (the clip
    before a card has played out, so the card may show)."""
    body = await req.json()
    if body.get('phase') == 'done':
        await core.clip_done(body.get('bookId'), body.get('page'), body.get('seq'))
    else:
        core.player_seen = time.time()
    # The heartbeat's answer: is the sound-effect source open? Then the output leaves the slide-change
    # sound to it, so OBS has the effect on a fader of its own.
    return ok({'sfx': time.time() - core.sfx_seen < 8})


@routes.post('/api/sfx')
async def post_sfx(req):
    """`/sfx` (the OBS sound-effect source) is open."""
    core.sfx_seen = time.time()
    return ok()


@routes.get('/ws')
async def ws_handler(req):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(req)
    core.clients.add(ws)
    await ws.send_str(json.dumps(core.snapshot()))
    await ws.send_str(json.dumps(bot.snapshot()))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT and msg.data == 'ping':
                await ws.send_str('{"type":"pong"}')
    finally:
        core.clients.discard(ws)
    return ws


# ── analysis queue ────────────────────────────────────────────────────────────

@routes.post('/api/analyse')
async def analyse(req):
    """A link to analyse — pasted in the app, or sent by StudioMate's bot with the Mini App's answers
    (`kind`, `examine`, `speakers`, `stanceId`, `lang`, `expectation`, `mode`, `notify`)."""
    body = await req.json()
    url = (body.get('url') or '').strip()
    if not url.startswith(('http://', 'https://')):
        return bad('paste a full link (https://…)')
    book_id = body.get('bookId')
    if body.get('mode') == 'live':
        book_id = (core.state.get('live') or {}).get('bookId')
    opts = {k: body[k] for k in ('language', 'stanceId', 'instruction', 'kind', 'examine', 'speakers', 'context', 'expectation', 'notify', 'transcribeOnly')
            if body.get(k)}
    if body.get('lang') in LANGS:
        opts['language'] = LANGS[body['lang']]
    known = videos.transcribed(url) if body.get('kind') not in ('debate', 'panel') else None
    keys = ('kind', 'language', 'stanceId', 'instruction', 'examine', 'speakers', 'expectation')
    prev = next((j for j in db.done_jobs(url) if not j['options'].get('video')
                 and all(j['options'].get(k) == opts.get(k) for k in keys)), None)
    prev_note = 'This link was already analysed with the same settings' if prev else ''
    if (body.get('origin') or 'app') == 'app' and (r := already(body, prev_note, prev and prev['updated_at'])):
        return r
    if (body.get('origin') or 'app') != 'app':
        asyncio.ensure_future(videos.ingest(url, body['origin'], sender=body.get('sender')))
    jid = db.enqueue(url, body.get('origin') or 'app', mode='append' if book_id else 'new', book_id=book_id,
                     chat_id=(body.get('notify') or {}).get('chatId'), options=opts)
    job = db.get_job(jid)
    await core.broadcast({'type': 'job', 'job': job})
    warn = ' '.join(x for x in ((videos.already_note(known) or {}).get('warning', '') if known else '',
                                 prev_note + ' — analysing it again.' if prev else '') if x)
    return ok({**job, 'existing': {**(videos.already_note(known) if known else {}), 'warning': warn}} if warn else job)


LANGS = {'ml': 'Malayalam', 'en': 'English'}


@routes.get('/api/stances')
async def stances(_):
    crit = analysis.critique()
    return ok({'activeId': crit['activeId'], 'stances': [{'id': s['id'], 'name': s['name']} for s in crit['stances']]})


@routes.get('/api/jobs')
async def jobs(_):
    return ok(db.list_jobs())


@routes.post('/api/jobs/{id}/retry')
async def job_retry(req):
    jid = int(req.match_info['id'])
    db.update_job(jid, status='pending', attempts=0, next_at=0, error='', step='Queued')
    await core.broadcast({'type': 'job', 'job': db.get_job(jid)})
    return ok()


# ── records: the text record of each video, and the Claude runs made from it ──

def record_or_404(rid, full=True):
    r = db.get_record(int(rid), full)
    if not r:
        raise web.HTTPNotFound(text='no such record')
    return r


def _record_summary(r):
    runs = db.list_runs(r['vkey'])
    analyses = [x for x in runs if x['kind'] == 'analyse']
    return {**r, 'videoId': analysis.youtube_id(r['url']), 'analyses': len(analyses),
            'asks': sum(1 for x in runs if x['kind'] == 'ask'), 'reports': sum(1 for x in runs if x['kind'] == 'report'),
            'lastBookId': next((x['book_id'] for x in analyses if x['book_id']), None)}


@routes.get('/api/records')
async def records_list(_):
    return ok([_record_summary(r) for r in db.list_records()])


@routes.get('/api/records/{id}')
async def record_get(req):
    r = record_or_404(req.match_info['id'])
    return ok({**_record_summary({k: v for k, v in r.items() if k != 'lines'}), 'lines': r['lines'], 'runs': db.list_runs(r['vkey'])})


@routes.get('/api/records/{id}/transcript.txt')
async def record_text(req):
    import reasoning
    r = record_or_404(req.match_info['id'])
    return web.Response(text=f'{r["title"]}\n{r["url"]}\n\n{reasoning.record_text(r)}\n', content_type='text/plain', charset='utf-8')


@routes.put('/api/records/{id}/names')
async def record_names(req):
    r = record_or_404(req.match_info['id'], full=False)
    names = {str(k): str(v).strip() for k, v in ((await req.json()).get('names') or {}).items() if str(v).strip()}
    return ok(db.set_record_names(r['id'], names))


@routes.post('/api/records/{id}/reanalyse')
async def record_reanalyse(req):
    """A fresh Claude analysis of the saved record, optionally refining an earlier run with feedback."""
    r = record_or_404(req.match_info['id'], full=False)
    body = await req.json()
    if body.get('baseRun') and not db.get_run(int(body['baseRun'])):
        return bad('no such earlier analysis')
    opts = {'recordId': r['id'], **{k: body[k] for k in ('prompt', 'baseRun', 'examine', 'language', 'notify') if body.get(k)}}
    jid = db.enqueue(r['url'], body.get('origin') or 'app', chat_id=(body.get('notify') or {}).get('chatId'), options=opts)
    job = db.get_job(jid)
    await core.broadcast({'type': 'job', 'job': job})
    return ok(job)


@routes.post('/api/records/{id}/ask')
async def record_ask(req):
    import reasoning
    r = record_or_404(req.match_info['id'])
    q = ((await req.json()).get('question') or '').strip()
    if not q:
        return bad('ask a question')
    try:
        a = await asyncio.to_thread(reasoning.ask, r, q)
    except reasoning.ClaudeError as e:
        return bad(str(e), 502)
    run = db.add_run(r['vkey'], r['id'], 'ask', q, a['model'], a['answer'], {**a['usage'], 'cost': a['cost']})
    return ok({'answer': a['answer'], 'runId': run['id'], 'url': r['url'], 'videoId': analysis.youtube_id(r['url']), 'title': r['title']})


async def _write_reports(r, request, base, languages, deliver=None):
    """Claude writes each report in turn (the second reads the record from the prompt cache). With
    `deliver` (a Telegram chat id) each one goes to StudioMate's bot as soon as it is saved."""
    import reasoning
    made = []
    for language in languages:
        try:
            rep = await asyncio.to_thread(reasoning.write_report, r, request, base['result'] if base else None, language)
        except reasoning.ClaudeError as e:
            if deliver:
                await relay.post({'type': 'slidebook-report', 'chatId': deliver, 'error': str(e), 'title': r['title']})
            if made or deliver:
                break
            raise
        await asyncio.to_thread(reasoning.add_frames, r, rep['report'], db.new_id('r'))
        run = db.add_run(r['vkey'], r['id'], 'report', request, rep['model'], json.dumps(rep['report'], ensure_ascii=False),
                         {**rep['usage'], 'cost': rep['cost'], 'language': language}, base_run=base['id'] if base else None)
        made.append({'runId': run['id'], 'version': run['version'], 'language': language, 'title': rep['report'].get('title', '')})
        if deliver:
            await relay.post({'type': 'slidebook-report', 'runId': run['id'], 'chatId': deliver})
    if request:
        asyncio.ensure_future(asyncio.to_thread(reasoning.learn_guidance, request))
    return made


@routes.post('/api/records/{id}/report')
async def record_report(req):
    """A phone report written by Claude from the record and an analysis (the given run, else the newest),
    shaped by the free-text request and the learned report preferences. The request is then folded into
    those preferences, so the next report starts closer to what is wanted. Always English then Malayalam
    unless one language is named. With `deliver` it answers at once and the PDFs follow in Telegram."""
    import reasoning
    r = record_or_404(req.match_info['id'])
    body = await req.json()
    request = (body.get('request') or '').strip()
    runs = db.list_runs(r['vkey'], 'analyse')
    base = db.get_run(int(body['runId'])) if body.get('runId') else (runs[0] if runs else None)
    languages = [body['language']] if body.get('language') in ('English', 'Malayalam') else ['English', 'Malayalam']
    if body.get('deliver'):
        asyncio.ensure_future(_write_reports(r, request, base, languages, int(body['deliver'])))
        return ok({'queued': True, 'languages': languages, 'title': r['title']})
    try:
        made = await _write_reports(r, request, base, languages)
    except reasoning.ClaudeError as e:
        return bad(str(e), 502)
    return ok({'reports': made, 'runId': made[0]['runId'], 'url': r['url'], 'videoId': analysis.youtube_id(r['url']), 'title': r['title']})


@routes.get('/api/reports')
async def reports_list(_):
    """Every saved report, newest first, with the transcript it was written from."""
    out = []
    for rec in db.list_records():
        for run in db.list_runs(rec['vkey'], 'report'):
            try:
                title = json.loads(run['result']).get('title', '')
            except ValueError:
                title = ''
            out.append({'id': run['id'], 'version': run['version'], 'request': run['prompt'], 'title': title, 'createdAt': run['created_at'],
                        'language': (run.get('usage') or {}).get('language', ''),
                        'recordId': rec['id'], 'recordTitle': rec['title'], 'url': rec['url']})
    return ok(sorted(out, key=lambda x: -x['createdAt']))


@routes.get('/api/runs/{id}/report.html')
async def run_report_html(req):
    import report_html
    run = db.get_run(int(req.match_info['id']))
    if not run or run['kind'] != 'report':
        raise web.HTTPNotFound(text='no such report')
    rec = db.get_record(run['record_id'], full=False) or {}
    page = report_html.render(json.loads(run['result']), url=rec.get('url', ''), video_id=analysis.youtube_id(rec.get('url') or ''),
                              made_at=run['created_at'], request=run['prompt'], screen=req.query.get('screen') == '1')
    return web.Response(text=page, content_type='text/html', charset='utf-8', headers={'Cache-Control': 'no-store'})


@routes.post('/api/runs/{id}/telegram')
async def run_to_telegram(req):
    """StudioMate's bot prints this report to a phone PDF and sends it to `chatId`, else the owner."""
    run = db.get_run(int(req.match_info['id']))
    if not run or run['kind'] != 'report':
        return bad('no such report')
    chat = ((await req.json()) if req.can_read_body else {}).get('chatId')
    await relay.post({'type': 'slidebook-report', 'runId': run['id'], **({'chatId': int(chat)} if chat else {})})
    return ok()


@routes.get('/api/runs/{id}')
async def run_get(req):
    run = db.get_run(int(req.match_info['id']))
    if not run:
        raise web.HTTPNotFound(text='no such run')
    rec = db.get_record(run['record_id'], full=False) or {}
    return ok({**run, 'url': rec.get('url'), 'title': rec.get('title'), 'videoId': analysis.youtube_id(rec.get('url') or '')})


@routes.get('/api/report-guidance')
async def report_guidance_get(_):
    import reasoning
    return ok({'text': reasoning.report_guidance(), 'default': reasoning.DEFAULT_REPORT_GUIDANCE})


@routes.put('/api/report-guidance')
async def report_guidance_put(req):
    text = ((await req.json()).get('text') or '').strip()
    db.set_setting('reportGuidance', text or None)
    return ok()


@routes.get('/api/house-rules')
async def house_rules_get(_):
    import reasoning
    return ok({'text': reasoning.house_rules(), 'default': reasoning.DEFAULT_HOUSE_RULES})


@routes.put('/api/house-rules')
async def house_rules_put(req):
    text = ((await req.json()).get('text') or '').strip()
    db.set_setting('houseRules', text or None)
    return ok()


# ── settings ──────────────────────────────────────────────────────────────────

@routes.get('/api/settings')
async def settings_get(_):
    return ok({
        'hasGeminiKey': bool(analysis.gemini_key()),
        'critique': analysis.critique(),
        'port': PORT,
        'cardLook': db.get_setting('cardLook'),
    })


@routes.put('/api/settings')
async def settings_put(req):
    body = await req.json()
    if body.get('geminiKey'):
        db.set_setting('geminiKey', body['geminiKey'].strip())
    if 'critique' in body:
        db.set_setting('critique', body['critique'])
    if 'cardLook' in body:
        db.set_setting('cardLook', body['cardLook'])
    if 'defaultStyles' in body:
        db.set_setting('defaultStyles', body['defaultStyles'])
    return await settings_get(req)


# ── videos (the Videos window) ────────────────────────────────────────────────

def video_or_404(req):
    v = db.get_video(int(req.match_info['id']))
    if not v:
        raise web.HTTPNotFound(text='no such video')
    return v


@routes.get('/api/videos')
async def videos_list(_):
    return ok([videos.payload(v) for v in db.list_videos()])


@routes.post('/api/videos')
async def videos_add(req):
    url = ((await req.json()).get('url') or '').strip()
    if not url.startswith(('http://', 'https://')):
        return bad('paste a full link (https://…)')
    known = videos.transcribed(url)
    return ok({**videos.payload(await videos.ingest(url, 'app')), **({'existing': videos.already_note(known)} if known else {})})


@routes.delete('/api/videos/{id}')
async def videos_delete(req):
    v = video_or_404(req)
    if videos.busy.get(v['id']):
        return bad(f"Busy: {videos.busy[v['id']]} — try again when it finishes.")
    n = videos.purge(v)
    await core.broadcast({'type': 'videoGone', 'videoId': v['id']})
    return ok({'files': n})


@routes.get('/api/videos/{id}/files')
async def videos_files(req):
    """What a delete would remove, so the app can say so before it happens."""
    v = video_or_404(req)
    files = videos.files_of(v)
    renders = sum(len(p.get('renders') or []) for p in v.get('plans') or [])
    return ok({'files': len(files), 'bytes': sum(f.stat().st_size for f in files), 'renders': renders,
               'clips': len(v.get('shorts') or []), 'subtitles': len(v.get('subtitles') or []),
               'plans': len(v.get('plans') or []), 'sharedWithBook': bool(db.book_video_for(v['url']))})


@routes.post('/api/videos/{id}/retry')
async def videos_retry(req):
    v = video_or_404(req)
    db.update_video(v['id'], status='pending', error='', step='Queued')
    await videos.publish(v['id'])
    return ok()


@routes.post('/api/videos/{id}/{action:factcheck|summary|short|clip|subtitles}')
async def videos_action(req):
    v = video_or_404(req)
    if v['status'] != 'ready':
        return bad('The video is not downloaded yet.')
    if videos.busy.get(v['id']):
        return bad(f"Busy: {videos.busy[v['id']]}")
    body = await req.json()
    try:
        start, end = videos.clamp_range(v, body.get('start'), body.get('end'))
    except analysis.AnalysisError as e:
        return bad(str(e))
    action = req.match_info['action']
    if action == 'factcheck':
        prev = next((j for j in db.done_jobs(v['url']) if j['options'].get('video') == v['id']
                     and _same(j['options']['range'][0], start) and _same(j['options']['range'][1], end)), None)
        if prev and (r := already(body, 'This range was already fact-checked', prev['updated_at'])):
            return r
    elif action == 'summary':
        prev = next((s for s in v.get('summaries') or [] if _same(s['start'], start) and _same(s['end'], end)), None)
        if prev and (r := already(body, 'This range was already summarised', prev.get('at'))):
            return r
    elif action == 'subtitles':
        lang = body.get('lang') or 'Original'
        prev = next((s for s in v.get('subtitles') or [] if s.get('lang') == lang and _same(s['start'], start) and _same(s['end'], end)), None)
        if prev and (r := already(body, f'{lang} subtitles were already made for this range', prev.get('at'))):
            return r
    if action == 'factcheck':
        job = videos.fact_check(v, start, end)
        await core.broadcast({'type': 'job', 'job': job})
        return ok(job)
    arg = None
    if action == 'clip':
        arg = (body.get('folder') or '').strip()
        if not arg or not Path(arg).is_dir():
            return bad('Pick a folder to save the clip in.')
        db.set_setting('clipFolder', arg)
    if action == 'subtitles':
        arg = body.get('lang') or 'Original'
        if arg not in videos.SUB_LANGS:
            return bad(f'Subtitles come in: {", ".join(videos.SUB_LANGS)}')
    asyncio.ensure_future(videos.run_range_task(v, action, start, end, arg))
    return ok({'started': action})


@routes.get('/api/videos/clip-folder')
async def videos_clip_folder(_):
    return ok({'folder': db.get_setting('clipFolder') or ''})


# ── the Short builder ─────────────────────────────────────────────────────────

@routes.get('/api/videos/{id}/transcript')
async def videos_transcript(req):
    v = db.get_video(int(req.match_info['id']), full=True)
    if not v:
        raise web.HTTPNotFound(text='no such video')
    tr = v.get('transcript') or {}
    lines = tr.get('lines') or []
    return ok({'lines': lines, 'ends': shorts.ends_of(lines, v['duration']) if lines else [], 'langCode': tr.get('langCode') or '',
               'via': tr.get('via') or '', 'error': tr.get('error') or '', 'limit': shorts.LIMIT})


@routes.post('/api/videos/{id}/transcribe')
async def videos_transcribe(req):
    """Throw the transcript away and make it again (the background worker picks it up)."""
    v = video_or_404(req)
    body = await req.json() if req.can_read_body else {}
    if videos.transcribed(v['url']) and (r := already(body, 'This video already has a transcript')):
        return r
    # The shorts stay: when the new transcript is in, each is found again in it by its words (shorts.remap_plans).
    shorts.keep_for_retranscribe(v)
    db.update_video(v['id'], transcript='')
    await videos.publish(v['id'])
    return ok()


def _ready_or_bad(v):
    if v['status'] != 'ready':
        return bad('The video is not downloaded yet.')
    if videos.busy.get(v['id']):
        return bad(f"Busy: {videos.busy[v['id']]}")
    return None


@routes.post('/api/videos/{id}/shorts/find')
async def shorts_find(req):
    v = video_or_404(req)
    if err := _ready_or_bad(v):
        return err
    body = await req.json() if req.can_read_body else {}
    found = [p for p in v.get('plans') or [] if p.get('idea')]
    if found and (r := already(body, f'Shorts were already found in this video ({len(found)}){{when}}. Finding again keeps the ones you edited or rendered.',
                               max(p.get('at') or 0 for p in found) or None)):
        return r
    asyncio.ensure_future(shorts.run(v, 'find', shorts.find))
    return ok({'started': 'find'})


@routes.post('/api/videos/mark-shorts')
async def videos_mark_shorts(req):
    """From StudioMate's bot: add the link and send its proposed shorts back to `notify` as a checklist."""
    body = await req.json()
    url = (body.get('url') or '').strip()
    notify = body.get('notify') or {}
    if not url.startswith(('http://', 'https://')) or not notify.get('chatId'):
        return bad('need url and notify.chatId')
    known = videos.transcribed(url)
    v = await videos.ingest(url, body.get('origin') or 'studiomate-bot', sender=body.get('sender'))
    db.update_video(v['id'], tg={'chatId': notify['chatId'], 'messageId': notify.get('messageId'), 'via': 'studiomate', 'shorts': 'pending'})
    await videos.publish(v['id'])
    found = len(db.get_video(v['id']).get('plans') or [])
    warn = ' '.join(x for x in ((videos.already_note(known) or {}).get('warning', '') if known else '',
                                f'Its shorts were already found ({found}) — looking again.' if found else '') if x)
    return ok({'videoId': v['id'], **({'existing': {'videoId': v['id'], 'warning': warn}} if warn else {})})


@routes.post('/api/videos/{id}/shorts/confirm')
async def shorts_confirm(req):
    v = video_or_404(req)
    kept = await shorts.confirm_and_render(v, (await req.json()).get('ids') or [])
    await videos.publish(v['id'])
    return ok({'kept': [{'id': p['id'], 'title': p['title']} for p in kept]})


@routes.post('/api/videos/{id}/shorts/new')
async def shorts_new(req):
    v = video_or_404(req)
    body = await req.json()
    try:
        start, end = videos.clamp_range(v, body.get('start'), body.get('end'))
        plan = await asyncio.to_thread(shorts.new_from_range, v, start, end)
    except analysis.AnalysisError as e:
        return bad(str(e))
    await videos.publish(v['id'])
    return ok(plan)


@routes.post('/api/videos/{id}/queue')
async def queue_add(req):
    """The range as a new short, put in the render queue; its pictures are fetched straight away."""
    v = video_or_404(req)
    if v['status'] != 'ready':
        return bad('The video is not downloaded yet.')
    body = await req.json()
    try:
        start, end = videos.clamp_range(v, body.get('start'), body.get('end'))
    except analysis.AnalysisError as e:
        return bad(str(e))
    twin = next((p for p in v.get('plans') or [] if p.get('queue') and p.get('images')
                 and abs((p.get('range') or [0, 0])[0] - start) < 0.5 and abs((p.get('range') or [0, 0])[1] - end) < 0.5), None)
    if twin and (r := already(body, f'This range is already in the queue as “{twin["title"]}”, with its pictures')):
        return r
    try:
        plan = await asyncio.to_thread(shorts.new_from_range, v, start, end)
    except analysis.AnalysisError as e:
        return bad(str(e))
    shorts.save_plan(v['id'], plan['id'], range=[start, end], queue={'state': 'waiting', 'error': '', 'at': time.time()})
    asyncio.ensure_future(shorts.queue_worker())
    await videos.publish(v['id'])
    return ok(shorts.get_plan(v, plan['id']))


@routes.post('/api/videos/{id}/plans/{pid}/queue/retry')
async def queue_retry(req):
    v = video_or_404(req)
    pid = int(req.match_info['pid'])
    plan = next((p for p in v['plans'] if p['id'] == pid), None)
    if not plan or not plan.get('queue'):
        return bad('That short is not in the queue.')
    shorts.set_queue(v['id'], pid, 'ready' if plan.get('images') else 'waiting')
    asyncio.ensure_future(shorts.queue_worker())
    await videos.publish(v['id'])
    return ok()


@routes.delete('/api/videos/{id}/plans/{pid}/queue')
async def queue_remove(req):
    """Out of the queue; the short itself stays in the builder."""
    v = video_or_404(req)
    pid = int(req.match_info['pid'])
    plans = db.get_video(v['id'])['plans']
    for p in plans:
        if p['id'] == pid:
            p.pop('queue', None)
    db.update_video(v['id'], plans=plans)
    await videos.publish(v['id'])
    return ok()


@routes.post('/api/videos/{id}/plans/{pid}/pictures')
async def plan_pictures(req):
    v = video_or_404(req)
    if err := _ready_or_bad(v):
        return err
    pid = int(req.match_info['pid'])
    plan = next((p for p in v['plans'] if p['id'] == pid), None)
    if not plan:
        return bad('That short is gone.')
    body = await req.json() if req.can_read_body else {}
    if plan.get('images') and (r := already(body, f'This short already has {len(plan["images"])} pictures, fetched{{when}}. Fetching again replaces them.',
                                            plan.get('picturesAt'))):
        return r
    asyncio.ensure_future(shorts.run(v, 'pictures', shorts.pictures, pid))
    return ok({'started': 'pictures'})


@routes.put('/api/videos/{id}/plans/{pid}')
async def plan_put(req):
    v = video_or_404(req)
    try:
        plan = await asyncio.to_thread(shorts.update_plan, v, int(req.match_info['pid']), await req.json())
    except analysis.AnalysisError as e:
        return bad(str(e))
    await videos.publish(v['id'])
    return ok(plan)


@routes.delete('/api/videos/{id}/plans/{pid}')
async def plan_delete(req):
    v = video_or_404(req)
    pid = int(req.match_info['pid'])
    # Its rendered files go with it; copies saved to the user's own folders stay.
    for plan in v['plans']:
        if plan['id'] == pid:
            for r in plan.get('renders') or []:
                shorts.drop_render(v, pid, r['url'])
    v = db.get_video(v['id'])
    db.update_video(v['id'], plans=[p for p in v['plans'] if p['id'] != pid])
    await videos.publish(v['id'])
    return ok()


@routes.post('/api/videos/{id}/plans/{pid}/{action:virality|thumbprompt|render|translate}')
async def plan_action(req):
    v = video_or_404(req)
    if err := _ready_or_bad(v):
        return err
    pid = int(req.match_info['pid'])
    if not any(p['id'] == pid for p in v['plans']):
        return bad('That short is gone.')
    body = await req.json() if req.can_read_body else {}
    action = req.match_info['action']
    plan = next(p for p in v['plans'] if p['id'] == pid)
    if action == 'virality' and (plan.get('virality') or {}).get('why'):
        if r := already(body, 'This short already has a virality check'):
            return r
    if action == 'thumbprompt' and plan.get('thumbPrompt'):
        if r := already(body, 'This short already has a thumbnail prompt'):
            return r
    if action == 'translate':
        lang = body.get('lang') or 'English'
        done = plan.get('subs', {}).get(lang) or {}
        if done and all(str(i) in done for a, b in plan.get('keep') or [] for i in range(a, b + 1)):
            if r := already(body, f'This short is already translated into {lang}'):
                return r
    if action == 'render':
        folder = (body.get('folder') or '').strip()
        if folder and not Path(folder).is_dir():
            return bad(f'No such folder: {folder}')
        if folder:
            db.set_setting('clipFolder', folder)
        asyncio.ensure_future(shorts.run(v, 'render', shorts.render, pid, folder, bool(body.get('full', True))))
    elif action == 'translate':
        asyncio.ensure_future(shorts.run(v, 'translate', shorts.translate, pid, body.get('lang') or 'English'))
    else:
        asyncio.ensure_future(shorts.run(v, action, {'virality': shorts.virality, 'thumbprompt': shorts.thumb_prompt}[action], pid))
    return ok({'started': action})


@routes.delete('/api/videos/{id}/plans/{pid}/render')
async def plan_render_delete(req):
    v = video_or_404(req)
    try:
        shorts.drop_render(v, int(req.match_info['pid']), (await req.json()).get('url') or '')
    except analysis.AnalysisError as e:
        return bad(str(e))
    await videos.publish(v['id'])
    return ok()


@routes.post('/api/export')
async def export_file(req):
    """Copy a made file (a rendered short) into a folder the operator picked."""
    import shutil
    body = await req.json()
    src, folder = str(body.get('url') or ''), Path(body.get('folder') or '')
    p = (MEDIA / src[len('/media/'):]).resolve() if src.startswith('/media/') else None
    if not p or MEDIA.resolve() not in p.parents or not p.is_file():
        return bad('no such file')
    if not folder.is_dir():
        return bad(f'No such folder: {folder}')
    stem = videos._safe_name(body['name']) if body.get('name') else p.stem
    dest, n = folder / f'{stem}{p.suffix}', 2
    while dest.exists():
        dest = folder / f'{stem} ({n}){p.suffix}'
        n += 1
    shutil.copy2(p, dest)
    db.set_setting('clipFolder', str(folder))
    return ok({'path': str(dest)})


@routes.get('/api/soundfx')
async def soundfx_list(_):
    return ok(shorts.sfx_library())


@routes.get('/api/soundfx/file/{name}')
async def soundfx_file(req):
    p = shorts.sfx_path(req.match_info['name'])
    if not p:
        raise web.HTTPNotFound()
    return web.FileResponse(p, headers={'Cache-Control': 'max-age=3600'})


@routes.post('/api/soundfx/open')
async def soundfx_open(_):
    import subprocess
    subprocess.Popen(['explorer', str(USER_SFX.resolve())])
    return ok()


open_window_hook = None   # set by the desktop shell: lets a second launch open its window in this process


app_version = ''
app_build = 0


@routes.get('/api/update')
async def update_get(_):
    import updater
    return ok({**updater.info(app_version), 'build': app_build})


@routes.post('/api/update/apply')
async def update_apply(_):
    import updater, sys
    r = updater.pending(app_version)
    if not r:
        return bad('No update is waiting.')
    asyncio.get_running_loop().call_later(0.3, updater.apply, r, sys.argv[1:])
    return ok()


@routes.post('/api/update/seen')
async def update_seen(_):
    import updater
    updater.seen()
    return ok()


@routes.post('/api/open-window')
async def open_window(req):
    if not open_window_hook:
        return bad('no desktop shell', 404)
    body = await req.json()
    open_window_hook(body.get('path') or '/', body.get('title') or 'SlideBook', int(body.get('width') or 1500), int(body.get('height') or 950))
    return ok()


@routes.post('/api/reveal')
async def reveal(req):
    """Show a made file in Explorer: a short under media/, or a clip in the folder it was saved to."""
    p = Path((await req.json()).get('path') or '')
    if str(p).startswith('/media/'):
        p = MEDIA / str(p)[len('/media/'):]
    if not p.is_file() or p.suffix.lower() not in ('.mp4', '.srt'):
        return bad('no such file')
    import subprocess
    subprocess.Popen(['explorer', '/select,', str(p.resolve())])
    return ok()


@routes.get('/api/bot')
async def bot_get(_):
    return ok(bot.snapshot())


@routes.put('/api/bot')
async def bot_put(req):
    body = await req.json()
    token = (body.get('token') or '').strip() or (db.get_setting('botToken') or '')
    uid = str(body.get('userId') or '').strip()
    if not re.fullmatch(r'\d+:[\w-]{20,}', token):
        return bad('That is not a bot token (it looks like 123456:ABC…, from @BotFather).')
    if not uid.isdigit():
        return bad('The user id is a number (ask @userinfobot).')
    return ok(await bot.reconfigure(token, uid))


def make_app():
    app = web.Application(client_max_size=500 * 1024 ** 2)
    app.add_routes(routes)
    app.router.add_get('/', _page('index.html'))
    app.router.add_get('/output', _page('output.html'))
    app.router.add_get('/video', _page('video.html'))
    app.router.add_get('/sfx', _page('sfx.html'))
    app.router.add_get('/videos', _page('videos.html'))
    if (DIST / 'assets').exists():
        app.router.add_static('/assets', DIST / 'assets')

    async def on_start(app):
        db.requeue_interrupted()
        removed = core.gc_media()
        if removed:
            log.info('removed %d unreferenced images', removed)
        core.listeners.append(relay.on_broadcast)
        app['worker'] = asyncio.create_task(core.worker())
        app['bot'] = asyncio.create_task(bot.supervise())
        videos.backfill()
        app['videos'] = asyncio.create_task(videos.worker())
        app['transcribe'] = asyncio.create_task(shorts.transcribe_worker())
        app['mark'] = asyncio.create_task(shorts.mark_worker())
        shorts.resume_queue()
        app['queue'] = asyncio.create_task(shorts.queue_worker())
        # The open and the on-air book get their clip posters made now, before anyone steps.
        for bid in {(core.state.get(k) or {}).get('bookId') for k in ('view', 'live')} - {None}:
            asyncio.ensure_future(asyncio.to_thread(core.warm_posters, bid))

    async def on_stop(app):
        app['worker'].cancel()
        app['bot'].cancel()
        app['videos'].cancel()
        app['transcribe'].cancel()
        app['mark'].cancel()

    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')


def run_forever(ready=None):
    """Runs the server on this thread's own event loop."""
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s',
                        handlers=[logging.StreamHandler(), logging.FileHandler(DATA / 'slidebook.log', encoding='utf-8')])
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    runner = web.AppRunner(make_app())
    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, '127.0.0.1', PORT)
    loop.run_until_complete(site.start())
    log.info('SlideBook on http://127.0.0.1:%d', PORT)
    if ready:
        ready.set()
    try:
        loop.run_forever()
    finally:
        loop.run_until_complete(runner.cleanup())


if __name__ == '__main__':
    run_forever()
