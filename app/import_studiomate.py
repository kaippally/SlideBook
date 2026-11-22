"""Copy every StudioMate slide deck into SlideBook as a book: pages, order, hidden flags, per-page look,
crops, poses, surface, border, notes and the transition sound. Re-running skips decks already imported.
Video pages are skipped (SlideBook has no video page) and the StudioMate music playlist is dropped."""
import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

import fitz

import core
import db

SM = Path(sys.argv[1] if len(sys.argv) > 1 else r'C:\KC_Assets\StudioMate') / 'data'
sm = sqlite3.connect(f'file:{SM / "kcom.db"}?mode=ro', uri=True)
sm.row_factory = sqlite3.Row

groups = {r['id']: r['name'] for r in sm.execute("SELECT id, name FROM library_groups WHERE library='slides'")}
done = {json.loads(r['source']).get('studiomateDeck') for r in db._con.execute('SELECT source FROM books')}


def legacy_crops(row, styles, manifest):
    crops = dict(styles.get('crops') or {})
    legacy = (row['crop_x'], row['crop_y'], row['crop_w'], row['crop_h'])
    if legacy != (0, 0, 1, 1) and manifest:
        aspects = json.loads(row['page_aspects'] or '[]')
        primary = aspects[0] if aspects else manifest[0]['aspect']
        crops.setdefault(f'{primary:.2f}', dict(zip('xywh', legacy)))
    return crops


imported, skipped_video = [], 0
for row in sm.execute('SELECT * FROM slide_decks ORDER BY created_at'):
    if row['id'] in done:
        print('already imported:', row['label'])
        continue
    styles = json.loads(row['styles'] or '{}')
    manifest = json.loads(row['manifest'] or '[]')
    if not manifest:
        aspects = json.loads(row['page_aspects'] or '[]')
        ratio = row['width'] / row['height'] if row['height'] else 16 / 9
        manifest = [{'id': f'p{n}', 'kind': 'pdf', 'ref': n, 'aspect': aspects[n - 1] if n <= len(aspects) else ratio}
                    for n in range(1, row['page_count'] + 1)]

    pdf = None
    if any(e['kind'] == 'pdf' for e in manifest):
        pdf = fitz.open(SM / 'media' / row['filename'])
    pages = []
    for e in manifest:
        if e['kind'] == 'video':
            skipped_video += 1
            continue
        if e['kind'] == 'pdf':
            pix = pdf[int(e['ref']) - 1].get_pixmap(dpi=150)
            ref, _ = core.write_image(pix.tobytes('jpeg', jpg_quality=85), 'jpg')
        else:
            src = SM / 'media' / e['ref']
            ref, _ = core.write_image(src.read_bytes(), src.suffix)
        page = {'id': e['id'], 'kind': e['kind'], 'ref': ref, 'aspect': e['aspect']}
        if e.get('hidden'):
            page['hidden'] = True
        pages.append(page)
    if pdf:
        pdf.close()

    styles['crops'] = legacy_crops(row, styles, manifest)
    styles.pop('music', None)
    snd = styles.get('sound') or {}
    if snd.get('url'):
        f = SM / 'media' / 'audio' / Path(snd['url']).name
        if f.exists():
            snd['url'] = core.write_audio(f.read_bytes(), f.suffix)
        else:
            styles.pop('sound')

    book = db.create_book(row['label'] or row['id'], pages, {'studiomateDeck': row['id']}, styles,
                          groups.get(row['group_id'], ''))
    imported.append(book['id'])
    print(f"imported: {row['label']}  ({len(pages)} pages)")

for bid in imported:
    try:
        b = db.get_book(bid)
        req = urllib.request.Request(f'http://127.0.0.1:8780/api/books/{bid}', method='PATCH',
                                     data=json.dumps({'title': b['title']}).encode(),
                                     headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=3)
    except OSError:
        pass
print(f'{len(imported)} decks imported, {skipped_video} video pages skipped')
