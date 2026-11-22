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
        msg = await update.message.reply_text(f'Adding to the video library: {url}')
        v = await videos.ingest(url, 'telegram', tg={'chatId': msg.chat_id, 'messageId': msg.message_id})
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
    else:
        await q.answer()


_last = {}


async def _video_message(v):
    tg = v.get('tg') or {}
    if not tg.get('messageId'):
        return
    key = ('v', v['id'], v['status'], v['step'])
    if _last.get(key[:2]) == key:
        return
    _last[key[:2]] = key
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    kb = None
    if v['status'] == 'ready':
        text = f"In the video library: {v['title'] or v['url']}\nOpen SlideBook → Videos to pick a range."
        kb = InlineKeyboardMarkup([[InlineKeyboardButton('🔎 Fact-check the whole video', callback_data=f"fc:{v['id']}")]])
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
