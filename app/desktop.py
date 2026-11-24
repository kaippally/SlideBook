import json, socket, sys, threading, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import webview  # noqa: E402
import server  # noqa: E402
import updater  # noqa: E402
from build_info import BUILD, BUILT  # noqa: E402
from paths import PORT  # noqa: E402

VERSION = '0.1.0'
STAMP = f'{VERSION} · build {BUILD} ({BUILT})'


def already_running():
    """Is the port taken? Asked of the socket, not the API: a busy SlideBook can take longer than a second to
    answer, and a second copy started then cannot bind the port and draws an empty window."""
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(('127.0.0.1', PORT)) == 0


class Api:
    """Exposed to the page as window.pywebview.api — opens the separate windows."""

    def open_window(self, path, title, width=1280, height=760):
        webview.create_window(f'{title} {STAMP}',f'http://127.0.0.1:{PORT}{path}', width=width, height=height, js_api=self)

    def pick_folder(self, start=''):
        win = webview.active_window() or webview.windows[0]
        r = win.create_file_dialog(webview.FOLDER_DIALOG, directory=start or '')
        return r[0] if r else ''


def open_in_running(path, title):
    """SlideBook is already up (the main window or the Videos window): ask it to open this window too, so
    one process owns the server and the windows share it."""
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/api/open-window', method='POST',
                                 data=json.dumps({'path': path, 'title': title}).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=3)
        return True
    except Exception:
        return False


def main():
    # `SlideBook.exe --videos` (what SlideBookVideos.exe runs) is the Videos window on its own.
    path, title = ('/videos', 'SlideBook Videos') if '--videos' in sys.argv else ('/', 'SlideBook')
    if already_running():
        if open_in_running(path, title):
            return
    else:
        # An update downloaded last time is applied before anything starts; the app comes back in the new version.
        r = updater.enabled() and updater.pending(VERSION)
        if r:
            updater.apply(r, sys.argv[1:])
        ready = threading.Event()
        threading.Thread(target=server.run_forever, args=(ready,), daemon=True).start()
        ready.wait(15)
    server.app_version = VERSION
    server.app_build = BUILD
    updater.start(VERSION)
    api = Api()
    server.open_window_hook = api.open_window
    webview.settings['ALLOW_DOWNLOADS'] = True
    webview.create_window(f'{title} {STAMP}', f'http://127.0.0.1:{PORT}{path}', width=1500, height=950,
                          min_size=(1000, 650), js_api=api)
    webview.start()


if __name__ == '__main__':
    main()
