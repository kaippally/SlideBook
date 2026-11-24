"""SlideBook's own Telegram bot — the fallback for when StudioMate's bot is down or cannot log in.

StudioMate's bot is watched on its `/health` (`{status, api}`): no answer = down, `api: false` = it cannot
reach Telegram. Only then does this bot poll, with the token and the one allowed user id entered in the
app, so the two never poll at once (a shared token would 409 both). When StudioMate's bot comes back,
this one stands down."""
import asyncio
import logging
import os
import re

import aiohttp

import core
import db

log = logging.getLogger('slidebook.bot')

_event_url = os.environ.get('STUDIOMATE_BOT_EVENT_URL', 'http://127.0.0.1:5001/event')
HEALTH_URL = _event_url.rsplit('/', 1)[0] + '/health'
URL_RE = re.compile(r'https?://\S+')
CHECK_EVERY = 20

logging.getLogger('httpx').setLevel(logging.WARNING)  # its request lines carry the token in the URL

_app = None
_bad_token = False
_switch = asyncio.Lock()
status = {'studiomate': 'unknown', 'own': 'off', 'ownName': '', 'ownError': '', 'configured': False, 'userId': ''}


def _config():
    return (db.get_setting('botToken') or '').strip(), str(db.get_setting('botUserId') or '').strip()


def snapshot():
    token, uid = _config()
    return {'type': 'bot', **status, 'configured': bool(token and uid), 'userId': uid}


async def _publish():
    await core.broadcast(snapshot())


async def _studiomate_state():
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as s:
            async with s.get(HEALTH_URL) as r:
                j = await r.json(content_type=None)
        return 'ok' if j.get('api') else 'nologin'
    except Exception:
        return 'down'


def _allowed(update):
    _, uid = _config()
    return update.effective_user and str(update.effective_user.id) == uid


def _live_book():
    live = core.state.get('live')
    return db.get_book(live['bookId']) if live else None


async def on_start(update, _ctx):
    if not _allowed(update):
        await update.message.reply_text(f'Not allowed. Your user id is {update.effective_user.id}.')
        return
    await update.message.reply_text('Send a video link and it is fact-checked into a SlideBook book.\n/live · /next · /prev')


async def on_text(update, _ctx):
    if not _allowed(update):
        await update.message.reply_text(f'Not allowed. Your user id is {update.effective_user.id}.')
        return
    urls = URL_RE.findall(update.message.text or '')
    if not urls:
        await update.message.reply_text('Send a video link (https://…).')
        return
    import videos
    for url in urls:
        known = videos.transcribed(url)
        if known:
            await update.message.reply_text('⚠️ ' + videos.already_note(known)['warning'])
        msg = await update.message.reply_text(f'Adding to the video library: {url}')
        u = update.effective_user
        v = await videos.ingest(url, 'telegram', tg={'chatId': msg.chat_id, 'messageId': msg.message_id},
                                sender=u and {'id': u.id, 'name': u.full_name, 'username': u.username or ''})
        if v['status'] == 'ready':
            await on_broadcast({'type': 'video', 'video': videos.payload(v)})


async def _step(update, action):
    if not _allowed(update):
        return
    book = _live_book()
    if not book:
        await update.message.reply_text('Nothing on air.')
        return
    if action != 'live':
        await core.control(action, book['id'], on_air=True)
    live = core.state.get('live') or {}
    await update.message.reply_text(f"{book['title']} — page {live.get('page')}/{book['pageCount']}")


async def on_next(update, _ctx):
    await _step(update, 'next')


async def on_prev(update, _ctx):
    await _step(update, 'prev')


async def on_live(update, _ctx):
    await _step(update, 'live')


async def on_callback(update, _ctx):
    q = update.callback_query
    if not _allowed(update):
        await q.answer('Not allowed')
        return
    kind, _, bid = (q.data or '').partition(':')
    if kind == 'air' and db.get_book(bid):
        await core.control('air', bid, on_air=True)
        await q.answer('On air')
    elif kind == 'fc' and bid.isdigit() and (v := db.get_video(int(bid))):
        msg = await q.message.reply_text(f'Fact-checking the whole video: {v["title"] or v["url"]}')
        jid = db.enqueue(v['url'], 'telegram', chat_id=msg.chat_id, user_id=q.from_user.id,
                         options={'tg': {'chatId': msg.chat_id, 'messageId': msg.message_id}})
        await core.broadcast({'type': 'job', 'job': db.get_job(jid)})
        await q.answer('Queued')
    elif kind == 'ms' and bid.isdigit() and (v := db.get_video(int(bid))):
        msg = await q.message.reply_text(f'✂ Looking for shorts in: {v["title"] or v["url"]}')
        db.update_video(v['id'], tg={'chatId': msg.chat_id, 'messageId': msg.message_id, 'via': 'own', 'shorts': 'pending'})
        await q.answer('Queued')
    elif kind in ('st', 'sa'):
        await q.answer()
        await q.edit_message_reply_markup(_toggled(q.message.reply_markup, q.data))
    elif kind == 'sk' and bid.isdigit() and (v := db.get_video(int(bid))):
        import shorts
        ids = _ticked(q.message.reply_markup)
        if not ids:
            await q.answer('Tick at least one')
            return
        kept = await shorts.confirm_and_render(v, ids)
        import videos
        await videos.publish(v['id'])
        await q.answer('Confirmed')
        await q.edit_message_text(f'{q.message.text}\n\n✅ Kept {len(kept)}: ' + '; '.join(p['title'] for p in kept)
                                  + '\nOpen SlideBook Videos → Short builder to edit and render them.')
    else:
        await q.answer()


# ── the shorts checklist ──────────────────────────────────────────────────────
# State lives in the message itself: a button reads ☑ or ☐, so a tap flips its label and Confirm reads them back.

def checklist(payload):
    """(text, [[(label, data)]]) for a finished shorts search; the same layout StudioMate's bot draws."""
    items = payload.get('shorts') or []
    if not items:
        return f"✂ No shorts found in “{payload.get('title')}”.", []
    lines = [f"✂ {len(items)} possible shorts in “{payload.get('title')}”", '']
    for n, s in enumerate(items, 1):
        m, sec = divmod(int(round(s['length'])), 60)
        lines.append(f"{n}. {s['title']} ({m}:{sec:02d} · score {s['score']})")
        if s.get('idea'):
            lines.append(f"   {s['idea'][:180]}")
    lines += ['', 'Tick the ones to keep, then Confirm.']
    text = '\n'.join(lines)
    if len(text) > 4000:
        text = text[:3990] + '…'
    vid = payload['videoId']
    rows = [[(f"☐ {n}. {s['title'][:40]}", f"st:{vid}:{s['id']}")] for n, s in enumerate(items, 1)]
    rows.append([('Tick all', f'sa:{vid}'), ('✅ Confirm', f'sk:{vid}')])
    return text, rows


def render_text(payload):
    nl = chr(10)
    kept = '; '.join(payload.get('kept') or [])
    if payload['status'] == 'rendering':
        return f"✅ Kept: {kept}{nl}🎬 {payload.get('step')} at full resolution…"
    done = payload.get('rendered') or []
    text = f"🎬 {len(done)} short{'s' if len(done) != 1 else ''} rendered at 1080×1920 — SlideBook Videos → Shorts tab."
    text += ''.join(f"{nl}• {t}" for t in done)
    if payload.get('failed'):
        text += f"{nl}⚠️ {payload['failed']} could not be rendered — see SlideBook."
    return text


def _toggled(markup, data):
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    rows = []
    every = data.startswith('sa:')
    for row in markup.inline_keyboard:
        out = []
        for b in row:
            label = b.text
            if b.callback_data.startswith('st:') and (every or b.callback_data == data):
                on = label.startswith('☑')
                label = ('☑' if every or not on else '☐') + label[1:]
            out.append(InlineKeyboardButton(label, callback_data=b.callback_data))
        rows.append(out)
    return InlineKeyboardMarkup(rows)


def _ticked(markup):
    return [int(b.callback_data.split(':')[2]) for row in markup.inline_keyboard for b in row
            if b.callback_data.startswith('st:') and b.text.startswith('☑')]


async def shorts_message(tg, payload):
    if not _app:
        return
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    kb = None
    if payload['status'] == 'done':
        text, rows = checklist(payload)
        kb = InlineKeyboardMarkup([[InlineKeyboardButton(t, callback_data=d) for t, d in r] for r in rows]) if rows else None
    elif payload['status'] in ('rendering', 'rendered'):
        text = render_text(payload)
    elif payload['status'] == 'failed':
        text = f"⚠️ Could not find shorts: {payload.get('error')}\n{payload.get('url')}"
    else:
        text = f"✂ {payload.get('step')}…\n{payload.get('url')}"
    try:
        await _app.bot.edit_message_text(text, chat_id=tg['chatId'], message_id=tg['messageId'], reply_markup=kb)
    except Exception as e:
        log.info('could not edit shorts message: %s', e)


_last = {}


async def _video_message(v):
    tg = v.get('tg') or {}
    if not tg.get('messageId') or tg.get('via') == 'studiomate' or tg.get('shorts'):
        return
    key = ('v', v['id'], v['status'], v['step'])
    if _last.get(key[:2]) == key:
        return
    _last[key[:2]] = key
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    kb = None
    if v['status'] == 'ready':
        text = f"In the video library: {v['title'] or v['url']}\nOpen SlideBook → Videos to pick a range."
        kb = InlineKeyboardMarkup([[InlineKeyboardButton('🔎 Fact-check the whole video', callback_data=f"fc:{v['id']}")],
                                   [InlineKeyboardButton('✂ Mark shorts', callback_data=f"ms:{v['id']}")]])
    elif v['status'] == 'failed':
        text = f"Could not download: {v['error'] or 'unknown error'}\n{v['url']}"
    else:
        text = f"{v['step'] or 'Queued'}\n{v['url']}"
    try:
        await _app.bot.edit_message_text(text, chat_id=tg['chatId'], message_id=tg['messageId'], reply_markup=kb)
    except Exception as e:
        log.info('could not edit video message: %s', e)


async def on_broadcast(msg):
    if not _app:
        return
    if msg.get('type') == 'video':
        await _video_message(msg['video'])
        return
    if msg.get('type') != 'job':
        return
    job = msg['job']
    tg = (job.get('options') or {}).get('tg')
    if not tg:
        return
    key = (job['status'], job['step'])
    if _last.get(job['id']) == key:
        return
    _last[job['id']] = key
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    text, kb = f"{job['step'] or job['status']}\n{job['url']}", None
    if job['status'] == 'failed':
        text = f"Failed: {job.get('error') or 'unknown error'}\n{job['url']}"
    elif job['status'] == 'done' and job.get('book_id'):
        b = db.get_book(job['book_id'])
        if b:
            text = f"Ready: {b['title']} ({b['pageCount']} pages)"
            kb = InlineKeyboardMarkup([[InlineKeyboardButton('▶ Put on air', callback_data=f"air:{b['id']}")]])
    try:
        await _app.bot.edit_message_text(text, chat_id=tg['chatId'], message_id=tg['messageId'], reply_markup=kb)
    except Exception as e:
        log.info('could not edit job message: %s', e)


async def _start_own():
    global _app, _bad_token
    token, uid = _config()
    if not (token and uid):
        status.update(own='off', ownName='', ownError='')
        return
    from telegram.ext import Application, CallbackQueryHandler, CommandHandler, MessageHandler, filters
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler('start', on_start))
    app.add_handler(CommandHandler('next', on_next))
    app.add_handler(CommandHandler('prev', on_prev))
    app.add_handler(CommandHandler('live', on_live))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    try:
        await app.initialize()
        await app.start()
        await app.updater.start_polling(drop_pending_updates=False)
    except Exception as e:
        from telegram.error import InvalidToken
        _bad_token = isinstance(e, InvalidToken) or 'Unauthorized' in type(e).__name__
        err = str(e).replace(token, token.split(':')[0] + ':…')
        log.warning('own bot could not log in: %s', err)
        status.update(own='failed', ownName='', ownError=err[:200])
        try:
            await app.shutdown()
        except Exception:
            pass
        return
    _app = app
    status.update(own='running', ownName=app.bot.username or '', ownError='')
    log.info('own bot @%s polling', app.bot.username)


async def _stop_own():
    global _app
    if not _app:
        return
    app, _app = _app, None
    try:
        await app.updater.stop()
        await app.stop()
        await app.shutdown()
    except Exception:
        log.exception('own bot stop failed')
    status.update(own='off', ownName='')


async def reconfigure(token, user_id):
    global _bad_token
    _bad_token = False
    db.set_setting('botToken', token)
    db.set_setting('botUserId', user_id)
    async with _switch:
        await _stop_own()
        status.update(own='off', ownError='')
        if status['studiomate'] != 'ok':
            await _start_own()
    await _publish()
    return snapshot()


async def supervise():
    core.listeners.append(on_broadcast)
    while True:
        before = snapshot()
        status['studiomate'] = await _studiomate_state()
        async with _switch:
            if status['studiomate'] == 'ok':
                await _stop_own()
            elif not _app and not _bad_token:
                await _start_own()
        if snapshot() != before:
            await _publish()
        await asyncio.sleep(CHECK_EVERY)
