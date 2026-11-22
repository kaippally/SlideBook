import asyncio, json, logging, mimetypes, re, time
from pathlib import Path

from aiohttp import WSMsgType, web

import analysis, bot, core, db, relay, videos
from paths import DIST, FONTS, MEDIA, PORT

log = logging.getLogger('slidebook')
routes = web.RouteTableDef()


def ok(data=None, status=200):
    return web.json_response(data if data is not None else {'ok': True}, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


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
        data = await part.read(decode=False)
        fname = part.filename or 'file'
        ext = Path(fname).suffix.lower()
        if ext == '.pdf':
            pages += await asyncio.to_thread(core.pdf_pages, bytes(data))
        else:
            try:
                ref, aspect = core.write_image(bytes(data), ext)
            except Exception:
                continue
            pages.append({'id': db.new_id('img-'), 'kind': 'image', 'ref': ref, 'aspect': aspect, 'label': Path(fname).stem[:40]})
    if not pages:
        return bad('no readable image or PDF in the upload')
    b = await core.edit_manifest(bid, lambda m: core.insert_pages(m, pages, after))
    return ok({'book': b, 'added': len(pages)})


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
            m.insert(to, m.pop(frm))
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
    opts = {k: body[k] for k in ('language', 'stanceId', 'instruction', 'kind', 'examine', 'speakers', 'context', 'expectation', 'notify')
            if body.get(k)}
    if body.get('lang') in LANGS:
        opts['language'] = LANGS[body['lang']]
    if (body.get('origin') or 'app') != 'app':
        asyncio.ensure_future(videos.ingest(url, body['origin']))
    jid = db.enqueue(url, body.get('origin') or 'app', mode='append' if book_id else 'new', book_id=book_id,
                     chat_id=(body.get('notify') or {}).get('chatId'), options=opts)
    job = db.get_job(jid)
    await core.broadcast({'type': 'job', 'job': job})
    return ok(job)


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


# ── settings ──────────────────────────────────────────────────────────────────

@routes.get('/api/settings')
async def settings_get(_):
    return ok({
        'hasGeminiKey': bool(analysis.gemini_key()),
        'critique': analysis.critique(),
        'port': PORT,
    })


@routes.put('/api/settings')
async def settings_put(req):
    body = await req.json()
    if body.get('geminiKey'):
        db.set_setting('geminiKey', body['geminiKey'].strip())
    if 'critique' in body:
        db.set_setting('critique', body['critique'])
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
    return ok(videos.payload(await videos.ingest(url, 'app')))


@routes.delete('/api/videos/{id}')
async def videos_delete(req):
    v = video_or_404(req)
    db.delete_video(v['id'])
    await core.broadcast({'type': 'videoGone', 'videoId': v['id']})
    return ok()


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
        # The open and the on-air book get their clip posters made now, before anyone steps.
        for bid in {(core.state.get(k) or {}).get('bookId') for k in ('view', 'live')} - {None}:
            asyncio.ensure_future(asyncio.to_thread(core.warm_posters, bid))

    async def on_stop(app):
        app['worker'].cancel()
        app['bot'].cancel()
        app['videos'].cancel()

    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')


def run_forever(ready=None):
    """Runs the server on this thread's own event loop."""
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
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
