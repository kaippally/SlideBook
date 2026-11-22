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
''')
if 'subtitles' not in {r[1] for r in _con.execute('PRAGMA table_info(videos)')}:
    _con.execute("ALTER TABLE videos ADD COLUMN subtitles TEXT NOT NULL DEFAULT '[]'")
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
        styles = get_setting('defaultStyles') or BUILTIN_STYLES
    with _lock:
        _con.execute('INSERT INTO books(id,title,grp,styles,manifest,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
                     (bid, title, group, json.dumps(styles), json.dumps(manifest or []), json.dumps(source or {}), now, now))
        _con.commit()
    return get_book(bid)


def update_book(book_id, **fields):
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


def list_jobs(limit=30):
    with _lock:
        rows = _con.execute('SELECT * FROM queue ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
    return [_job(r) for r in rows]


# ── videos (links that arrived by Telegram, for the Videos window) ───────────

_VIDEO_JSON = ('summaries', 'shorts', 'tg', 'subtitles')


def _video(r, full=False):
    d = dict(r)
    for k in _VIDEO_JSON:
        d[k] = json.loads(d[k])
    tr = d.pop('transcript')
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


def delete_video(video_id):
    with _lock:
        _con.execute('DELETE FROM videos WHERE id=?', (video_id,))
        _con.commit()


def requeue_videos():
    with _lock:
        _con.execute("UPDATE videos SET status='pending' WHERE status='downloading'")
        _con.commit()


def book_video_for(url):
    """A book analysed from this link already downloaded it: reuse that file."""
    with _lock:
        rows = _con.execute('SELECT source FROM books').fetchall()
    for r in rows:
        src = json.loads(r['source'])
        if src.get('url') == url and src.get('video'):
            return src
    return None
