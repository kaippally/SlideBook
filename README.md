# SlideBook

A standalone Windows app that turns a video link into a linear slide show of **fact-check (FactBox) cards and logical-fallacy cards**, presented with StudioMate's 3D slide motion (IN / HOLD / OUT poses, slab, border, floor reflection). The video plays separately. The presenter steps the slides by hand.

## 1. Running

| | |
|---|---|
| Packaged app | `SlideBook.exe`. Keep the `fonts\` folder beside it. `data\` is created beside it |
| Dev, backend | `.venv\Scripts\python.exe app\server.py` → http://127.0.0.1:8780 |
| Dev, window | `.venv\Scripts\python.exe app\desktop.py` (starts the server if none is running) |
| Dev, frontend | `cd web; npm run dev` → Vite on :5280, proxies `/api`, `/media`, `/ws` to :8780 |
| Build the exe | `pwsh -File build.ps1`: typecheck, Vite build, PyInstaller onefile → `SlideBook.exe` (Nuitka was dropped: MSVC runs out of heap on `google.genai.types` and PyMuPDF's `mupdf.py`) |
| OBS | Browser Source, 1920×1080, `http://127.0.0.1:8780/output` |
| Install | Double-click `Setup-SlideBook.cmd` (or `Setup-SlideBook.ps1`) beside a built `SlideBook.exe`. Installs per-user to `%LOCALAPPDATA%\Programs\SlideBook` with no admin, gets WebView2 / ffmpeg / Node 22+ via winget if missing, and adds Start Menu, Desktop and Apps & features entries. `-CopyData` brings this folder's library along, `-GeminiKey <key>` stores the key, `-Uninstall` removes it |

The Gemini key is set in Settings (⚙). If none is saved, the `GEMINI_API_KEY` environment variable is used. `ffmpeg` is taken from `tools\` beside the exe if present, otherwise from PATH.

## 2. Layout

- **Left: Book | Slides.** Opening a book switches to **Slides**: the book's slides grouped by time segment, the timestamp beside each group. Slides at the same second of the video are one segment. Its clip plays once, on entering it, and its slides then step on click or arrow with no clip between them. Click a segment's **▶ timestamp** to start it: its video plays, then its slides follow on click or arrow, and the step after the last one lands on the next segment's video. **↑ Join above** (hover the first slide of a group) moves a slide into the segment above. **Book** is the library: the link box (*Analyse* into a new book or into the open book, with a critique stance), the job list, then the library: search, sort with a direction toggle, a density slider whose far-left stop is list mode, and groups. The book on air wears the emerald skin.
- **Centre: Canvas.** **✎ Edit | ▶ Play** at the top left. *Edit* is for arranging: both the slide and the video, the In/Hold/Out poses, the surface line, and stepping without clips. *Play* shows the canvas as the audience will see it: the slide at rest, the video only while its clip plays, nothing to grab, and every step playing its sequence. A clicked timestamp switches to Play. In Edit, the page is at the selected pose. Drag moves it, Ctrl+drag tumbles it, Shift+wheel sets depth, and the red surface line can be dragged. *Put on air* sends the book to the output.
- **Bottom: the clip panel.** ⏮ / ▶⏸ / ⏭ drive the clip on screen, on air too: ▶ on an ended clip plays it again, and ▶ on a card starts its segment. Below that, the whole video is one timeline with every segment's clip on it and the playhead. Click a clip to start that segment, or anywhere else to preview the moment on the canvas. Under it, the current segment's clip is zoomed, with a handle at each end: drag them to give that segment its own range. *Reset* returns to the automatic range.
- **Slides tab tools:** *＋ Images / PDF* (or drop files), *＋ Claim*, *＋ Fallacy*, *Paste*. Each slide has hide ◉, copy ⧉ and delete ×. Each segment has *Hide* / *Show* and *Delete*.
- **Card look → Border:** the ring around every slide, card and the video object: width, colour, rounding and line style.
- **Right: Inspector.** Card (verdict, severity, rich text, sources), Card look (the book's card design), Motion, Surface, Notes, Book (title, card shape, source, *use this look for new books*).
- **The video object.** The source video is a second object on the canvas and on `/output`. You pose, size, tumble, slab and reflect it exactly like a slide.
  - Click it, or press **Video** above the canvas, to select it. The inspector then shows **Video · Motion · Surface** for it. Click the slide, or press **Slide**, to go back.
  - The video's **Video** tab has *Size* (Width / Height as % of the frame; another shape crops the picture, never stretches it) and *Blur* (on/off and amount). **Blur** is also a toggle on the canvas toolbar, so it can be flipped mid-show.
  - Every analysed book keeps its video, up to 720p. For an older book, use Book → *Fetch the video for the canvas* once.
- **Clip before the card.** Stepping to a fact-check or fallacy card first plays its moment in the video object, from 3 s before to 3 s after. The video then flies out as the card flies in. Prev never plays it. The **Card after video / Card + video together** toggle (canvas toolbar, or the video's **Video** tab) picks between that and both on screen at once. *Before*, *After*, *Volume* and on/off are on the video's **Video** tab, and **▶ Clip** on the canvas replays it. While the book is on air, the canvas copy is silent, because `/output` carries the sound. The cards show their timecode, and for YouTube the Inspector's timecode links to the original at that moment.
- **Sound.**
  - **In this window:** the **Speaker** list in the top bar picks the device the canvas video and the slide-change sound play on. It does not change what goes on air.
  - **In OBS:** the video comes from the `SlideBook` source (`/output`) and the slide-change sound from `SlideBook SFX` (`/sfx`), so each has its own fader. While `/sfx` is open, `/output` plays no slide-change sound; without it, `/output` plays the sound as before.
- **Card size.** Card look → *Size*: the width and height of every fact-check and fallacy card, as % of the frame. *Reset* returns to the card shape, as large as fits.
- **Navigator.** The cards and the transcript in a window of their own. Click a card to go to it, or a transcript line to play that moment on the canvas.
- **Counter on air.** Inspector → Book → *Counter on air*. It shows a running tally of verdicts, fallacies and dodged questions on the cards up to the page on air, per speaker or together, at the top or the bottom of `/output`.

### 2.1 Videos window

**Videos** (canvas toolbar) opens a separate window, `/videos`. Every link that arrives by Telegram lands there: from StudioMate's bot (as well as its analysis) and from the fallback bot (only there). A link can also be pasted in. Links sent before the window existed are added once at startup, and a video already downloaded for a book is reused.

- **Library (left):** thumbnails, with search. A tile shows its download step or *Failed · retry*. ✕ removes the video from the library.
- **Canvas (right):** the selected video.
- **Control (bottom):** a range bar. Drag the amber handles or the band, or click to seek. Use *Set in* **I**, *Set out* **O**, *▶ Range* and *Whole video*. Space plays and pauses. Every button works on the range:
  - **Fact check:** a queue job on the range's lines only → a book titled with the range.
  - **Summarize:** Gemini, in the Critique language.
  - **Make short:** a 1080×1920 centre crop in `data/media/shorts`.
  - **Clip:** the range uncropped. It asks for a folder (the last one is remembered).
  - **Subtitles [language]:** Original, English, Malayalam, Hindi, Arabic or Tamil. It writes an SRT timed from the range start (it fits a clip or short cut from the same range) and a VTT that the canvas shows.

The transcript comes from YouTube captions (fetched once per video). Without captions, Gemini transcribes only the range, cached per range in `data/work`.

## 3. Keys

| Key | Action |
|---|---|
| NUM5 / NUM6 / → / PageDown / Space | next page |
| NUM4 / ← / PageUp / Shift+Space | previous page |
| Delete | delete the selected pages (asks first) |
| Ctrl+C / Ctrl+V | copy selected pages / paste pages or an image |
| Esc / Enter | close / accept any dialog |

A presentation clicker that sends PageUp/PageDown works as is.

### 3.1 Stepping from OBS

`obs\slidebook-keys.lua` adds two OBS hotkeys, *SlideBook: Next slide* (→) and *SlideBook: Previous slide* (←). They always step the book **on air**, whatever is open in the editor.

1. OBS → **Tools → Scripts** → **＋** → pick `obs\slidebook-keys.lua`.
2. Check or rebind the keys in **Settings → Hotkeys** (search "SlideBook").
3. OBS hotkeys fire even when OBS is not focused, so arrows typed in another app would step the slides too. To stop that, set **Settings → Advanced → Hotkeys focus behaviour → Disable hotkeys when main window is not in focus**.

The script posts `{"action":"next","target":"live"}` to `http://127.0.0.1:8780/api/control` (the port can be changed in the script's properties). If SlideBook is not running, a warning goes to **Tools → Scripts → Script Log**.

## 4. How it works

### 4.1 Model

A **book** has an ordered `manifest` of pages (`pdf` and `image` with a content-hashed `ref`, or `claim` and `fallacy` with a `card`), plus `styles`. `styles` is StudioMate's `DeckStyles` shape: presentation poses, surface, border, align, heading, sound, per-page look keyed by the stable page id, and per-aspect overrides. It also holds `card`, the card look. All cards in a book share one aspect (`cardAspect`).

### 4.2 Rendering

The renderer is StudioMate's own Slides code, copied: `SlideLayer` → `SlidePoseView` → `SlideObject`. `SlideObject` gained a third face beside `<img>` and `<video>`: **`CardFace`**, drawn as DOM in the 1920 space and scaled. That means the slab, border, shadow, reflection and heading all apply to cards unchanged. `lib/bookModel.ts` is the only resolver from (book, page) to what is drawn. The canvas, the strip and the output all use it.

### 4.3 Navigation

Navigation is server-authoritative, as in StudioMate. Every surface (canvas, strip, keys, Telegram, navigator) sends `POST /api/control`. The server owns `view` (preview) and `live` (on air), persists both, and broadcasts one `state` message that every client follows. A page edit keeps the cursor on the same page by its id.

### 4.4 Analysis

A link becomes a row in the `queue` table first, whether it was pasted in the app or sent to the bot. The worker then runs these steps:

1. Read the title with yt-dlp.
2. Get a transcript: YouTube captions (`youtube-transcript-api`), or download the video and have Gemini transcribe it.
3. Run the debunker. `app/analysis.py` is a port of StudioMate's `server/src/factCheckCore.ts`, with the same prompt, rules and parse. **Change one and copy the change to the other.**
4. Build cards in argument order (a claim, then the fallacy it rests on). `t` is snapped to the caption line and `tEnd` is capped at the next card's start.
5. Write a new book, or append to the chosen one.

A failed job retries with backoff (3 attempts). A failure Gemini reports as permanent stops at once.

#### 4.4.1 Debate and panel mode

When the job's `kind` is `debate` or `panel`, captions are skipped, because they carry no speakers.

1. The audio is downloaded and transcribed by Gemini **in 5-minute parts** (each part's times rescaled to its real length; the transcript is cached per job), with speaker labels (seeded by the optional `speakers` hint; names carry from part to part).
2. `analyse_debate` runs a second prompt, built from the `examine` list:
   - exchanges (question → answer → **Answered / Partly / Dodged**, rhetorical questions excluded);
   - moderation (fair / uneven / absent, with points);
   - claims (at most 25) and fallacies, each with a speaker;
   - contradictions.
3. `build_debate_cards` orders them in time, each exchange followed by what was said inside it, then closes with a **moderation** card and a per-speaker **scorecard**.

The new page kinds are `qa`, `moderation`, `contradiction` and `scorecard` (`web/src/lib/cardKinds.ts` lists them, with their labels and colours). YouTube downloads need Node on PATH and the `yt-dlp-ejs` package (bundled in the exe).

### 4.5 Telegram

SlideBook has no bot of its own. Links arrive through **StudioMate's bot** (@KaippsCafe_bot): its link menu has **Analyse and send to SlideBook** for anyone with the `can_slidebook` grant (StudioMate Settings → Telegram Bot). The menu asks:

- what kind of video it is (one speaker / debate / panel);
- what to examine;
- who is speaking;
- the tone (this app's critique stances, read from `GET /api/stances`);
- the card language;
- what the sender expects;
- whether to start a new book or add to the book on air.

The bot POSTs the link and the answers to `/api/analyse` (`origin: studiomate-bot`, with a `notify` address). `app/relay.py` posts each step back to the bot's event server (`http://127.0.0.1:5001/event`, overridable with `STUDIOMATE_BOT_EVENT_URL`), and the bot edits one status message. When the book is ready, that message gets **▶ Put on air**. `/sb next`, `/sb prev` and `/sb live` step the book on air. The StudioMate side is described in its `data/docs/MODULES/TELEGRAM.md` §7.4.2.

#### 4.5.1 Fallback bot

`app/bot.py` checks StudioMate's bot every 20 s on `GET :5001/health`. If nothing answers, the bot is **down**. If it answers `api: false`, it is **not logged in**. In either case SlideBook starts its own bot, if one is set up. While no bot of its own is set up, or its token is refused, the app opens a **Telegram bot** dialog that asks for a bot token (from @BotFather) and the one Telegram user id allowed to use it. *Cancel* (Esc) hides the dialog until the status changes. The dialog can also be opened from Settings → *SlideBook's own bot…*.

The own bot takes links (each becomes a `telegram`-origin job, and its reply message is edited with each step and ends with **▶ Put on air**), plus `/next`, `/prev` and `/live`. It answers only the saved user id, and tells anyone else their id. The bot polls only while StudioMate's bot is unavailable, and stands down when it comes back, so the two never poll at the same time, even with the same token. A token Telegram refuses is not retried until a new one is saved. Network failures are retried on every check. The token and user id are stored in the `settings` table as `botToken` and `botUserId`.

## 5. Data

`app\import_studiomate.py` copies StudioMate's slide decks in as books, keeping page ids so per-page looks, crops and notes carry over. Video pages and the music playlist are skipped, and a re-run skips decks already imported (`source.studiomateDeck`). Run it with `.venv\Scripts\python.exe import_studiomate.py` from `app\`.

`data\slidebook.db` (SQLite) holds the tables `books`, `settings` and `queue`. Images live in `data\media\images\<sha1>.<ext>`; unreferenced ones are removed at startup. Downloaded source videos live in `data\media\video\`.
