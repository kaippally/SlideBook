"""Link → transcript → claims + fallacies → card pages.

The prompt and the parse are a port of StudioMate's server/src/factCheckCore.ts (analyseTranscript).
Keep the two textually in step: a change to the debunker there should be copied here.
"""
from concurrent.futures import ThreadPoolExecutor
import shutil
import json, logging, os, re, subprocess, uuid
from pathlib import Path

import db
from paths import DATA, tool

log = logging.getLogger('slidebook')

DEFAULT_MODEL = 'gemini-2.5-flash'

LANG_CODES = {'English': 'en', 'Malayalam': 'ml', 'Hindi': 'hi', 'Tamil': 'ta', 'Arabic': 'ar', 'Urdu': 'ur'}
CODE_LANGS = {v: k for k, v in LANG_CODES.items()}

DEFAULT_STANCES = [
    {'id': 'neutral', 'name': 'Neutral fact-check', 'standing': ''},
    {'id': 'rationalist', 'name': 'Secular rationalist', 'standing':
        'Assess every claim by publicly checkable evidence. Treat scripture, tradition, clerical '
        'authority and personal revelation as claims to be examined, never as evidence for the '
        'claim being made. Name the apologetic move by its standard name where one applies — '
        'unfalsifiable reframing, argument from authority, shifting the burden of proof, '
        'special pleading, quote-mining a source. Where a speaker is right, say so plainly.'},
    {'id': 'rights', 'name': 'Rights and due process', 'standing':
        'Weigh claims against constitutional rights, minority protection and due process. Separate '
        'what is alleged from what a court or investigating authority has actually established, '
        'and flag any passage that convicts a person or a community on an allegation. Collective '
        'blame for an individual act is itself a finding worth naming.'},
    {'id': 'press', 'name': 'Press standards', 'standing':
        'Judge the reporting as reporting. Check sourcing, attribution and whether the evidence '
        'offered supports the strength of the claim made. Flag anonymous sourcing carrying a '
        'hard factual load, numbers with no origin, a headline the body does not support, and '
        "anything presented as established that is a single outlet's claim."},
]
DEFAULT_CRITIQUE = {'stances': DEFAULT_STANCES, 'activeId': 'neutral', 'ridicule': 0, 'temperature': 0.3,
                    'maxResults': 0, 'language': '', 'customInstruction': ''}


class AnalysisError(Exception):
    pass


def critique():
    c = {**DEFAULT_CRITIQUE, **(db.get_setting('critique') or {})}
    if not c.get('stances'):
        c['stances'] = DEFAULT_STANCES
    return c


def gemini_key():
    return db.get_setting('geminiKey') or os.environ.get('GEMINI_API_KEY', '')


def gemini_client():
    key = gemini_key()
    if not key:
        raise AnalysisError('No Gemini API key — add it in Settings.')
    from google import genai
    return genai.Client(api_key=key, http_options={'api_version': 'v1beta'})


# ── source ────────────────────────────────────────────────────────────────────

YT_RE = re.compile(r'(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})')


def youtube_id(url):
    m = YT_RE.search(url)
    return m.group(1) if m else None


def youtube_start(url):
    m = re.search(r'[?&#](?:t|start)=(\d+h)?(\d+m)?(\d+)s?', url)
    if not m:
        return 0
    h = int((m.group(1) or '0h')[:-1]); mi = int((m.group(2) or '0m')[:-1])
    return h * 3600 + mi * 60 + int(m.group(3))


def probe(url):
    import yt_dlp
    with yt_dlp.YoutubeDL({'quiet': True, 'skip_download': True, 'noplaylist': True, **YTDLP_JS}) as y:
        info = y.extract_info(url, download=False)
    return {'title': info.get('title') or url, 'duration': info.get('duration') or 0,
            'uploader': info.get('uploader') or '', 'thumbnail': info.get('thumbnail') or ''}


def youtube_captions(vid):
    from youtube_transcript_api import YouTubeTranscriptApi
    listing = YouTubeTranscriptApi().list(vid)
    try:
        picked = listing.find_transcript(['ml', 'en'])
    except Exception:
        picked = next(iter(listing))
    fetched = picked.fetch()
    lines = [{'t': round(s.start, 2), 'd': round(s.duration, 2), 'text': s.text.strip()}
             for s in fetched.snippets if s.text.strip()]
    return {'lines': lines, 'langCode': picked.language_code.split('-')[0], 'generated': bool(picked.is_generated), 'via': 'captions'}


# YouTube's format list needs its JS challenge solved; yt-dlp-ejs ships the solver and Node runs it.
# Without a runtime only a few formats are listed and a download can fail with "format not available".
def _modern_node():
    """yt-dlp's solver refuses an old Node (20.16 here), and PATH can find one before a new one."""
    for path in (shutil.which('node'), 'C:/Program Files/nodejs/node.exe'):
        if not path or not Path(path).exists():
            continue
        try:
            v = subprocess.run([path, '--version'], capture_output=True, text=True, timeout=5,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout.strip()
            if int(v.lstrip('v').split('.')[0]) >= 22:
                return path
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    return None


_NODE = _modern_node()
YTDLP_JS = {'js_runtimes': {'node': {'path': _NODE}}} if _NODE else {}


def download_media(url, name):
    """Download the source video, up to 720p, for the canvas to play (and the transcription to hear).
    VP9 + Opus in WebM first: OBS's browser source, the app's WebView and a stock Chromium all play it,
    where H.264 depends on the build. Returns its path."""
    out = DATA / 'media' / 'video'
    out.mkdir(parents=True, exist_ok=True)
    import yt_dlp
    opts = {'quiet': True, 'noplaylist': True, 'outtmpl': str(out / f'{name}.%(ext)s'),
            'format': 'bv*[height<=720][vcodec^=vp9]+ba[acodec=opus]/bv*[height<=720]+ba/b[height<=720]/b',
            'merge_output_format': 'webm/mp4',
            **YTDLP_JS,
            'ffmpeg_location': tool('ffmpeg') if tool('ffmpeg') != 'ffmpeg' else None}
    with yt_dlp.YoutubeDL({k: v for k, v in opts.items() if v is not None}) as y:
        info = y.extract_info(url, download=True)
        done = (info.get('requested_downloads') or [{}])[0].get('filepath')
        return normalize_audio(Path(done or y.prepare_filename(info)))


def download_full(url, name):
    """The best the source has (up to 2160p), for rendering shorts: the canvas copy stops at 720p."""
    out = DATA / 'media' / 'video'
    out.mkdir(parents=True, exist_ok=True)
    import yt_dlp
    opts = {'quiet': True, 'noplaylist': True, 'outtmpl': str(out / f'{name}.%(ext)s'),
            'format': 'bv*[height<=2160]+ba/b', 'merge_output_format': 'mkv', **YTDLP_JS,
            'ffmpeg_location': tool('ffmpeg') if tool('ffmpeg') != 'ffmpeg' else None}
    with yt_dlp.YoutubeDL({k: v for k, v in opts.items() if v is not None}) as y:
        info = y.extract_info(url, download=True)
        done = (info.get('requested_downloads') or [{}])[0].get('filepath')
        return normalize_audio(Path(done or y.prepare_filename(info)))


def normalize_audio(path: Path) -> Path:
    """Bring the soundtrack to broadcast loudness (EBU R128, -16 LUFS, -1.5 dBTP). A browser plays a
    file at no more than its own level, and many uploads are mixed far quieter than a show. The picture
    is copied untouched. The result gets a new name, because media is served immutable and a player that
    cached the quiet file would keep it. Returns the new path; on failure the original."""
    if path.stem.endswith('.loud'):
        return path
    dst = path.with_name(f'{path.stem}.loud{path.suffix}')
    if not path.exists():
        return dst if dst.exists() else path   # another book sharing this file already had it done
    codec = ['-c:a', 'libopus', '-b:a', '160k'] if path.suffix.lower() == '.webm' else ['-c:a', 'aac', '-b:a', '192k']
    try:
        subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-i', str(path), '-map', '0:v?', '-map', '0:a?', '-c:v', 'copy',
                        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', *codec, str(dst)],
                       check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.CalledProcessError) as e:
        log.warning('loudness pass failed for %s: %s', path.name, e)
        dst.unlink(missing_ok=True)
        return path
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass  # still being streamed to a player: the quiet copy is left behind, unreferenced
    return dst


PART_SEC = 60   # Gemini's clock drifts within a request; in 5-minute parts captions ran up to ~20 s off the speech


def gemini_transcribe(path: Path, speakers=None, progress=None, on_part=None):
    """No caption track, or a debate that needs to know who said what: have Gemini listen and return
    timestamped lines. `speakers` (a hint such as "A = host, B = guest", or '' to detect) labels each line.

    The audio is cut into 1-minute parts and each part is transcribed on its own. Gemini's timestamps drift
    within a request and it drops stretches of speech; in 5-minute parts both were bad enough to put captions
    ~20 s off the words. A minute keeps them honest. Plain parts run four at a time; a debate runs in order, because the speaker names found so far are
    handed to the next part so they stay the same."""
    work = path.with_name(path.stem + '.parts')
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-i', str(path), '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k',
                    '-f', 'segment', '-segment_time', str(PART_SEC), '-reset_timestamps', '1', str(work / 'p%03d.m4a')],
                   check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    parts = sorted(work.glob('p*.m4a'))
    spans = [_media_seconds(p) or PART_SEC for p in parts]
    client = gemini_client()
    lines, names, lang = [], [], 'en'
    done = [0]

    def one(i):
        data, raw = {}, []
        if spans[i] < 1.0:   # the sliver the segmenter leaves at the end holds nothing to hear
            return data, raw
        for attempt in range(3):
            try:
                data = _transcribe_part(client, parts[i], speakers, list(names))
            except AnalysisError as e:
                log.info('part %d of %s unreadable (attempt %d): %s', i, path.name, attempt + 1, e)
                data = {}
                continue
            raw = [{**l, 't': _secs(l.get('t'))} for l in data.get('lines') or [] if str(l.get('text', '')).strip()]
            raw = [l for l in raw if l['t'] is not None]
            if _part_ok(raw, spans[i]):
                break
        done[0] += 1
        if on_part:
            on_part(done[0], len(parts))
        elif progress:
            progress(f'Transcribing{" who said what" if speakers is not None else ""} — part {done[0]} of {len(parts)}')
        return data, raw

    try:
        if speakers is None:
            with ThreadPoolExecutor(4) as pool:
                results = list(pool.map(one, range(len(parts))))
        else:
            results = []
            for i in range(len(parts)):
                results.append(one(i))
                for n in results[-1][0].get('speakers') or []:
                    if str(n) not in names:
                        names.append(str(n))
        offset = 0.0
        for i, (data, raw) in enumerate(results):
            span = spans[i]
            lang = str(data.get('language') or lang)[:2]
            # A part whose clock still overshoots is rescaled; one whose times are nonsense after a second try
            # (all crammed into a few seconds) is spread evenly — approximate, never a pile on one moment.
            top = max((l['t'] for l in raw), default=0)
            k = span / top if top > span * 1.02 else 1.0
            even = not _part_ok(raw, span)
            if even:
                raw = _merge_fragments(raw)
            for n, l in enumerate(raw):
                text = str(l['text']).strip()
                t = span * n / max(1, len(raw)) if even else min(max(l['t'] * k, 0), span)
                line = {'t': round(offset + t, 2), 'd': _secs(l.get('d')) or 3.0, 'text': text}
                if speakers is not None:
                    line['speaker'] = str(l.get('speaker') or '').strip()
                    if line['speaker'] and line['speaker'] not in names:
                        names.append(line['speaker'])
                lines.append(line)
            offset += span
    finally:
        shutil.rmtree(work, ignore_errors=True)
    lines.sort(key=lambda l: l['t'])
    return {'lines': lines, 'langCode': lang, 'generated': True, 'via': 'gemini', 'speakers': names}


def _secs(v):
    """Seconds from a number, or from "SS", "MM:SS(.s)" or "H:MM:SS(.s)" — Gemini places MM:SS far better."""
    if isinstance(v, (int, float)):
        return float(v)
    try:
        out = 0.0
        for part in str(v).strip().split(':'):
            out = out * 60 + float(part)
        return out
    except ValueError:
        return None


def _merge_fragments(raw, words=14):
    """A part Gemini returned word by word: join consecutive lines of one speaker back into sentences."""
    out = []
    for l in raw:
        prev = out[-1] if out else None
        if prev and prev.get('speaker') == l.get('speaker') and len(prev['text'].split()) < words                 and not prev['text'].rstrip().endswith(('.', '?', '!', '।')):
            prev['text'] = f"{prev['text']} {str(l['text']).strip()}"
        else:
            out.append({**l, 'text': str(l['text']).strip()})
    return out


def _part_ok(raw, span):
    """Are this part's times believable? They should spread over most of the part, at a speaking pace."""
    if not raw:
        return True
    ts = [float(l['t']) for l in raw]
    covered = (max(ts) - min(ts)) / max(span, 1)
    per_min = len(raw) / max(span / 60, 0.1)
    return (covered >= 0.5 or span < 60) and per_min <= 40


def _media_seconds(path: Path):
    try:
        out = subprocess.run([tool('ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                             capture_output=True, text=True, check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return float(out.stdout.strip())
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def _transcribe_part(client, part: Path, speakers, names):
    if speakers is None:
        prompt = ('Transcribe this audio verbatim in its original language. Split it into short caption lines of one '
                  'sentence or less. "t" is when the line starts, as "MM:SS.s" from the start of THIS clip; "d" is how long it is spoken, '
                  'in seconds. Respond ONLY with JSON: '
                  '{"language":"<ISO 639-1 code>","lines":[{"t":"MM:SS.s","d":<seconds>,"text":"..."}]}')
    else:
        known = f'Speakers already identified earlier in this recording: {", ".join(names)} — reuse exactly these names for them. ' if names else ''
        hint = (f'The speakers are: {speakers}. Use those names. ' if speakers else
                'Name each speaker by name if they are introduced or addressed by name, otherwise "Speaker 1", "Speaker 2"... ')
        prompt = ('This is one part of a longer recording. Transcribe it verbatim in its original language, with speaker diarisation. '
                  'Split it into short caption lines of one sentence or less, and never let one line run across a change of speaker. '
                  + hint + known + "Keep a speaker's name identical on every line. "
                  '"t" is when the line starts, as "MM:SS.s" from the start of THIS clip; "d" is how long it is spoken, in seconds. '
                  'Respond ONLY with JSON: {"language":"<ISO 639-1 code>",'
                  '"speakers":["<name>",...],"lines":[{"t":"MM:SS.s","d":<seconds>,"speaker":"<name>","text":"..."}]}')
    f = client.files.upload(file=str(part))
    r = client.models.generate_content(model=DEFAULT_MODEL, contents=[f, prompt],
                                       config={'temperature': 0, 'response_mime_type': 'application/json'})
    return _loose_json(r.text)


def _loose_json(text):
    """The JSON object, or — when the reply was cut off mid-list — every complete line object in it."""
    raw = _strip(text)
    try:
        return json.loads(raw)
    except ValueError:
        pass
    lines = []
    for m in re.finditer(r'\{[^{}]*"t"\s*:\s*"?[\d.:]+"?[^{}]*\}', raw):
        try:
            lines.append(json.loads(m.group(0)))
        except ValueError:
            continue
    if not lines:
        raise AnalysisError('Gemini returned an unreadable transcript.')
    lang = re.search(r'"language"\s*:\s*"([a-z]{2})', raw)
    names = re.search(r'"speakers"\s*:\s*\[([^\]]*)\]', raw)
    return {'language': lang.group(1) if lang else 'en', 'lines': lines,
            'speakers': re.findall(r'"([^"]+)"', names.group(1)) if names else []}


# ── the debunker (port of factCheckCore.analyseTranscript) ───────────────────

def ridicule_tone_line(ridicule):
    if not ridicule > 0:
        return ''
    guidance = ('Keep it largely factual with a faintly dry, skeptical edge.' if ridicule <= 0.25 else
                'Add light sarcasm and wit while staying professional.' if ridicule <= 0.5 else
                'Be openly mocking and sardonic toward the bogus claims.' if ridicule <= 0.75 else
                'Be ruthlessly scathing — ridicule the sheer absurdity of the false claims without mercy.')
    return (f'\nTONE: Write the "explanation" text with a ridicule level of {ridicule:.2f} on a 0–1 scale (0 = clinical/neutral, '
            f'1 = scathing mockery). {guidance} Direct the ridicule only at FALSE/MISLEADING/UNPROVEN claims and the fallacies — '
            'never at TRUE claims. The verdict, severity, sources, and factual accuracy must stay exactly correct; only the tone '
            'of the explanation changes.')


def ms_to_timecode(ms):
    s = int(ms // 1000)
    return f'{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}'


def _strip(text):
    return re.sub(r'\s*```$', '', re.sub(r'^```(?:json)?\s*', '', (text or '').strip(), flags=re.I)).strip()


def analyse_transcript(lines, language='English', temperature=0.3, ridicule=0, max_results=0,
                       custom_instruction='', standing_instructions=''):
    lang = language or 'English'
    transcript_lines = '\n'.join(f'[{ms_to_timecode(l["ts"])}|{l["ts"]}ms] {l["text"]}' for l in lines)
    mandate = (f'Your analytical mandate: {standing_instructions}\n\n' if standing_instructions else
               'Critically analyze each sentence for pseudoscience, medical misinformation, historical inaccuracies, and false correlations.\n\n')
    max_line = f'\nReturn at most {max_results} claims (prioritise the most significant).' if max_results else ''
    custom_line = f'\nAdditional instruction: {custom_instruction}' if custom_instruction else ''
    lang_directive = (f'OUTPUT LANGUAGE: {lang}. Write "claim", "explanation" and "passage" entirely in {lang} no matter what language '
                      'the transcript is in — translate quoted passages instead of copying the original wording. The analytical mandate '
                      'below (and any audience it names) governs WHAT you analyse, never the language you answer in. The fallacy "name" '
                      'stays in its standard English form.\n\n')
    prompt = f'''{lang_directive}{mandate}The following is a timestamped transcript from a live broadcast recording. Each line starts with [HH:MM:SS|Nms] where N is the exact millisecond offset. The content may be in any language but you must respond entirely in {lang}.{custom_line}{ridicule_tone_line(ridicule)}

Apply your analytical mandate to the transcript.{max_line}

1. CLAIMS — Extract EVERY factual, medical, scientific, or historical claim. For each:
- Determine verdict and severity
- Write the explanation for the target audience
- Cite peer-reviewed evidence where applicable (NEJM, Lancet, JAMA, BMJ, Nature, Science, Cochrane Reviews — no news or blogs)

2. FALLACIES — Identify ALL logical fallacies and cognitive biases. For each:
- Name the fallacy precisely (e.g. "Appeal to Nature", "Anecdotal Evidence")
- Copy the exact Nms integer from the transcript line where the fallacious argument appears
- Quote or paraphrase the exact passage
- Explain briefly why it is manipulative or misleading

Rules:
- "severity" must be HIGH, MEDIUM, or LOW
- "verdict" must be exactly one of: FALSE, TRUE, MISLEADING, PARTLY TRUE, UNPROVEN
- "cssClass" must be: falseClaim (FALSE/MISLEADING), trueClaim (TRUE), partialClaim (PARTLY TRUE), unprovenClaim (UNPROVEN)
- "titleSave" must be: false-claim (FALSE/MISLEADING), true-claim (TRUE), partial-claim (PARTLY TRUE), unproven-claim (UNPROVEN)
- "timestampMs" must be copied exactly from the Nms value on the transcript line where the claim or fallacy appears
- "durationMs" is typically 3000–10000

Respond ONLY with valid JSON (no markdown fences, no commentary):
{{
  "claims": [
    {{
      "timestampMs": <exact Nms integer>,
      "durationMs": <integer>,
      "claim": "the specific claim in {lang}",
      "verdict": "FALSE|TRUE|MISLEADING|PARTLY TRUE|UNPROVEN",
      "severity": "HIGH|MEDIUM|LOW",
      "cssClass": "falseClaim|trueClaim|partialClaim|unprovenClaim",
      "titleSave": "false-claim|true-claim|partial-claim|unproven-claim",
      "explanation": "2-4 sentences in {lang}. State the scientific consensus and the real danger of believing this.",
      "sources": [
        {{ "label": "Journal Year (Author et al.)", "note": "What this study found" }}
      ]
    }}
  ],
  "fallacies": [
    {{
      "timestampMs": <exact Nms integer where this fallacy appears>,
      "durationMs": <integer>,
      "name": "Name of the logical fallacy or cognitive bias",
      "passage": "The exact quote or paraphrase from the transcript",
      "explanation": "1-2 sentences on why this is misleading"
    }}
  ]
}}
If there are no checkable claims, return: {{ "claims": [], "fallacies": [] }}

TRANSCRIPT:
{transcript_lines}

REMINDER — every "claim", "explanation" and "passage" above must be written in {lang}.'''

    client = gemini_client()
    r = client.models.generate_content(model=DEFAULT_MODEL, contents=prompt,
                                       config={'temperature': temperature, 'system_instruction': lang_directive.strip()})
    stripped = _strip(r.text)
    if not stripped:
        raise AnalysisError('Gemini returned no text.')
    try:
        parsed = json.loads(stripped)
    except ValueError as e:
        raise AnalysisError(f'Gemini returned invalid JSON: {e}')
    raw_claims = parsed if isinstance(parsed, list) else parsed.get('claims') or []
    raw_fallacies = [] if isinstance(parsed, list) else parsed.get('fallacies') or []
    claims = [{
        'timestampMs': round(c['timestampMs']), 'durationMs': round(c.get('durationMs') or 5000),
        'claim': str(c.get('claim', '')), 'verdict': str(c.get('verdict', 'UNPROVEN')), 'severity': str(c.get('severity', 'MEDIUM')),
        'explanation': str(c.get('explanation', '')), 'sources': c.get('sources') if isinstance(c.get('sources'), list) else [],
    } for c in raw_claims if isinstance(c.get('timestampMs'), (int, float))]
    fallacies = [{
        'timestampMs': round(f['timestampMs']), 'durationMs': round(f.get('durationMs') or 5000),
        'name': str(f.get('name', '')), 'passage': str(f.get('passage', '')), 'explanation': str(f.get('explanation', '')),
    } for f in raw_fallacies if isinstance(f.get('timestampMs'), (int, float))]
    usage = getattr(r, 'usage_metadata', None)
    return {'claims': claims, 'fallacies': fallacies, 'language': lang, 'model': DEFAULT_MODEL,
            'tokens': getattr(usage, 'total_token_count', 0) if usage else 0}


# ── debate analysis (SLIDEBOOK_PLAN.md §11.3) ────────────────────────────────

EXAMINE_TEXT = {
    'claims': 'CLAIMS — every factual, medical, scientific or historical claim, with verdict, severity, explanation and evidence, attributed to the speaker who made it.',
    'fallacies': 'FALLACIES — every logical fallacy or cognitive bias, named precisely, with the passage, attributed to the speaker who committed it.',
    'answers': 'EXCHANGES — every question one participant (or the moderator) puts to another, and whether the person asked actually answered it: "ANSWERED" (addressed it directly), "PARTIAL" (touched it but left the core unanswered) or "DODGED" (changed the subject, attacked the asker, filibustered, answered a different question). Say in one sentence why. Leave out rhetorical questions, questions the speaker answers themselves, and pleasantries — only real questions that expect an answer from someone else.',
    'moderation': 'MODERATION — was the moderation fair? Judge "FAIR", "UNEVEN" or "ABSENT", and list the concrete points: interruptions allowed for one side only, unequal speaking time, missed or one-sided follow-ups, leading questions.',
    'tally': 'TALLY — attribute every claim and fallacy to its speaker so they can be counted per speaker (this needs no extra output).',
    'contradictions': 'CONTRADICTIONS — places where one speaker contradicts something they said earlier in the same recording.',
}


def analyse_debate(lines, language='English', examine=(), standing_instructions='', custom_instruction='', temperature=0.3,
                   max_claims=25):
    """A debate or panel: who asked what, whether it was answered, the moderation, and claims and fallacies
    per speaker. `lines` carry `speaker`."""
    lang = language or 'English'
    examine = [e for e in examine if e in EXAMINE_TEXT] or ['claims', 'fallacies']
    transcript_lines = '\n'.join(f'[{ms_to_timecode(l["ts"])}|{l["ts"]}ms] {l.get("speaker") or "?"}: {l["text"]}' for l in lines)
    mandate = f'Your analytical mandate: {standing_instructions}\n\n' if standing_instructions else ''
    custom_line = f"\nThe operator's brief for this analysis: {custom_instruction}\n" if custom_instruction else ''
    lang_directive = (f'OUTPUT LANGUAGE: {lang}. Write every free-text field entirely in {lang} no matter what language the transcript '
                      'is in — translate quotes instead of copying them. Speaker names, verdict words and fallacy names stay as given.')
    tasks = '\n'.join(f'{i + 1}. {EXAMINE_TEXT[e]}' for i, e in enumerate(examine))
    prompt = f'''{lang_directive}

{mandate}The following is a timestamped, speaker-labelled transcript of a debate, interview or panel. Each line is [HH:MM:SS|Nms] SPEAKER: text, where N is the exact millisecond offset.{custom_line}
Examine it for:
{tasks}

Rules:
- Every "timestampMs" is copied exactly from the Nms value of the line where the item happens (for an exchange: where the question is asked).
- "tEndMs" of an exchange is the Nms of the last line of the answer.
- "speaker", "asker" and "answerer" are speaker names exactly as they appear in the transcript.
- Claim "verdict" is exactly one of FALSE, TRUE, MISLEADING, PARTLY TRUE, UNPROVEN; "severity" is HIGH, MEDIUM or LOW.
- Leave out any list you were not asked for (return it empty).
- Return at most {max_claims} claims: the ones that matter to the argument — contested, consequential or false. Skip routine, uncontested statements.

Respond ONLY with valid JSON (no markdown fences, no commentary):
{{
  "exchanges": [{{"timestampMs": <int>, "tEndMs": <int>, "asker": "", "answerer": "", "question": "the question, in {lang}", "answerSummary": "what they actually said, in {lang}", "verdict": "ANSWERED|PARTIAL|DODGED", "why": "one sentence, in {lang}"}}],
  "moderation": {{"verdict": "FAIR|UNEVEN|ABSENT", "summary": "two sentences, in {lang}", "points": ["..."]}},
  "claims": [{{"timestampMs": <int>, "durationMs": <int>, "speaker": "", "claim": "", "verdict": "", "severity": "", "explanation": "2-4 sentences", "sources": [{{"label": "", "note": ""}}]}}],
  "fallacies": [{{"timestampMs": <int>, "durationMs": <int>, "speaker": "", "name": "", "passage": "", "explanation": "1-2 sentences"}}],
  "contradictions": [{{"timestampMs": <int of the later statement>, "earlierMs": <int>, "speaker": "", "earlier": "", "later": "", "explanation": ""}}]
}}

TRANSCRIPT:
{transcript_lines}

REMINDER — every free-text field must be written in {lang}.'''

    client = gemini_client()
    # A long debate makes a long reply, and now and then one comes back with a broken comma. Asking
    # again is cheap next to the transcription; it is not a permanent failure, so the job may retry.
    parsed, last = None, None
    for _ in range(3):
        r = client.models.generate_content(model=DEFAULT_MODEL, contents=prompt,
                                           config={'temperature': temperature, 'system_instruction': lang_directive,
                                                   'response_mime_type': 'application/json'})
        try:
            parsed = json.loads(_strip(r.text))
            break
        except ValueError as e:
            last = e
    if parsed is None:
        raise RuntimeError(f'Gemini returned invalid JSON three times: {last}')
    num = lambda v: isinstance(v, (int, float))
    return {
        'exchanges': [x for x in parsed.get('exchanges') or [] if num(x.get('timestampMs'))] if 'answers' in examine else [],
        'moderation': parsed.get('moderation') if 'moderation' in examine and isinstance(parsed.get('moderation'), dict) else None,
        'claims': [c for c in parsed.get('claims') or [] if num(c.get('timestampMs'))] if 'claims' in examine else [],
        'fallacies': [f for f in parsed.get('fallacies') or [] if num(f.get('timestampMs'))] if 'fallacies' in examine else [],
        'contradictions': [c for c in parsed.get('contradictions') or [] if num(c.get('timestampMs'))] if 'contradictions' in examine else [],
        'language': lang, 'model': DEFAULT_MODEL,
    }


def build_debate_cards(res, lines, examine=()):
    """Exchanges in time order, each followed by the claims, fallacies and contradictions inside it; the
    moderation card and the per-speaker scorecard close the book."""
    raw = []
    for x in res['exchanges']:
        dur = max(1000, (x.get('tEndMs') or x['timestampMs'] + 8000) - x['timestampMs'])
        raw.append(('qa', x['timestampMs'] / 1000, dur / 1000, 0, {
            'title': str(x.get('question', '')), 'body': str(x.get('answerSummary', '')), 'verdict': str(x.get('verdict', 'PARTIAL')).upper(),
            'passage': str(x.get('why', '')), 'speaker': str(x.get('answerer', '')), 'asker': str(x.get('asker', '')), 'sources': []}))
    for c in res['claims']:
        raw.append(('claim', c['timestampMs'] / 1000, (c.get('durationMs') or 5000) / 1000, 1, {
            'title': str(c.get('claim', '')), 'body': str(c.get('explanation', '')), 'verdict': str(c.get('verdict', 'UNPROVEN')).upper(),
            'severity': str(c.get('severity', 'MEDIUM')).upper(), 'passage': '', 'speaker': str(c.get('speaker', '')),
            'sources': c.get('sources') if isinstance(c.get('sources'), list) else []}))
    for f in res['fallacies']:
        raw.append(('fallacy', f['timestampMs'] / 1000, (f.get('durationMs') or 5000) / 1000, 2, {
            'title': str(f.get('name', '')), 'body': str(f.get('explanation', '')), 'verdict': '', 'severity': '',
            'passage': str(f.get('passage', '')), 'speaker': str(f.get('speaker', '')), 'sources': []}))
    for c in res['contradictions']:
        raw.append(('contradiction', c['timestampMs'] / 1000, 6, 3, {
            'title': str(c.get('later', '')), 'body': str(c.get('explanation', '')), 'verdict': '',
            'passage': str(c.get('earlier', '')), 'speaker': str(c.get('speaker', '')), 'sources': [],
            'earlierT': round((c.get('earlierMs') or 0) / 1000, 2)}))
    raw.sort(key=lambda r: (r[1], r[3]))
    pages = []
    for i, (kind, t, d, _, card) in enumerate(raw):
        start = _snap_start(t, lines)
        end = _snap_end(t + d, lines)
        if kind != 'qa':
            nxt = next((_snap_start(r[1], lines) for r in raw[i + 1:] if _snap_start(r[1], lines) > start), None)
            if nxt is not None:
                end = min(end, nxt)
        pages.append({'id': 'c-' + uuid.uuid4().hex[:10], 'kind': kind,
                      'card': {**card, 't': round(start, 2), 'tEnd': round(max(end, start + 1), 2)}})
    m = res.get('moderation')
    if m:
        pages.append({'id': 'c-' + uuid.uuid4().hex[:10], 'kind': 'moderation', 'card': {
            'title': str(m.get('summary', '')), 'body': '', 'verdict': str(m.get('verdict', 'UNEVEN')).upper(),
            'points': [str(p) for p in m.get('points') or []][:6], 'sources': []}})
    rows = scorecard_rows(pages)
    if rows and ('tally' in examine or len(rows) > 1):
        pages.append({'id': 'c-' + uuid.uuid4().hex[:10], 'kind': 'scorecard',
                      'card': {'title': 'Scorecard', 'body': '', 'rows': rows, 'sources': []}})
    return pages


SCORE_KEYS = ('FALSE', 'MISLEADING', 'PARTLY TRUE', 'TRUE', 'UNPROVEN', 'FALLACY', 'ANSWERED', 'PARTIAL', 'DODGED', 'CONTRADICTION')


def scorecard_rows(pages):
    rows = {}
    for p in pages:
        c, k = p.get('card') or {}, p['kind']
        who = c.get('speaker')
        if not who or k not in ('claim', 'fallacy', 'qa', 'contradiction'):
            continue
        r = rows.setdefault(who, {'speaker': who, **{key: 0 for key in SCORE_KEYS}})
        key = c.get('verdict') if k in ('claim', 'qa') else k.upper()
        if key in r:
            r[key] += 1
    return list(rows.values())


# ── cards ─────────────────────────────────────────────────────────────────────

def _snap_start(t, lines):
    best = lines[0]['t'] if lines else t
    for l in lines:
        if l['t'] <= t + 0.01:
            best = l['t']
        else:
            break
    return best


def _snap_end(t, lines):
    for l in lines:
        if l['t'] + l['d'] >= t - 0.01:
            return l['t'] + l['d']
    return t


def build_cards(analysis, lines):
    raw = []
    for c in analysis['claims']:
        raw.append(('claim', c['timestampMs'] / 1000, c['durationMs'] / 1000, {
            'title': c['claim'], 'body': c['explanation'], 'verdict': c['verdict'].upper(), 'severity': c['severity'].upper(),
            'passage': '', 'sources': c['sources']}))
    for f in analysis['fallacies']:
        raw.append(('fallacy', f['timestampMs'] / 1000, f['durationMs'] / 1000, {
            'title': f['name'], 'body': f['explanation'], 'verdict': '', 'severity': '', 'passage': f['passage'], 'sources': []}))
    # A claim, then the fallacy it rests on, then the next claim — the order the argument is made in.
    raw.sort(key=lambda r: (r[1], r[0] == 'fallacy'))
    pages = []
    for i, (kind, t, d, card) in enumerate(raw):
        start = _snap_start(t, lines)
        end = _snap_end(t + d, lines)
        nxt = next((_snap_start(r[1], lines) for r in raw[i + 1:] if _snap_start(r[1], lines) > start), None)
        if nxt is not None:
            end = min(end, nxt)
        pages.append({'id': 'c-' + uuid.uuid4().hex[:10], 'kind': kind,
                      'card': {**card, 't': round(start, 2), 'tEnd': round(max(end, start + 1), 2)}})
    return pages


def lang_for(job_language, lang_code):
    if job_language:
        return job_language
    return CODE_LANGS.get(lang_code, 'English')
