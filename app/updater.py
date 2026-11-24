"""Keeps an installed SlideBook on the latest GitHub release.

Every launch: an update downloaded last time is applied first (the app restarts into the new version), then
GitHub is asked for a newer release, which is downloaded in the background. The release notes are the change
list shown to the operator. A source checkout (a .git folder beside the exe) is never updated.
"""
import json, logging, os, shutil, subprocess, threading, time, urllib.error, urllib.request, zipfile
from pathlib import Path

from paths import BASE, COMPILED, DATA

log = logging.getLogger('slidebook')

REPO = 'kaippally/SlideBook'
UPD = DATA / 'update'
READY = UPD / 'ready.json'       # downloaded, waiting to be applied
APPLIED = UPD / 'applied.json'   # just applied; the notes are shown once
state = {'state': 'idle', 'version': '', 'notes': '', 'error': ''}


def _ver(v):
    return tuple(int(x) for x in str(v).lstrip('vV').split('.') if x.isdigit())


def enabled():
    return COMPILED and not (BASE / '.git').exists()


def _get(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'SlideBook-updater', 'Accept': 'application/vnd.github+json'})
    return urllib.request.urlopen(req, timeout=timeout)


def pending(current):
    """The downloaded update to apply now, if it is newer than this build."""
    try:
        r = json.loads(READY.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if _ver(r['version']) > _ver(current) and Path(r['dir']).is_dir():
        return r
    READY.unlink(missing_ok=True)
    return None


def apply(r, args):
    """Hand over to a script that waits for SlideBook to close, copies the new files in and starts it again."""
    script = UPD / 'apply-update.cmd'
    exe = BASE / 'SlideBook.exe'
    relaunch = f'"{exe}" {" ".join(args)}'.strip()
    script.write_text('\r\n'.join([
        '@echo off',
        ':wait',
        f'tasklist /FI "IMAGENAME eq SlideBook.exe" 2>nul | find /I "SlideBook.exe" >nul && (timeout /t 1 /nobreak >nul & goto wait)',
        f'robocopy "{r["dir"]}" "{BASE}" /E /NFL /NDL /NJH /NJS /XD data >nul',
        f'del "{READY}"',
        f'rmdir /S /Q "{r["dir"]}"',
        f'start "" {relaunch}',
    ]), encoding='ascii')
    APPLIED.write_text(json.dumps({'version': r['version'], 'notes': r['notes'], 'at': time.time()}, ensure_ascii=False), encoding='utf-8')
    subprocess.Popen(['cmd', '/c', str(script)], creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW,
                     close_fds=True)
    os._exit(0)


def check(current):
    """Ask GitHub for the latest release and download it when it is newer. Runs in a thread."""
    state.update(state='checking', error='')
    try:
        rel = json.load(_get(f'https://api.github.com/repos/{REPO}/releases/latest'))
        ver = str(rel.get('tag_name') or '').lstrip('vV')
        if not ver or _ver(ver) <= _ver(current):
            state.update(state='current', version=current)
            return
        asset = next((a for a in rel.get('assets') or [] if a['name'] == f'SlideBook-{ver}.zip'), None)
        if not asset:
            state.update(state='current', version=current, error=f'release {ver} has no SlideBook-{ver}.zip')
            return
        state.update(state='downloading', version=ver, notes=rel.get('body') or '')
        UPD.mkdir(parents=True, exist_ok=True)
        zpath = UPD / asset['name']
        with _get(asset['browser_download_url'], timeout=60) as src, open(zpath, 'wb') as dst:
            shutil.copyfileobj(src, dst)
        out = UPD / ver
        shutil.rmtree(out, ignore_errors=True)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(out)
        zpath.unlink(missing_ok=True)
        if not (out / 'SlideBook.exe').is_file():
            raise RuntimeError('the release zip has no SlideBook.exe')
        READY.write_text(json.dumps({'version': ver, 'notes': rel.get('body') or '', 'dir': str(out)}, ensure_ascii=False), encoding='utf-8')
        state.update(state='ready')
    except urllib.error.HTTPError as e:
        if e.code == 404:   # no release published yet
            state.update(state='current', version=current)
        else:
            log.info('update check failed: %s', e)
            state.update(state='error', error=str(e))
    except Exception as e:
        log.info('update check failed: %s', e)
        state.update(state='error', error=str(e))


def start(current):
    if enabled():
        threading.Thread(target=check, args=(current,), daemon=True).start()


def info(current):
    """What the page shows: a just-applied update (once), or a downloaded one waiting for a restart."""
    out = {**state, 'current': current, 'enabled': enabled()}
    try:
        a = json.loads(APPLIED.read_text(encoding='utf-8'))
        if a.get('version') == current:
            out['applied'] = a
    except (OSError, ValueError):
        pass
    return out


def seen():
    APPLIED.unlink(missing_ok=True)
