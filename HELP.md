# SlideBook and the Studio Mate bot — Help

This is the one help file for both places you use SlideBook: the **Studio Mate app inside Telegram** and the **SlideBook desktop app**. The desktop shows all of it (the ? Help button). The Telegram app shows only the sections your permissions cover.

<!-- for: everyone -->
## 1. Getting started in Telegram

1. Open **@KaippsCafe_bot** and send **/start**.
2. Tap **📱 Share Phone Number** — that is how the studio recognises you. Typing the number does not work; use the button.
3. Wait for the studio to switch on what you may do. Until then the bot answers, but does nothing with what you send.
4. Send **/app** (or tap the button the bot sends) to open the **Studio Mate app**. Its home screen has one tile for each thing you are allowed to do. Telegram's **Back** arrow always returns there.

The app opens only while the studio's connection is up. If a button says the app is unavailable, try again later.

<!-- for: everyone -->
### 1.1 Permissions

The studio switches each of these on or off for you, one by one.

| Permission | What it lets you do |
|---|---|
| Send links | Send any link to the bot |
| Photos | Send pictures into a SlideBook book |
| Clips | Capture a video into the studio's Clip Library |
| Find shorts | Have a video hunted for Shorts |
| Carousels | Turn a photo post into a slide deck |
| Transcribe | Get a whole video back as text |
| SlideBook | Analyse links in SlideBook, mark shorts, and step the book on air |
| Reports | Read the debate reports and get them as PDFs |

<!-- for: send slidebook transcribe -->
## 2. Sending a link

Send a YouTube, Instagram, Facebook or news link. The bot answers with **⚙️ Choose what to do**, which opens the app on one screen with your choices:

- **Analyse and send to SlideBook** — the video becomes a slide book of fact-check and fallacy cards. Tell it what kind of video it is (one speaker, debate or interview, panel with a moderator), what to examine (claims, fallacies, whether questions were answered, the moderation, a fallacy count per speaker, contradictions), and optionally the background, who is speaking and what you expect. Choose **A new book** or **The book on air**. Progress arrives as one message that updates itself about every 20 seconds: which step it is on (for example *Step 3 of 5 — Transcribing: who said what, part 52 of 104*), a progress bar with the percentage, and while Claude analyses, roughly how many minutes are left. When the book is ready the message gets **▶ Put on air**, and the English and Malayalam reports follow as PDFs a few minutes later.
- **Mark shorts in SlideBook** — SlideBook finds every complete idea that fits a Short and sends the list back as a checklist. Tick the ones to keep (or **Tick all**) and press **✅ Confirm**; they are rendered at full resolution and the same message tells you when they are done.
- **Transcribe to text file** — the whole video as a text file in your chat. A video is transcribed only once; asking again returns the saved transcript.

You only see the choices your permissions allow.

<!-- for: photo -->
### 2.1 Photos

Send a photo and the bot asks which slide book to put it in — an existing one or a new book named after the caption.

<!-- for: reports -->
## 3. Reports

Open **📚 Reports** (the keyboard button, or the Reports tile in the app).

1. The list shows every debate that has a report, with its YouTube thumbnail. Search by title.
2. Tap a debate to see its reports. Each one has its cover picture and a language badge: **EN** or **മലയാളം**.
3. Tap a report to read it. **Every time in a report is a link** — tap it and YouTube opens at that moment.
4. **PDF** on a report (or the button at the bottom while reading) sends it to your chat as a PDF made for a phone.

<!-- for: reports -->
### 3.1 What a report is

- Claude writes each report from the video's saved transcript and the latest analysis, following the studio's request.
- Every report comes as a **pair: English and Malayalam**. The Malayalam follows the speakers: formal Malayalam stays formal, and English words they mixed in stay in English with the Malayalam beside them.
- Reports are written from an atheist, rationalist perspective. They never invent a quote, a fact or a time.
- Up to six stills from the video show the moments the report points to.

<!-- for: slidebook -->
## 4. SlideBook on air from your phone

Open the **SlideBook on air** tile (or send **/sb**). It shows the book on air, the page number, this card's title and the next one. **◀ Prev** and **Next ▶** step it; **↻** reads it again. In the chat, **/sb next** and **/sb prev** step it without opening the app.

<!-- for: owner -->
## 5. The owner's tools in the app

<!-- for: owner -->
### 5.1 Videos (/videos)

Every video SlideBook has transcribed, with its reports. A debate's screen also has:

- **📄 New report** — write how it should be made, in your own words, or leave it empty to use your saved preferences. Both PDFs (English and Malayalam) arrive in the chat a few minutes later.
- **❓ Ask** — a question about the debate, e.g. *"At 00:20:15 he asked about fine-tuning — how did the other side answer?"* The answer appears in the app with every time linked. Earlier questions are listed under it.
- **🔁 Re-analyse** — **Refine latest** improves the newest analysis with what you write; **Fresh** starts over. The new book and both reports come to the chat.
- **🗣 Speaker names** — give each speaker label a real name; every later analysis, report and answer uses them. After a new debate is transcribed the bot also asks you once in the chat.
- **📝 Transcript** — the transcript every report is made from, with every time linked.
- **🧠 My report preferences** (top of the list) — the lasting preferences every report follows. Each report request you write updates them; edit or reset them here.

After every analysis the report pair is written and sent automatically.

<!-- for: owner -->
### 5.2 Users (/users)

Everyone who has messaged the bot. **Waiting for access** have no permission yet; **With access** shows how many they hold. Tap a person for one switch per permission, their name, and **Remove** (they then have to share their phone number again). A new person also arrives as a chat message with quick switches.

<!-- for: owner -->
### 5.3 Status and link logs

- **Status (/status)** — CPU and memory, the busiest processes and the Studio Mate services, refreshed every 5 seconds.
- **Link logs (/logs)** — what each sent link actually did, step by step. Tap one to read it; **Delete all** clears them.

<!-- for: owner -->
### 5.4 When the app cannot open

If the studio connection is down, every command answers in the chat the old way instead (lists and buttons), so nothing is out of reach.

<!-- for: desktop -->
## 6. The SlideBook desktop app

<!-- for: desktop -->
### 6.1 The main window

- **Left — Book | Slides | Reports.**
  - **Book** — paste a link and **Analyse** it into a new book or the open book, with a critique stance. Below are the jobs and the library: search, sort with a direction toggle, a size slider whose far-left stop is a list, and groups. The book on air is green. Hover a book for **🔁 Re-analyse** and **❓ Ask** (when it has a saved transcript), rename and delete.
  - **Slides** — the open book's slides, grouped by moment in the video. Click a group's **▶ time** to play its clip, then step its slides. Tools: **＋ Images / PDF** (or drop files), **＋ Claim**, **＋ Fallacy**, **Paste**; each slide can be hidden, copied or deleted.
  - **Reports** — see section 6.3.
- **Centre — the canvas.** **✎ Edit** to arrange the slide and the video (drag moves, Ctrl+drag tumbles, Shift+wheel sets depth); **▶ Play** shows it as the audience will. **Put on air** sends the book to OBS; **Take off air** clears it. Top right: **Speaker** (where this window's sound plays), **Videos**, **Navigator** (cards and transcript in their own window), **Output** (what OBS shows).
- **Bottom — the clip panel.** Play, pause and skip the clip; the whole video as one timeline with every segment's clip on it; handles to give a segment its own range.
- **Right — the Inspector.** Card (verdict, severity, text, sources, a time that opens YouTube at that moment), Card look, Motion, Surface, Notes, Book (title, card shape, counter on air, use this look for new books). Click the video on the canvas to inspect it instead: size, blur, and whether its clip plays before the card or with it.

<!-- for: desktop -->
### 6.2 Videos window

Every link sent by Telegram lands here, and you can paste one in.

- **Library** — **Videos** (thumbnails, who sent it, download progress, how many shorts) and **Shorts** (every rendered short; save to a folder, edit, delete). ✕ deletes a video and everything made from it after a warning.
- **Timeline** — drag to scrub, **I** / **O** set a range, Space plays, Shift+wheel zooms. On the range: **Fact check** (a new book from just that range), **Summarize**, **Make short**, **Clip** (save it to a folder) and **Subtitles** in Original, English, Malayalam, Hindi, Arabic or Tamil.
- **Short builder** — **Find shorts** picks the strongest statements as Shorts of 2:00–2:50. Edit the lines (untick to cut, **+ line before / after**), the picture (fill, whole picture on blur, or split into two panels), subtitles, title and sound effects. **Check virality** scores the edit and suggests hooks; **Write prompt** makes a cover-image prompt. **Render short** (full resolution by default) or **Render & save to…**.
- **re-transcribe** throws the transcript away and makes it again, keeping every short.

<!-- for: desktop -->
### 6.3 Reports tab

1. Pick a transcript, write how the report should be made (or leave it empty for your saved preferences) and press **Write reports (English + മലയാളം)**. It takes 3–6 minutes.
2. Click a report to read it on the canvas. Every time is a link to YouTube at that moment.
3. **Telegram** on a report sends it to you as a phone PDF.

<!-- for: desktop -->
### 6.4 Settings (⚙)

- **Gemini** — the API key used for transcription and the video tools.
- **Telegram** — SlideBook's own bot, which takes over only while the Studio Mate bot is down. It needs its own token (never the Studio Mate bot's) and your Telegram user id.
- **Critique** — the stances you can analyse with.
- **House rules — Claude** — the perspective and rules every analysis, report and answer follows.
- **Report preferences — learned** — the list every report follows, updated from each request.

<!-- for: desktop -->
### 6.5 Keys

| Key | Action |
|---|---|
| → · PageDown · Space · Num 6 | next page |
| ← · PageUp · Shift+Space · Num 4 | previous page |
| Delete | delete the selected pages (asks first) |
| Ctrl+C · Ctrl+V | copy pages · paste pages or an image |
| Esc · Enter | close · accept any dialog |

A presentation clicker works as it is.

<!-- for: desktop -->
### 6.6 OBS

- Add a **Browser Source**, 1920×1080, at `http://127.0.0.1:8780/output` for the slides and video, and one at `http://127.0.0.1:8780/sfx` for the slide-change sound, so each has its own fader.
- The `obs\slidebook-keys.lua` script (OBS → Tools → Scripts → ＋) adds *SlideBook: Next slide* and *Previous slide* hotkeys that always step the book on air.

<!-- for: desktop -->
### 6.7 How a video is handled

1. **Transcribed once.** Gemini writes down who said what, with times. That transcript is saved and reused by everything after it — analyses, reports, questions, shorts and Transcribe.
2. **Analysed by Claude** (Opus) into fact-check, fallacy, exchange, contradiction and moderation cards.
3. **Reports** are written by Claude in English and Malayalam; **Ask** answers come from Claude (Sonnet) reading the whole transcript.
4. Claude runs on the studio's Claude subscription. A report pair for a long debate costs roughly $2–3 of its credit.

<!-- for: desktop -->
### 6.8 Updates

An installed copy checks for a new release each time it starts, downloads it in the background and offers **Restart and update** with the list of changes.
