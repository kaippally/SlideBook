declare global { interface Window { pywebview?: { api: { open_window: (path: string, title: string, w?: number, h?: number) => void; pick_folder: (start?: string) => Promise<string> } } } }

// A window of the desktop app (pywebview), or a browser popup when SlideBook runs in a browser.
export function openWindow(path: string, title: string, w = 1280, h = 760) {
  if (window.pywebview?.api) window.pywebview.api.open_window(path, title, w, h);
  else window.open(path, title.replace(/\W/g, ''), `width=${w},height=${h}`);
}
