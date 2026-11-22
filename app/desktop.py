import sys, threading, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import webview  # noqa: E402
import server  # noqa: E402
from paths import PORT  # noqa: E402

VERSION = '0.1.0'


def already_running():
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/state', timeout=1)
        return True
    except Exception:
        return False


class Api:
    """Exposed to the page as window.pywebview.api — opens the separate windows."""

    def open_window(self, path, title, width=1280, height=760):
        webview.create_window(title, f'http://127.0.0.1:{PORT}{path}', width=width, height=height, js_api=self)

    def pick_folder(self, start=''):
        win = webview.active_window() or webview.windows[0]
        r = win.create_file_dialog(webview.FOLDER_DIALOG, directory=start or '')
        return r[0] if r else ''


def main():
    if not already_running():
        ready = threading.Event()
        threading.Thread(target=server.run_forever, args=(ready,), daemon=True).start()
        ready.wait(15)
    webview.settings['ALLOW_DOWNLOADS'] = True
    webview.create_window(f'SlideBook {VERSION}', f'http://127.0.0.1:{PORT}/', width=1500, height=950,
                          min_size=(1000, 650), js_api=Api())
    webview.start()


if __name__ == '__main__':
    main()
