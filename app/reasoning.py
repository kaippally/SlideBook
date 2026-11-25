"""Claude does the thinking: analysis and questions, always from a video's text record (never the video).

It runs through the Claude Code CLI in print mode (`claude -p`) on the operator's own subscription login,
so there is no API key here; `CLAUDE_CLI_PATH` overrides where the CLI is found. Gemini stays the ears
(transcription); everything that reasons about what was said comes through this module."""
import json, logging, os, subprocess
from pathlib import Path

import db
from paths import DATA

log = logging.getLogger('slidebook.reasoning')

ANALYSE_MODEL = 'opus'
ASK_MODEL = 'sonnet'

DEFAULT_HOUSE_RULES = '''You analyse recorded talks, debates and interviews for an atheist, rationalist, non-religious channel. You write from that perspective, and the aim is always to defeat the theist case: expose every weak argument, unsupported claim, dodge and contradiction on the religious side, and make the rationalist case land as hard as the evidence allows.

Perspective
- You are on the rationalist side, not a neutral referee. Every section should leave the reader seeing why the theist position fails.
- Stay accurate: never invent a quote, a fact or a timestamp, and never misstate what someone said. A false point is a weakness the other side can use.
- When the rationalist speaker slips, says something wrong or misses an opening, say so as "how the rationalist case should have been argued", so the next debate is won.

Standard of evidence
- Assess every claim by publicly checkable evidence. Scripture, tradition, clerical authority, personal revelation and religious experience are claims to be examined, never evidence for the claim being made.
- Prefer the scientific consensus and primary research (peer-reviewed journals, systematic reviews, established reference works) over news, blogs or advocacy sites.
- The burden of proof lies with the person asserting the supernatural claim. Say so when a speaker shifts it.

How to argue
- Name each apologetic or rhetorical move by its standard name where one applies: unfalsifiable reframing, argument from authority, argument from ignorance / god of the gaps, shifting the burden of proof, special pleading, equivocation, quote-mining, appeal to consequences, moving the goalposts.
- Steelman the theist point in one line, then take it apart: a rebuttal of the strongest version is the one that wins.
- Distinguish what is false from what is unproven or unfalsifiable — "unfalsifiable" is itself a defeat for a claim presented as knowledge.
- If a theist point is factually correct, concede only that fact, then show why it does not get them to God.

Style
- Short, concrete, quotable sentences that would land on a card read in a few seconds.
- No sneering or insults toward people; the target is the argument.
- Cite the moment: refer to the timestamp and speaker of every point you make.'''


def house_rules():
    return db.get_setting('houseRules') or DEFAULT_HOUSE_RULES


class ClaudeError(Exception):
    pass


def cli_path():
    if os.environ.get('CLAUDE_CLI_PATH'):
        return os.environ['CLAUDE_CLI_PATH']
    exts = Path.home() / '.vscode' / 'extensions'
    found = sorted(exts.glob('anthropic.claude-code-*/resources/native-binary/claude.exe'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not found:
        raise ClaudeError('Claude Code is not installed (no claude.exe under the VS Code extensions). Set CLAUDE_CLI_PATH.')
    return str(found[0])


def run(system, prompt, model, schema=None, effort=None, timeout=900):
    """One headless Claude turn: no tools, no project settings, no saved session. Returns
    {text, data, usage, cost, model}; `data` is the parsed structured output when a schema is given."""
    work = DATA / 'claude'
    work.mkdir(parents=True, exist_ok=True)
    sys_file = work / 'system.txt'
    sys_file.write_text(system, encoding='utf-8')
    args = [cli_path(), '-p', '--output-format', 'json', '--model', model, '--tools', '', '--setting-sources', '',
            '--no-session-persistence', '--system-prompt-file', str(sys_file)]
    if schema:
        args += ['--json-schema', json.dumps(schema)]
    if effort:
        args += ['--effort', effort]
    # The subscription login, never a key that would bill per token instead.
    env = {k: v for k, v in os.environ.items() if k not in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')}
    try:
        p = subprocess.run(args, input=prompt, capture_output=True, text=True, encoding='utf-8', cwd=work, env=env,
                           timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except subprocess.TimeoutExpired:
        raise ClaudeError(f'Claude did not answer within {timeout // 60} minutes.')
    try:
        out = json.loads(p.stdout)
    except ValueError:
        raise ClaudeError(f'Claude CLI failed: {(p.stderr or p.stdout or "no output").strip()[:400]}')
    if out.get('is_error'):
        raise ClaudeError(f'Claude: {str(out.get("result") or out.get("subtype"))[:400]}')
    data = out.get('structured_output')
    if schema and not isinstance(data, dict):
        raise ClaudeError('Claude returned no structured answer.')
    usage = out.get('usage') or {}
    return {'text': out.get('result') or '', 'data': data, 'cost': out.get('total_cost_usd') or 0,
            'model': ','.join((out.get('modelUsage') or {}).keys()) or model,
            'usage': {k: usage.get(k, 0) for k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')}}


# ── the record as text ────────────────────────────────────────────────────────

def hms(t):
    t = int(t)
    return f'{t // 3600:02d}:{t // 60 % 60:02d}:{t % 60:02d}'


def speaker_name(rec, label):
    return (rec.get('names') or {}).get(label) or label


def record_text(rec):
    """`[HH:MM:SS] Name: text`, the name written only where the speaker changes (a blank line between
    turns) — the compact form every prompt carries."""
    out, last = [], None
    for l in rec['lines']:
        who = speaker_name(rec, l.get('speaker')) if l.get('speaker') else ''
        if who and who != last:
            out.append(f'\n[{hms(l["t"])}] {who}: {l["text"]}')
            last = who
        else:
            out.append(f'[{hms(l["t"])}] {l["text"]}')
    return '\n'.join(out).strip()


def _header(rec):
    names = rec.get('names') or {}
    who = ', '.join(f'{k} = {v}' for k, v in names.items()) if names else ', '.join(rec.get('speakers') or []) or 'not labelled'
    mins = int(rec.get('duration') or 0) // 60
    return f'VIDEO: {rec["title"] or rec["url"]}\nLINK: {rec["url"]}\nLENGTH: {mins} min\nSPEAKERS: {who}\nRECORD v{rec["version"]} — each line is [HH:MM:SS] text, timed from the start of the original video. A turn starts with [HH:MM:SS] SPEAKER: and the lines after it are the same speaker until the next name.'


# ── analysis ──────────────────────────────────────────────────────────────────

EXAMINE_TEXT = {
    'claims': 'CLAIMS — every factual, scientific, historical or medical claim that matters to the argument (contested, consequential or false), with verdict, severity, explanation and evidence, attributed to its speaker.',
    'fallacies': 'FALLACIES — every logical fallacy, apologetic move or cognitive bias, named precisely, with the passage, attributed to its speaker.',
    'answers': 'EXCHANGES — every real question one participant (or the moderator) puts to another, and whether it was answered: ANSWERED, PARTIAL (touched but core left unanswered) or DODGED (changed subject, attacked the asker, filibustered, answered a different question). One sentence on why. Skip rhetorical questions and pleasantries.',
    'moderation': 'MODERATION — was it FAIR, UNEVEN or ABSENT, with concrete points: one-sided interruptions, unequal time, missed or one-sided follow-ups, leading questions.',
    'tally': 'TALLY — attribute every claim and fallacy to its speaker so they can be counted (no extra output).',
    'contradictions': 'CONTRADICTIONS — places where a speaker contradicts what they said earlier in the same recording.',
}

_T = {'type': 'string', 'description': 'HH:MM:SS, copied from the record line'}
_S = {'type': 'string'}
ANALYSIS_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['speakers', 'claims', 'fallacies', 'exchanges', 'contradictions', 'moderation'],
    'properties': {
        'speakers': {'type': 'array', 'description': 'Each transcript label that is consistently ONE real person, with that name',
                     'items': {'type': 'object', 'additionalProperties': False, 'required': ['label', 'name'],
                               'properties': {'label': _S, 'name': _S}}},
        'claims': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                   'required': ['t', 'speaker', 'claim', 'verdict', 'severity', 'explanation', 'sources'],
                   'properties': {'t': _T, 'tEnd': _T, 'speaker': _S, 'claim': _S,
                                  'verdict': {'type': 'string', 'enum': ['FALSE', 'TRUE', 'MISLEADING', 'PARTLY TRUE', 'UNPROVEN']},
                                  'severity': {'type': 'string', 'enum': ['HIGH', 'MEDIUM', 'LOW']}, 'explanation': _S,
                                  'sources': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                                              'required': ['label'], 'properties': {'label': _S, 'note': _S}}}}}},
        'fallacies': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                      'required': ['t', 'speaker', 'name', 'passage', 'explanation'],
                      'properties': {'t': _T, 'tEnd': _T, 'speaker': _S, 'name': _S, 'passage': _S, 'explanation': _S}}},
        'exchanges': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                      'required': ['t', 'tEnd', 'asker', 'answerer', 'question', 'answerSummary', 'verdict', 'why'],
                      'properties': {'t': _T, 'tEnd': _T, 'asker': _S, 'answerer': _S, 'question': _S, 'answerSummary': _S,
                                     'verdict': {'type': 'string', 'enum': ['ANSWERED', 'PARTIAL', 'DODGED']}, 'why': _S}}},
        'contradictions': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                           'required': ['t', 'earlierT', 'speaker', 'earlier', 'later', 'explanation'],
                           'properties': {'t': _T, 'earlierT': _T, 'speaker': _S, 'earlier': _S, 'later': _S, 'explanation': _S}}},
        'moderation': {'type': ['object', 'null'], 'additionalProperties': False, 'required': ['verdict', 'summary', 'points'],
                       'properties': {'verdict': {'type': 'string', 'enum': ['FAIR', 'UNEVEN', 'ABSENT']}, 'summary': _S,
                                      'points': {'type': 'array', 'items': _S}}},
    },
}


def _secs(v):
    import analysis
    s = analysis._secs(v)
    return s if s is not None else 0.0


def _ms(v):
    return int(round(_secs(v) * 1000))


def analyse(rec, brief='', language='English', examine=(), base=None, max_claims=25):
    """A full analysis of the record. `base` is an earlier run to refine: its result and the operator's
    feedback (`brief`) go in, and a whole new analysis comes out. Returns the debate-analysis shape the
    card builder already takes, plus `usage`/`cost`/`model`/`raw`."""
    examine = [e for e in examine if e in EXAMINE_TEXT] or ['claims', 'fallacies']
    tasks = '\n'.join(f'- {EXAMINE_TEXT[e]}' for e in examine)
    system = f'''{house_rules()}

OUTPUT LANGUAGE: {language}. Every free-text field is written in {language} whatever language the record is in — translate quotes. Speaker names, verdict words and fallacy names stay as given.

Your task: analyse the whole record below, knowing the context of the entire conversation. Examine it for:
{tasks}

Rules:
- Every "t" is the [HH:MM:SS] of the record line where the item happens (for an exchange: where the question is asked); "tEnd" is the line where it ends.
- WHO SAID IT. The record's speaker labels come from automatic transcription: they can be generic ("Speaker 1"), and they can be WRONG — one label may cover two different people, or one person may move between labels. Work out who is actually speaking from the content: introductions, the moderator naming people, the positions argued, the video title. Write real names (as in the title or as introduced; "Moderator" if unnamed) in every speaker, asker and answerer field, and attribute every claim, fallacy, exchange and contradiction to the person who actually said it — never just to the label. Use exactly the same spelling of a name everywhere.
- "speakers": list each transcript label that is consistently one real person, with that name. Leave out a label that mixes people.
- At most {max_claims} claims — the ones that matter to the argument. Leave any list you were not asked for empty, and "moderation" null unless asked.'''
    parts = [_header(rec), 'RECORD:', record_text(rec)]
    if base:
        parts += [f'YOUR PREVIOUS ANALYSIS (version {base["version"]}):', base['result'],
                  'OPERATOR FEEDBACK — produce a complete new analysis that keeps what was right and fixes this:',
                  brief or '(no specific feedback: improve accuracy and argument strength)']
    elif brief:
        parts += ["OPERATOR'S BRIEF FOR THIS ANALYSIS:", brief]
    r = run(system, '\n\n'.join(parts), ANALYSE_MODEL, schema=ANALYSIS_SCHEMA, effort='high')
    d = r['data']
    res = {
        'claims': [{**c, 'timestampMs': _ms(c['t']), 'durationMs': max(3000, _ms(c.get('tEnd') or c['t']) - _ms(c['t'])) or 5000}
                   for c in d.get('claims') or []] if 'claims' in examine else [],
        'fallacies': [{**f, 'timestampMs': _ms(f['t']), 'durationMs': max(3000, _ms(f.get('tEnd') or f['t']) - _ms(f['t'])) or 5000}
                      for f in d.get('fallacies') or []] if 'fallacies' in examine else [],
        'exchanges': [{**x, 'timestampMs': _ms(x['t']), 'tEndMs': _ms(x.get('tEnd') or x['t'])}
                      for x in d.get('exchanges') or []] if 'answers' in examine else [],
        'contradictions': [{**c, 'timestampMs': _ms(c['t']), 'earlierMs': _ms(c.get('earlierT'))}
                           for c in d.get('contradictions') or []] if 'contradictions' in examine else [],
        'moderation': d.get('moderation') if 'moderation' in examine else None,
        'speakers': d.get('speakers') or [],
    }
    res.update(language=language, model=r['model'], usage=r['usage'], cost=r['cost'], raw=json.dumps(d, ensure_ascii=False))
    return res


# ── reports: what the operator reads on a phone ───────────────────────────────
# Every report request is free text. Claude writes the report from the record and the latest analysis,
# then folds the request into a short list of lasting preferences that shapes every later report.

DEFAULT_REPORT_GUIDANCE = '''- Written to be read on a phone: short paragraphs, one idea each, plain words.
- Open with a 3-5 line summary of who argued what and who came out stronger, and why.
- Group findings by theme (e.g. the main arguments, the dodged questions, the factual errors), strongest points first.
- Every point names the speaker and its timestamp.'''


def report_guidance():
    return db.get_setting('reportGuidance') or DEFAULT_REPORT_GUIDANCE


REPORT_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['title', 'summary', 'sections', 'conclusion'],
    'properties': {
        'title': _S, 'subtitle': _S,
        'summary': {'type': 'array', 'items': _S, 'description': 'a few short lines'},
        'sections': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['heading', 'items'],
            'properties': {'heading': _S, 'intro': _S,
                           'items': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['headline', 'text'],
                               'properties': {'t': _T, 'tEnd': _T, 'speaker': _S,
                                              'tag': {'type': 'string', 'description': 'a one or two word verdict, e.g. FALSE, DODGED, FALLACY, STRONG POINT'},
                                              'headline': _S, 'text': _S,
                                              'frame': {'type': 'boolean', 'description': 'true when a still of the video at "t" adds context (the speaker making the point, a slide or prop shown)'}}}}}}},
        'conclusion': _S,
    },
}


MALAYALAM_RULES = '''LANGUAGE: Malayalam, written the way the speakers in this recording actually talk.
- Match their register. Where they speak formal Malayalam, write formal Malayalam. Where they speak colloquially, write colloquially.
- Where they mix English into Malayalam, keep those English words and phrases in English exactly as they used them, followed by the Malayalam translation in brackets — e.g. "fine-tuning (സൂക്ഷ്മ ക്രമീകരണം)".
- The record writes spoken English words in Malayalam script (e.g. "മോറൽ റെസ്പോൺസിബിലിറ്റി" is the English "moral responsibility"). In the report, write such words in English as spoken, with the Malayalam translation in brackets.
- Quotes keep the speaker's own words and mix. Speaker names, verdict tags and standard fallacy names stay as they are, in English.
- The report's tone and style follow the debate's own style.'''


def language_rules(language):
    if (language or '').lower().startswith('malayalam'):
        return MALAYALAM_RULES
    return f'LANGUAGE: {language or "English"}. Translate quotes into {language or "English"}; keep speaker names as given.'


def write_report(rec, request='', analysis=None, language='English'):
    """A report for reading on a phone. `analysis` is the raw JSON of an earlier analysis run (or None)."""
    system = f'''{house_rules()}

You write a report about one recorded video for the operator to read on a smartphone.

THE OPERATOR'S LASTING PREFERENCES FOR REPORTS (always follow them):
{report_guidance()}

Rules:
- Base every point on the record; use the earlier analysis as a starting point, not as the last word — correct it where the record says otherwise.
- "t" is the [HH:MM:SS] of the record line a point refers to.
- Any time you mention inside the text (summary, intro, item text, conclusion) is written exactly as HH:MM:SS (e.g. 00:57:01, never 57:01 or "57 minutes in") — each one becomes a link to that moment of the video.
- Set "frame": true on at most 6 points where a still from the video at that moment adds context; the frames are taken from the video for you.
- Follow the LANGUAGE rules given at the end for every field. Plain text in every field — no Markdown.'''
    # The record (and analysis) come first and the language last, so the second report of a pair reads
    # the record from the prompt cache instead of paying for it again.
    parts = [_header(rec), 'RECORD:', record_text(rec)]
    if analysis:
        parts += ['EARLIER ANALYSIS (JSON):', analysis]
    parts += ["THE OPERATOR'S REQUEST FOR THIS REPORT:", request or '(none — follow the lasting preferences)', language_rules(language)]
    r = run(system, '\n\n'.join(parts), ANALYSE_MODEL, schema=REPORT_SCHEMA, effort='medium')
    return {'report': r['data'], 'model': r['model'], 'usage': r['usage'], 'cost': r['cost']}


def add_frames(rec, rep, tag):
    """Stills from the video for the points Claude marked, plus a cover, saved under media/frames. Points
    without a video file on disk keep their text only."""
    from paths import MEDIA, tool
    src = MEDIA / rec['video'][len('/media/'):] if rec.get('video', '').startswith('/media/') else None
    if not src or not src.exists():
        return rep
    out = MEDIA / 'frames'
    out.mkdir(parents=True, exist_ok=True)

    def grab(t, name):
        f = out / f'{tag}-{name}.jpg'
        subprocess.run([tool('ffmpeg'), '-y', '-loglevel', 'error', '-ss', str(max(0, t)), '-i', str(src), '-frames:v', '1',
                        '-vf', 'scale=720:-2', '-q:v', '4', str(f)], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return f'/media/frames/{f.name}' if f.exists() and f.stat().st_size else None

    picked = [it for s in rep.get('sections') or [] for it in s.get('items') or [] if it.get('frame') and it.get('t')][:6]
    for n, it in enumerate(picked):
        it['image'] = grab(_secs(it['t']) + 1, str(n))
    if rec.get('duration'):
        rep['cover'] = grab(rec['duration'] * 0.3, 'cover')
    return rep


def learn_guidance(request):
    """Fold one report request into the lasting preferences: keep what is general, drop one-off detail."""
    if not request.strip():
        return report_guidance()
    system = '''You maintain a short list of an operator's lasting preferences for the reports written for him.
Given the current list and his newest request, return the updated list:
- Add what the request reveals about how he generally wants reports (structure, length, emphasis, tone, language, what to leave out).
- Leave out details that only fit this one video (names, topics, timestamps).
- Leave out the report language: it is chosen separately for every report.
- Merge duplicates; where the new request contradicts an older line, the new request wins.
- At most 12 lines, each starting with "- ". Return only the list.'''
    r = run(system, f'CURRENT LIST:\n{report_guidance()}\n\nNEWEST REQUEST:\n{request}', ASK_MODEL, effort='low', timeout=180)
    text = '\n'.join(l for l in r['text'].strip().splitlines() if l.strip().startswith('- ')).strip()
    if text:
        db.set_setting('reportGuidance', text)
    return report_guidance()


# ── questions ─────────────────────────────────────────────────────────────────

def ask(rec, question):
    """A question about the video, answered from the whole record. Every point cites its [HH:MM:SS]."""
    system = f'''{house_rules()}

You answer the operator's question about one recorded video, using only its record below (and general knowledge for evidence). Read the whole conversation for context before answering.
- Cite every point with its timestamp in square brackets, exactly as [HH:MM:SS], and name the speaker.
- When asked how someone answered, quote or closely paraphrase what they actually said, then judge it: did they answer, partly answer, or dodge — and how strong was the answer.
- Answer in the language the question is written in. Be concise: a few short paragraphs at most.
- Plain text only: no Markdown (no asterisks, no # headings). Start a paragraph with a short label and a colon where it helps, e.g. "Verdict: …".'''
    r = run(system, '\n\n'.join([_header(rec), 'RECORD:', record_text(rec), 'QUESTION:', question]), ASK_MODEL, effort='medium', timeout=300)
    return {'answer': r['text'].strip(), 'model': r['model'], 'usage': r['usage'], 'cost': r['cost']}
