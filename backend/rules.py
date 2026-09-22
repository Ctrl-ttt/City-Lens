import re
import time

from .models import AnalyzeInput, AnalyzeResponse, SpatialObservation, Speech, VisionResult

DIRECTION = {'left': '左侧', 'front': '前方', 'right': '右侧', 'back': '后方', 'above': '上方', 'unknown': '画面中'}
CLARITY_ORDER = {'high': 0, 'medium': 1}
RISK = {'step': 70, 'stairs': 70, 'overhead': 50, 'car': 65, 'motorcycle': 65,
        'bicycle': 60, 'barrier': 60, 'bollard': 60, 'obstacle': 60, 'person': 50}
POSITION = {'front': 22, 'above': 12, 'left': 6, 'right': 6, 'back': -12, 'unknown': 0}
PROXIMITY = {'near': 32, 'mid': 10, 'far': -35, 'unknown': 0}
# Objects that stretch across many seconds of travel (stairs, escalators, crossings)
# re-announce on a wider window than point hazards like bollards.
CONTINUOUS_LABELS = {'stairs', 'step', 'escalator', 'crosswalk', 'entrance', 'elevator'}
# Labels this risky still speak below the confidence floor, as hazy "疑似" wording.
HIGH_RISK = 60
# Arrows, geometric shapes and misc symbols the model sometimes transcribes as text.
NOISE_SYMBOLS = re.compile('[\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\u2600-\u27bf\ufe0f]')


def audit_sign_text(text: str) -> str:
    """Rule-based second pass over transcribed sign text; no extra model call."""
    stripped = NOISE_SYMBOLS.sub(' ', text)
    segments = [part for part in stripped.split() if any(c.isalnum() for c in part)]
    joined = ' '.join(segments)
    compact = joined.replace(' ', '')
    # Repeated-glyph noise like "的的的" or "1111" carries no navigable meaning.
    if len(compact) >= 3 and len(re.sub(r'(.)\1+', r'\1', compact)) <= 2:
        return ''
    return joined


def score(event, min_confidence: float = 0.0):
    if event.label == 'canopy':
        return 5  # Background roofs stay in details; they must not fill idle speech slots.
    if event.category == 'text':
        return 10 - CLARITY_ORDER.get(event.clarity, 2)
    if event.approaching and event.proximity == 'near':
        return 160
    base = RISK.get(event.label, 25) + POSITION[event.direction] + PROXIMITY[event.proximity]
    if min_confidence > 0 and event.confidence is not None and event.confidence < min_confidence:
        base -= 20  # Hazy detections still rank, but below crisp ones of the same kind.
    return base


def event_key(event):
    if event.category == 'text':
        return f'sign:{event.text}'
    suffix = ':approaching' if event.approaching else ':near' if event.proximity == 'near' else ''
    return f'{event.label}:{event.direction}{suffix}'


def phrase(event, mode='walk', hazy=False):
    if event.category == 'text':
        return f'标牌文字：{event.text[:80 if mode == "read" else 32]}'
    if event.approaching:
        return f'后方{event.text}疑似靠近，请注意'
    if hazy:
        return f'{DIRECTION[event.direction]}疑似有{event.text}，请留意'
    return f'{DIRECTION[event.direction]}发现{event.text}'


def summarize(meta: AnalyzeInput, result: VisionResult, recent: dict | None = None,
              now: float | None = None, repeat_seconds: float = 0.0,
              spatial: list[SpatialObservation] | None = None,
              min_confidence: float = 0.0,
              continuous_repeat_seconds: float = 0.0) -> AnalyzeResponse:
    response = AnalyzeResponse(session_id=meta.session_id, frame_id=meta.frame_id, status='ok')
    moment = time.monotonic() if now is None else now
    memory = recent if recent is not None else {}
    for key, entry in list(memory.items()):
        # Entries record (spoken_at, window): continuous objects widen their own expiry.
        spoken_at, window = entry if isinstance(entry, tuple) else (entry, repeat_seconds)
        if spoken_at <= moment - window:
            del memory[key]

    def ranked(event):
        return score(event, min_confidence)

    def hazy(event):
        return min_confidence > 0 and event.confidence is not None and event.confidence < min_confidence

    def window_for(event):
        if event.label in CONTINUOUS_LABELS:
            return max(repeat_seconds, continuous_repeat_seconds)
        return repeat_seconds

    observations = spatial if spatial is not None else [SpatialObservation(**e.model_dump()) for e in result.events]
    events = []
    if not result.uncertain:
        for e in observations:
            # Walk never transcribes; read only transcribes.
            if (meta.mode == 'walk') == (e.category == 'text'):
                continue
            if e.category == 'text':
                if e.clarity not in CLARITY_ORDER:
                    continue
                e.text = audit_sign_text(e.text)
                if not e.text:
                    continue
            events.append(e)
    events.sort(key=lambda e: -ranked(e))
    seen = set()
    unique = []
    for event in events:
        key = event_key(event)
        if key not in seen:
            seen.add(key)
            unique.append(event)
    response.events = unique[:1 if meta.mode == 'read' else 6]
    if result.uncertain or (meta.mode == 'read' and not unique):
        response.status = 'uncertain'
        if meta.mode == 'read' and ('unclear' not in memory or repeat_seconds <= 0):
            response.speech = Speech(key='unclear', priority='normal', text='文字看不清，请调整拍摄角度')
            memory['unclear'] = (moment, repeat_seconds)
        return response
    # Filter repetitions BEFORE selection so other visible targets get a turn.
    eligible = [e for e in unique if window_for(e) <= 0 or event_key(e) not in memory]
    if meta.mode == 'walk':
        eligible = [e for e in eligible if ranked(e) >= 15 or e.category == 'text']
        # Apparent-size estimates beyond the mid band stay in details but out of speech.
        eligible = [e for e in eligible if e.category != 'obstacle' or e.proximity != 'far']
        # Below the confidence floor only serious hazards still speak, as hazy wording.
        eligible = [e for e in eligible if e.category != 'obstacle'
                    or not hazy(e) or RISK.get(e.label, 0) >= HIGH_RISK]
    selected = eligible[:1]
    if meta.mode == 'walk' and selected and selected[0].category == 'obstacle':
        others = [e for e in eligible[1:] if e.category == 'obstacle' and ranked(e) >= 45
                  and phrase(e, meta.mode) != phrase(selected[0], meta.mode, hazy(selected[0]))]
        if others:
            # A comparable side/overhead hazard takes the second slot before another front object.
            diverse = [e for e in others if e.direction != selected[0].direction
                       and ranked(e) >= ranked(others[0])-20]
            selected.append((diverse or others)[0])
    if selected:
        keys = [event_key(e) for e in selected]
        response.speech = Speech(key='|'.join(keys),
            priority='urgent' if any(e.approaching for e in selected) else 'high' if any(e.category == 'obstacle' for e in selected) else 'normal' if selected[0].category == 'text' else 'low',
            text='；'.join(phrase(e, meta.mode, hazy(e)) for e in selected))
        for key, e in zip(keys, selected):
            memory[key] = (moment, window_for(e))
        # Two people at the same bearing may have different coarse ranges but the
        # same spoken wording. Cover both without consuming two speech slots.
        selected_phrases = {phrase(e, meta.mode, hazy(e)) for e in selected}
        for event in eligible:
            if phrase(event, meta.mode, hazy(event)) in selected_phrases:
                memory[event_key(event)] = (moment, window_for(event))
    return response
