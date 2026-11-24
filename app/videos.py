"""The Videos window's library: every link that arrives by Telegram is downloaded here with a thumbnail,
and a chosen range of it can be fact-checked (a queue job → a book), summarised, or cut into a short."""
import asyncio
import json
import logging
import subprocess
import threading
import time
import urllib.request

import analysis
import core
import db
from paths import DATA, MEDIA, tool

log = logging.getLogger('slidebook.videos')
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
busy = {}   # video id → what it is doing right now (summarising, cutting a short)
transcribing = {}   # video id → transcription progress (runs beside, not instead of, other work)


def payload(v):
    return {**v, 'busy': busy.get(v['id'], ''), 'transcribing': transcribing.get(v['id'], '')}


async def publish(video_id):
    v = db.get_video(video_id)
    if v:
        await core.broadcast({'type': 'video', 'video': payload(v)})


async def ingest(url, origin, tg=None, sender=None):
    v, created = db.add_video(url, origin, tg)
    if not created and tg:
        db.update_video(v['id'], tg=tg)
    add_sender(v, sender)
    await publish(v['id'])
    return db.get_video(v['id'])


def add_sender(v, sender):
    """Who sent this link on Telegram. Everyone who sent it is kept, first sender first."""
    if not sender or not (sender.get('name') or sender.get('id')):
        return
    s = {'id': str(sender.get('id') or ''), 'name': str(sender.get('name') or '').strip(),
         'username': str(sender.get('username') or '').lstrip('@'), 'at': time.time()}
    have = db.get_video(v['id']).get('senders') or []
    if any((h.get('id') and h['id'] == s['id']) or (not s['id'] and h.get('name') == s['name']) for h in have):
        return
    db.update_video(v['id'], senders=have + [s])


def _thumb_from_url(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
    ext = url.split('?')[0].rsplit('.', 1)[-1].lower()
    return core.write_image(data, ext if ext in ('jpg', 'jpeg', 'png', 'webp') else 'jpg')[0]


def _thumb_from_file(path, duration):
    out = DATA / 'work' / f'{path.stem}.thumb.jpg'
    subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', f'{max(0, (duration or 10) * 0.1):.1f}', '-i', str(path),
                    '-frames:v', '1', '-vf', 'scale=640:-2', str(out)], check=True, creationflags=NO_WINDOW)
    try:
        return core.write_image(out.read_bytes(), 'jpg')[0]
    finally:
        out.unlink(missing_ok=True)


def _download(v, step):
    step('Reading the link')
    meta = analysis.probe(v['url'])
    db.update_video(v['id'], title=meta['title'][:200], uploader=meta['uploader'], duration=meta['duration'] or 0)
    thumb = ''
    if meta['thumbnail']:
        try:
            thumb = _thumb_from_url(meta['thumbnail'])
        except Exception as e:
            log.info('thumbnail download failed: %s', e)
    reuse = db.book_video_for(v['url'])
    path = MEDIA / reuse['video'][len('/media/'):] if reuse else None
    if not (path and path.exists()):
        step('Downloading the video')
        path = analysis.download_media(v['url'], f'v{v["id"]}')
    if not thumb:
        thumb = _thumb_from_file(path, meta['duration'])
    duration = meta['duration'] or analysis._media_seconds(path) or 0
    db.update_video(v['id'], video=f'/media/video/{path.name}', thumb=thumb, duration=duration,
                    status='ready', step='', error='')


async def worker():
    db.requeue_videos()
    loop = asyncio.get_running_loop()
    while True:
        v = db.next_pending_video()
        if not v:
            await asyncio.sleep(2)
            continue
        db.update_video(v['id'], status='downloading', step='Queued')

        def step(text, vid=v['id']):
            db.update_video(vid, step=text)
            asyncio.run_coroutine_threadsafe(publish(vid), loop)

        await publish(v['id'])
        try:
            await asyncio.to_thread(_download, v, step)
        except Exception as e:
            log.warning('video %s failed: %s', v['id'], e)
            db.update_video(v['id'], status='failed', step='', error=str(e)[:400])
        await publish(v['id'])


# ── range work ────────────────────────────────────────────────────────────────

def _file(v):
    return MEDIA / v['video'][len('/media/'):]


def transcribed(url):
    """The library video for this link when it already has a whole transcript (and its file), else None."""
    v = db.video_by_url(url)
    return v if v and v['transcriptState'] == 'ready' and v.get('video') and _file(v).exists() else None


def files_of(v):
    """Every file the library made for this video, under data/media — minus any a slide book still plays.
    Copies saved to the user's own folders are not ours to delete."""
    urls = [v.get('video'), v.get('full')]
    urls += [x.get('url') for x in v.get('shorts') or []]
    for sub in v.get('subtitles') or []:
        urls += [sub.get('srt'), sub.get('vtt')]
    urls += [r.get('url') for p in v.get('plans') or [] for r in p.get('renders') or []]
    urls += [im.get('url') for p in v.get('plans') or [] for im in p.get('images') or []]
    book = db.book_video_for(v['url'])
    keep = {book['video']} if book else set()
    keep |= {'/media/' + r for r in db.referenced_media()}   # a file a video slide plays
    out = []
    for u in dict.fromkeys(u for u in urls if u and u.startswith('/media/') and u not in keep):
        f = (MEDIA / u[len('/media/'):]).resolve()
        if MEDIA.resolve() in f.parents and f.is_file():
            out.append(f)
    return out


def purge(v):
    """Delete the video from the library and its files from disk. Returns how many files went."""
    files = files_of(v)
    db.delete_video(v['id'])
    _unlink(files)
    return len(files)


def _unlink(files, tries=20):
    # Windows refuses to delete a file that is still open (the preview streaming it), so retry until it is let go.
    held = []
    for f in files:
        try:
            f.unlink(missing_ok=True)
        except OSError:
            held.append(f)
    if held and tries:
        threading.Timer(3, _unlink, (held, tries - 1)).start()
    elif held:
        log.warning('could not delete %s', ', '.join(map(str, held)))


def already_note(v):
    return {'videoId': v['id'], 'title': v['title'] or v['url'],
            'warning': f'“{v["title"] or v["url"]}” is already in the library with a transcript. Reusing it — no new download or transcription.'}


def range_lines(v, start, end, progress=None):
    """The transcript lines inside [start, end]: YouTube captions when there are any (fetched once and kept
    with the video), otherwise Gemini hears only that stretch of audio, cached per range."""
    full = db.get_video(v['id'], full=True)
    tr = full.get('transcript')
    vid = analysis.youtube_id(v['url'])
    if tr is None and vid:
        if progress:
            progress('Fetching captions')
        try:
            tr = analysis.youtube_captions(vid)
        except Exception as e:
            log.info('captions unavailable for %s: %s', vid, e)
            tr = {}
        db.update_video(v['id'], transcript=tr)
    if tr and tr.get('lines'):
        lines = [l for l in tr['lines'] if start <= l['t'] <= end]
        return {**tr, 'lines': lines}
    cache = DATA / 'work' / f'v{v["id"]}-{int(start)}-{int(end)}.transcript.json'
    if cache.exists():
        return json.loads(cache.read_text(encoding='utf-8'))
    cut = DATA / 'work' / f'v{v["id"]}-{int(start)}-{int(end)}.m4a'
    subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', f'{start:.2f}', '-t', f'{end - start:.2f}', '-i', str(_file(v)),
                    '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', str(cut)], check=True, creationflags=NO_WINDOW)
    try:
        if progress:
            progress('Transcribing the range with Gemini')
        tr = analysis.gemini_transcribe(cut, progress=progress)
    finally:
        cut.unlink(missing_ok=True)
    for l in tr['lines']:
        l['t'] = round(l['t'] + start, 2)
    cache.write_text(json.dumps(tr, ensure_ascii=False), encoding='utf-8')
    return tr


def clamp_range(v, start, end):
    dur = v['duration'] or 0
    start = max(0.0, float(start or 0))
    end = float(end or dur)
    if dur:
        end = min(end, dur)
    if end - start < 1:
        raise analysis.AnalysisError('Pick a range of at least a second.')
    return start, end


def fact_check(v, start, end):
    jid = db.enqueue(v['url'], 'video', options={'video': v['id'], 'range': [start, end]})
    return db.get_job(jid)


def _summarise(v, start, end):
    def progress(text):
        busy[v['id']] = text
    tr = range_lines(v, start, end, progress)
    if not tr['lines']:
        raise analysis.AnalysisError('No speech in that range.')
    busy[v['id']] = 'Summarising'
    crit = analysis.critique()
    lang = analysis.lang_for(crit.get('language'), tr.get('langCode') or 'en')
    text = '\n'.join(f'[{analysis.ms_to_timecode(int(l["t"] * 1000))}] {l["text"]}' for l in tr['lines'])
    prompt = (f'Summarise this stretch of a video transcript in {lang}. Start with a one-line headline, then 3 to 7 short '
              'bullet points ("• ") covering what is said, in order. Attribute claims to the speaker ("he says…"), never state '
              'them as fact. Plain text, no markdown.\n\nTranscript:\n' + text)
    client = analysis.gemini_client()   # held: a temporary client is closed before its request is sent
    r = client.models.generate_content(model=analysis.DEFAULT_MODEL, contents=prompt, config={'temperature': 0.3})
    return (r.text or '').strip()


SUB_LANGS = ('Original', 'English', 'Malayalam', 'Hindi', 'Arabic', 'Tamil')


def _stamp(t, sep):
    ms = int(round(max(0.0, t) * 1000))
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}{sep}{ms % 1000:03d}'


def _translate(texts, lang):
    """One subtitle line in, one line out, in order: asked for as a JSON array of the same length."""
    client = analysis.gemini_client()
    out = []
    for i in range(0, len(texts), 120):
        chunk = texts[i:i + 120]
        prompt = (f'Translate each of these {len(chunk)} subtitle lines into {lang}. Keep them short enough to read as '
                  'subtitles and keep the meaning, not word order. Return ONLY a JSON array of exactly '
                  f'{len(chunk)} strings, in the same order.\n\n' + json.dumps(chunk, ensure_ascii=False))
        r = client.models.generate_content(model=analysis.DEFAULT_MODEL, contents=prompt,
                                           config={'temperature': 0.2, 'response_mime_type': 'application/json'})
        got = json.loads(r.text or '[]')
        if not isinstance(got, list) or len(got) != len(chunk):
            raise analysis.AnalysisError(f'The translation came back with {len(got) if isinstance(got, list) else 0} lines for {len(chunk)}.')
        out += [str(x).strip() for x in got]
    return out


def _subtitles(v, start, end, lang):
    """Subtitles for the range: an SRT timed from the range start (it fits a clip or short cut from the same
    range) and a WebVTT on the video's own clock, for the canvas to show."""
    def progress(text):
        busy[v['id']] = text
    tr = range_lines(v, start, end, progress)
    lines = tr['lines']
    if not lines:
        raise analysis.AnalysisError('No speech in that range.')
    texts = [l['text'] for l in lines]
    if lang != 'Original':
        busy[v['id']] = f'Translating into {lang}'
        texts = _translate(texts, lang)
    cues = []
    for i, l in enumerate(lines):
        t0 = l['t']
        nxt = lines[i + 1]['t'] if i + 1 < len(lines) else end
        t1 = min(t0 + float(l.get('d') or 3), nxt, end)
        cues.append((t0, max(t1, t0 + 0.5), texts[i]))
    srt = '\n'.join(f'{n}\n{_stamp(a - start, ",")} --> {_stamp(b - start, ",")}\n{t}\n' for n, (a, b, t) in enumerate(cues, 1))
    vtt = 'WEBVTT\n\n' + '\n'.join(f'{_stamp(a, ".")} --> {_stamp(b, ".")}\n{t}\n' for a, b, t in cues)
    out_dir = MEDIA / 'subs'
    out_dir.mkdir(parents=True, exist_ok=True)
    base = f'v{v["id"]}-{int(start)}-{int(end)}-{lang.lower()}-{int(time.time())}'
    (out_dir / f'{base}.srt').write_text(srt, encoding='utf-8')
    (out_dir / f'{base}.vtt').write_text(vtt, encoding='utf-8')
    return {'start': start, 'end': end, 'lang': lang, 'srt': f'/media/subs/{base}.srt', 'vtt': f'/media/subs/{base}.vtt',
            'lines': len(cues), 'at': time.time()}


def _safe_name(text):
    return ''.join(c for c in text if c not in '<>:"/\\|?*').strip()[:80] or 'clip'


def clip_to(v, start, end, folder):
    """The range as it is (no crop), re-encoded so the cut lands on the exact frame, saved into `folder`."""
    from pathlib import Path
    out_dir = Path(folder)
    if not out_dir.is_dir():
        raise analysis.AnalysisError(f'No such folder: {folder}')
    stamp = f'{core._fmt(start)}-{core._fmt(end)}'.replace(':', '.')
    out = out_dir / f'{_safe_name(v["title"] or "clip")} {stamp}.mp4'
    n = 2
    while out.exists():
        out = out_dir / f'{_safe_name(v["title"] or "clip")} {stamp} ({n}).mp4'
        n += 1
    subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', f'{start:.2f}', '-t', f'{end - start:.2f}', '-i', str(_file(v)),
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k',
                    '-movflags', '+faststart', str(out)], check=True, capture_output=True, creationflags=NO_WINDOW)
    return str(out)


def _short(v, start, end):
    out_dir = MEDIA / 'shorts'
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f'v{v["id"]}-{int(start)}-{int(end)}-{int(time.time())}.mp4'
    vf = "crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=1080:1920,setsar=1"
    subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', f'{start:.2f}', '-t', f'{end - start:.2f}', '-i', str(_file(v)),
                    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k',
                    '-movflags', '+faststart', str(out)], check=True, capture_output=True, creationflags=NO_WINDOW)
    return f'/media/shorts/{out.name}'


async def run_range_task(v, kind, start, end, arg=None):
    """Summarise, subtitle, clip (`arg` = folder) or cut a short in the background; the window follows
    through `video` broadcasts."""
    vid = v['id']
    busy[vid] = {'summary': 'Summarising', 'short': 'Cutting the short', 'clip': 'Saving the clip',
                 'subtitles': f'Making {arg} subtitles'}[kind]
    await publish(vid)
    try:
        if kind == 'summary':
            text = await asyncio.to_thread(_summarise, v, start, end)
            cur = db.get_video(vid)
            db.update_video(vid, summaries=[{'start': start, 'end': end, 'text': text, 'at': time.time()}] + cur['summaries'])
        elif kind == 'subtitles':
            sub = await asyncio.to_thread(_subtitles, v, start, end, arg)
            cur = db.get_video(vid)
            db.update_video(vid, subtitles=[sub] + cur['subtitles'])
        elif kind == 'clip':
            saved = await asyncio.to_thread(clip_to, v, start, end, arg)
            await core.broadcast({'type': 'videoClip', 'videoId': vid, 'path': saved})
        else:
            url = await asyncio.to_thread(_short, v, start, end)
            cur = db.get_video(vid)
            db.update_video(vid, shorts=[{'start': start, 'end': end, 'url': url, 'at': time.time()}] + cur['shorts'])
        err = ''
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b'').decode(errors='replace').strip()[-300:] or str(e)
    except Exception as e:
        log.exception('%s failed for video %s', kind, vid)
        err = str(e)[:300]
    busy.pop(vid, None)
    await publish(vid)
    if err:
        await core.broadcast({'type': 'videoError', 'videoId': vid, 'error': f'{kind.capitalize()} failed: {err}'})


def backfill():
    """Links that came by Telegram before the Videos window existed join the library once."""
    for j in db.list_jobs(limit=500):
        if j['origin'] in ('studiomate-bot', 'telegram'):
            db.add_video(j['url'], j['origin'])
