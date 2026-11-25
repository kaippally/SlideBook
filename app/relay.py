"""Job progress back to StudioMate's Telegram bot, for links it sent here (SLIDEBOOK_PLAN.md §11.1).

A job carries `options.notify = {chatId, messageId}`; every change of its step is POSTed to the bot's
event server, which edits that one message. The bot being down costs nothing but the update."""
import json
import logging
import os
import re
import time

import aiohttp

log = logging.getLogger('slidebook')

BOT_EVENT_URL = os.environ.get('STUDIOMATE_BOT_EVENT_URL', 'http://127.0.0.1:5001/event')
_last = {}
_sent_at = {}
# Within one running stage the message is edited at most this often — a debate's transcription reports
# every one-minute part, and a hundred edits a few seconds apart are noise in the chat.
EVERY_SEC = 20
STAGE = re.compile(r'^Step (\d+) of')


async def on_broadcast(msg):
    if msg.get('type') != 'job':
        return
    job = msg['job']
    notify = (job.get('options') or {}).get('notify')
    if not notify:
        return
    key = (job['status'], job['step'])
    prev = _last.get(job['id'])
    if prev == key:
        return
    stage = STAGE.match(job['step'] or '')
    before = STAGE.match(prev[1] or '') if prev else None
    same_stage = prev and prev[0] == 'running' == job['status'] and stage and before and before.group(1) == stage.group(1)
    if same_stage and time.time() - _sent_at.get(job['id'], 0) < EVERY_SEC:
        return
    _last[job['id']] = key
    _sent_at[job['id']] = time.time()
    event = {'type': 'slidebook-job', 'chatId': notify.get('chatId'), 'messageId': notify.get('messageId'),
             'jobId': job['id'], 'status': job['status'], 'step': job['step'], 'error': job.get('error') or '',
             'url': job['url'], 'bookId': job.get('book_id'),
             'transcribeOnly': bool(job['options'].get('transcribeOnly')), 'madeRecord': job['options'].get('madeRecord')}
    if job['status'] == 'done' and job.get('book_id'):
        import db
        b = db.get_book(job['book_id'])
        if b:
            event.update(title=b['title'], pages=b['pageCount'], recordId=b['source'].get('recordId'), runId=b['source'].get('runId'))
    await post(event)


def post_sync(event):
    """The same POST from a worker thread (the analysis job runs off the event loop)."""
    import urllib.request
    try:
        req = urllib.request.Request(BOT_EVENT_URL, data=json.dumps(event).encode(), headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=5).close()
    except Exception as e:
        log.info('bot event not delivered: %s', e)


async def post(event):
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as s:
            await s.post(BOT_EVENT_URL, json=event)
    except Exception as e:
        log.info('bot event not delivered: %s', e)
