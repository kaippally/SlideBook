import hashlib, json, sqlite3, threading, time, uuid

from paths import DB_FILE

_lock = threading.RLock()
_con = sqlite3.connect(DB_FILE, check_same_thread=False)
_con.row_factory = sqlite3.Row
_con.execute('PRAGMA journal_mode=WAL')
_con.executescript('''
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '',
  styles TEXT NOT NULL DEFAULT '{}', card_aspect REAL NOT NULL DEFAULT 1.7778,
  manifest TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, origin TEXT NOT NULL,
  chat_id INTEGER, user_id INTEGER, book_id TEXT, mode TEXT NOT NULL DEFAULT 'new',
  status TEXT NOT NULL DEFAULT 'pending', step TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
  next_at REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', uploader TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,
  thumb TEXT NOT NULL DEFAULT '', video TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  step TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', summaries TEXT NOT NULL DEFAULT '[]',
  shorts TEXT NOT NULL DEFAULT '[]', tg TEXT NOT NULL DEFAULT '{}', transcript TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
DROP TABLE IF EXISTS tg_users;
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vkey TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
  url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0, video TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL, speakers TEXT NOT NULL DEFAULT '[]', names TEXT NOT NULL DEFAULT '{}',
  lang TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vkey TEXT NOT NULL, record_id INTEGER NOT NULL, version INTEGER NOT NULL,
  kind TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', base_run INTEGER, model TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '', book_id TEXT, usage TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL
);
''')
if 'subtitles' not in {r[1] for r in _con.execute('PRAGMA table_info(videos)')}:
    _con.execute("ALTER TABLE videos ADD COLUMN subtitles TEXT NOT NULL DEFAULT '[]'")
if 'full' not in {r[1] for r in _con.execute('PRAGMA table_info(videos)')}:
    _con.execute("ALTER TABLE videos ADD COLUMN full TEXT NOT NULL DEFAULT ''")
if 'plans' not in {r[1] for r in _con.execute('PRAGMA table_info(videos)')}:
    _con.execute("ALTER TABLE videos ADD COLUMN plans TEXT NOT NULL DEFAULT '[]'")
if 'senders' not in {r[1] for r in _con.execute('PRAGMA table_info(videos)')}:
    _con.execute("ALTER TABLE videos ADD COLUMN senders TEXT NOT NULL DEFAULT '[]'")
_con.commit()


def requeue_interrupted():
    """A job left 'running' by a previous run of the app never finished: queue it again. Called once at
    server start — never on import, or a script that merely imports db would requeue the live worker's job."""
    with _lock:
        _con.execute("UPDATE queue SET status='pending' WHERE status='running'")
        _con.commit()


# The starting look of a new book: StudioMate's default slide preset ("Wide Format"), so cards fly in
# with the same 3D motion, border and floor reflection as the studio's decks.
BUILTIN_STYLES = {
    'presentation': {
        'in': {'x': 347, 'y': 231, 'z': -1700, 'scale': 0.9, 'opacity': 0, 'rotateX': 11, 'rotateY': 65, 'perspective': 1000},
        'hold': {'x': -710, 'y': 28, 'z': -1325, 'scale': 1.1, 'opacity': 100, 'rotateX': -4, 'rotateY': 0, 'perspective': 0},
        'out': {'x': 2356, 'y': 291, 'z': -1876, 'scale': 1.25, 'opacity': 0, 'rotateX': 3, 'rotateY': 99, 'perspective': 0},
        'showDuration': 600, 'showEasing': [0.4, 0, 0.2, 1], 'hideDuration': 600, 'hideEasing': [0.4, 0, 0.2, 1],
        'bounceAmount': 5, 'bounceCount': 1, 'bounceDuration': 6750,
    },
    'border': {'borderWidth': 18, 'borderColor': '#ffffff', 'borderStyle': 'solid', 'borderRadius': 44},
    'surface': {'reflection': True, 'reflectionSurfaceY': 0.71, 'reflectionOpacityMain': 100, 'reflectionOpacity': 86,
                'reflectionDistance': 594, 'reflectionFeather': 4, 'reflectionBlur': 4, 'reflectionGrid': True},
}


CARD_KINDS = ('claim', 'fallacy', 'qa', 'moderation', 'contradiction', 'scorecard')


def new_id(prefix=''):
    return prefix + uuid.uuid4().hex[:12]


def rev_of(manifest):
    return hashlib.sha1(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:10]


# ── settings ──────────────────────────────────────────────────────────────────

def get_setting(key, default=None):
    with _lock:
        r = _con.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    return json.loads(r['value']) if r else default


def set_setting(key, value):
    with _lock:
        _con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                     (key, json.dumps(value)))
        _con.commit()


# ── books ─────────────────────────────────────────────────────────────────────

def _book(r, full=True):
    manifest = json.loads(r['manifest'])
    b = {
        'id': r['id'], 'title': r['title'], 'group': r['grp'], 'cardAspect': r['card_aspect'],
        # The cache key every client compares: any edit, styles included, so a look change reaches the
        # output and not only a page change.
        'pageCount': len(manifest), 'rev': rev_of([manifest, r['updated_at']]),
        'createdAt': r['created_at'], 'updatedAt': r['updated_at'],
    }
    source = json.loads(r['source'])
    if full:
        b.update(styles=json.loads(r['styles']), manifest=manifest, source=source)
    else:
        b['first'] = manifest[0] if manifest else None
        b['sourceTitle'] = source.get('title', '')
        b['recordId'] = source.get('recordId')
        b['cards'] = sum(1 for p in manifest if p['kind'] in CARD_KINDS)
    return b


def list_books():
    with _lock:
        rows = _con.execute('SELECT * FROM books ORDER BY created_at DESC').fetchall()
    return [_book(r, full=False) for r in rows]


def get_book(book_id):
    with _lock:
        r = _con.execute('SELECT * FROM books WHERE id=?', (book_id,)).fetchone()
    return _book(r) if r else None


def create_book(title, manifest=None, source=None, styles=None, group=''):
    now = time.time()
    bid = new_id('b')
    if styles is None:
        styles = get_setting('lastStyles') or get_setting('defaultStyles') or BUILTIN_STYLES
    aspect = float(get_setting('lastCardAspect') or 16 / 9)
    with _lock:
        _con.execute('INSERT INTO books(id,title,grp,styles,manifest,source,created_at,updated_at,card_aspect) VALUES(?,?,?,?,?,?,?,?,?)',
                     (bid, title, group, json.dumps(styles), json.dumps(manifest or []), json.dumps(source or {}), now, now, aspect))
        _con.commit()
    return get_book(bid)


# The look a new book starts from is the one last edited: card look, slide and video poses, surface, border.
# What belongs to one book's own pages (per-page styles, notes, heading texts, clip ranges) stays behind.
_PER_BOOK = ('pages', 'notes', 'headings', 'sfx')


def remember_look(styles):
    look = {k: v for k, v in styles.items() if k not in _PER_BOOK}
    if isinstance(look.get('video'), dict):
        look['video'] = {k: v for k, v in look['video'].items() if k != 'ranges'}
    set_setting('lastStyles', look)


def update_book(book_id, **fields):
    if isinstance(fields.get('styles'), dict):
        remember_look(fields['styles'])
    if fields.get('cardAspect'):
        set_setting('lastCardAspect', fields['cardAspect'])
    cols = {'title': 'title', 'group': 'grp', 'styles': 'styles', 'cardAspect': 'card_aspect',
            'manifest': 'manifest', 'source': 'source'}
    sets, vals = [], []
    for k, v in fields.items():
        if k not in cols:
            continue
        sets.append(f'{cols[k]}=?')
        vals.append(json.dumps(v) if k in ('styles', 'manifest', 'source') else v)
    if not sets:
        return get_book(book_id)
    sets.append('updated_at=?')
    vals += [time.time(), book_id]
    with _lock:
        _con.execute(f'UPDATE books SET {", ".join(sets)} WHERE id=?', vals)
        _con.commit()
    return get_book(book_id)


def mutate_manifest(book_id, fn):
    """Read-modify-write of one book's manifest under the lock, so two writers cannot interleave."""
    with _lock:
        b = get_book(book_id)
        if not b:
            return None
        manifest = fn(b['manifest'])
        return update_book(book_id, manifest=manifest)


def delete_book(book_id):
    with _lock:
        _con.execute('DELETE FROM books WHERE id=?', (book_id,))
        _con.commit()


def referenced_media():
    with _lock:
        rows = _con.execute('SELECT manifest, styles FROM books').fetchall()
    refs = set()
    for r in rows:
        for p in json.loads(r['manifest']):
            if isinstance(p.get('ref'), str):
                refs.add(p['ref'])
            if isinstance(p.get('video'), str):
                refs.add(p['video'])
        snd = json.loads(r['styles']).get('sound') or {}
        if snd.get('url', '').startswith('/media/'):
            refs.add(snd['url'][len('/media/'):])
    with _lock:
        refs |= {r['thumb'] for r in _con.execute("SELECT thumb FROM videos WHERE thumb<>''").fetchall()}
    return refs


# ── queue (links from the app and from Telegram share one table) ─────────────

def _job(r):
    d = dict(r)
    d['options'] = json.loads(d['options'])
    return d


def enqueue(url, origin, mode='new', book_id=None, chat_id=None, user_id=None, options=None):
    now = time.time()
    with _lock:
        cur = _con.execute('INSERT INTO queue(url,origin,mode,book_id,chat_id,user_id,options,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                           (url, origin, mode, book_id, chat_id, user_id, json.dumps(options or {}), now, now))
        _con.commit()
        return cur.lastrowid


def update_job(job_id, **fields):
    if 'options' in fields:
        fields['options'] = json.dumps(fields['options'])
    fields['updated_at'] = time.time()
    keys = list(fields)
    with _lock:
        _con.execute(f'UPDATE queue SET {", ".join(k + "=?" for k in keys)} WHERE id=?', [fields[k] for k in keys] + [job_id])
        _con.commit()


def claim_job():
    with _lock:
        r = _con.execute("SELECT * FROM queue WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 1", (time.time(),)).fetchone()
        if not r:
            return None
        _con.execute("UPDATE queue SET status='running', updated_at=? WHERE id=?", (time.time(), r['id']))
        _con.commit()
    return _job(r)


def get_job(job_id):
    with _lock:
        r = _con.execute('SELECT * FROM queue WHERE id=?', (job_id,)).fetchone()
    return _job(r) if r else None


def done_jobs(url):
    with _lock:
        rows = _con.execute("SELECT * FROM queue WHERE url=? AND status='done' ORDER BY id DESC", (url,)).fetchall()
    return [_job(r) for r in rows]


def list_jobs(limit=30):
    with _lock:
        rows = _con.execute('SELECT * FROM queue ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
    return [_job(r) for r in rows]


# ── videos (links that arrived by Telegram, for the Videos window) ───────────

_VIDEO_JSON = ('summaries', 'shorts', 'tg', 'subtitles', 'plans', 'senders')


def _video(r, full=False):
    d = dict(r)
    for k in _VIDEO_JSON:
        d[k] = json.loads(d[k])
    tr = d.pop('transcript')
    d['transcriptState'] = 'ready' if '"lines": [{' in tr else ('failed' if '"error"' in tr else 'none')
    if full:
        d['transcript'] = json.loads(tr) if tr else None
    return d


def add_video(url, origin, tg=None):
    """Returns (video, created). A link already in the library is the same video."""
    now = time.time()
    with _lock:
        r = _con.execute('SELECT * FROM videos WHERE url=?', (url,)).fetchone()
        if r:
            return _video(r), False
        cur = _con.execute('INSERT INTO videos(url,origin,tg,created_at,updated_at) VALUES(?,?,?,?,?)',
                           (url, origin, json.dumps(tg or {}), now, now))
        _con.commit()
        return get_video(cur.lastrowid), True


def video_by_url(url, full=False):
    with _lock:
        r = _con.execute('SELECT * FROM videos WHERE url=?', (url,)).fetchone()
    return _video(r, full) if r else None


def get_video(video_id, full=False):
    with _lock:
        r = _con.execute('SELECT * FROM videos WHERE id=?', (video_id,)).fetchone()
    return _video(r, full) if r else None


def list_videos():
    with _lock:
        rows = _con.execute('SELECT * FROM videos ORDER BY created_at DESC').fetchall()
    return [_video(r) for r in rows]


def update_video(video_id, **fields):
    for k in (*_VIDEO_JSON, 'transcript'):
        if k in fields and not isinstance(fields[k], str):
            fields[k] = json.dumps(fields[k], ensure_ascii=False)
    fields['updated_at'] = time.time()
    keys = list(fields)
    with _lock:
        _con.execute(f'UPDATE videos SET {", ".join(k + "=?" for k in keys)} WHERE id=?', [fields[k] for k in keys] + [video_id])
        _con.commit()


def next_pending_video():
    with _lock:
        r = _con.execute("SELECT * FROM videos WHERE status='pending' ORDER BY id LIMIT 1").fetchone()
    return _video(r) if r else None


def next_untranscribed_video(skip=()):
    with _lock:
        rows = _con.execute("SELECT * FROM videos WHERE status='ready' AND transcript IN ('', '{}') ORDER BY id DESC").fetchall()
    return next((_video(r) for r in rows if r['id'] not in skip), None)


def delete_video(video_id):
    with _lock:
        _con.execute('DELETE FROM videos WHERE id=?', (video_id,))
        _con.commit()


def requeue_videos():
    with _lock:
        _con.execute("UPDATE videos SET status='pending' WHERE status='downloading'")
        _con.commit()


# ── records: the one text record of a video, and the Claude runs made from it ─
# A video is transcribed once; every later analysis, question, short or edit reads the record, never
# the video. `vkey` names the video across links to it (youtube id, else the link without its query).

def _record(r, full=True):
    d = dict(r)
    for k in ('lines', 'speakers', 'names'):
        d[k] = json.loads(d[k])
    d['lineCount'] = len(d['lines'])
    if not full:
        d.pop('lines')
    return d


def latest_record(vkey):
    with _lock:
        r = _con.execute('SELECT * FROM records WHERE vkey=? ORDER BY version DESC LIMIT 1', (vkey,)).fetchone()
    return _record(r) if r else None


def get_record(record_id, full=True):
    with _lock:
        r = _con.execute('SELECT * FROM records WHERE id=?', (record_id,)).fetchone()
    return _record(r, full) if r else None


def save_record(vkey, kind, url, title, duration, video, lines, speakers, lang, via):
    with _lock:
        prev = _con.execute('SELECT version, names FROM records WHERE vkey=? ORDER BY version DESC LIMIT 1', (vkey,)).fetchone()
        cur = _con.execute('INSERT INTO records(vkey,version,kind,url,title,duration,video,lines,speakers,names,lang,via,created_at) '
                           'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (vkey, (prev['version'] + 1) if prev else 1, kind, url, title, duration, video,
                            json.dumps(lines, ensure_ascii=False), json.dumps(speakers, ensure_ascii=False),
                            prev['names'] if prev else '{}', lang, via, time.time()))
        _con.commit()
        return get_record(cur.lastrowid)


def set_record_names(record_id, names):
    with _lock:
        _con.execute('UPDATE records SET names=? WHERE id=?', (json.dumps(names, ensure_ascii=False), record_id))
        _con.commit()
    return get_record(record_id, full=False)


def list_records():
    """The newest record of every video, newest video first."""
    with _lock:
        rows = _con.execute('SELECT r.* FROM records r JOIN (SELECT vkey, MAX(version) v FROM records GROUP BY vkey) m '
                            'ON r.vkey=m.vkey AND r.version=m.v ORDER BY r.created_at DESC').fetchall()
    return [_record(r, full=False) for r in rows]


def _run(r):
    d = dict(r)
    d['usage'] = json.loads(d['usage'])
    return d


def add_run(vkey, record_id, kind, prompt, model, result, usage, base_run=None, book_id=None):
    with _lock:
        n = _con.execute('SELECT COUNT(*) FROM runs WHERE vkey=? AND kind=?', (vkey, kind)).fetchone()[0]
        cur = _con.execute('INSERT INTO runs(vkey,record_id,version,kind,prompt,base_run,model,result,book_id,usage,created_at) '
                           'VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                           (vkey, record_id, n + 1, kind, prompt, base_run, model, result, book_id,
                            json.dumps(usage or {}), time.time()))
        _con.commit()
        return get_run(cur.lastrowid)


def get_run(run_id):
    with _lock:
        r = _con.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
    return _run(r) if r else None


def set_run_book(run_id, book_id):
    with _lock:
        _con.execute('UPDATE runs SET book_id=? WHERE id=?', (book_id, run_id))
        _con.commit()


def list_runs(vkey, kind=None):
    with _lock:
        rows = _con.execute('SELECT * FROM runs WHERE vkey=? AND (? IS NULL OR kind=?) ORDER BY id DESC',
                            (vkey, kind, kind)).fetchall()
    return [_run(r) for r in rows]


def book_video_for(url):
    """A book analysed from this link already downloaded it: reuse that file."""
    with _lock:
        rows = _con.execute('SELECT source FROM books').fetchall()
    for r in rows:
        src = json.loads(r['source'])
        if src.get('url') == url and src.get('video'):
            return src
    return None
