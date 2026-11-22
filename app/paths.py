import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPILED = getattr(sys, 'frozen', False)

# Bundled, read-only assets travel inside the exe (PyInstaller unpacks them to _MEIPASS);
# everything the operator makes lives beside the exe so it survives a rebuild.
if COMPILED:
    BASE = Path(sys.executable).resolve().parent
    DIST = Path(sys._MEIPASS) / 'dist'
else:
    BASE = HERE.parent
    DIST = BASE / 'web' / 'dist'

DATA = BASE / 'data'
MEDIA = DATA / 'media'
FONTS = BASE / 'fonts' if (BASE / 'fonts').exists() else HERE / 'fonts'
TOOLS = BASE / 'tools'
DB_FILE = DATA / 'slidebook.db'
PORT = 8780

for d in (DATA, MEDIA / 'images', MEDIA / 'audio', DATA / 'work'):
    d.mkdir(parents=True, exist_ok=True)


def tool(name: str) -> str:
    """A bundled tool beside the exe if present, else whatever is on PATH."""
    p = TOOLS / f'{name}.exe'
    return str(p) if p.exists() else name
