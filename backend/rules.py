import time

from .models import AnalyzeInput, AnalyzeResponse, SpatialObservation, Speech, VisionResult

DIRECTION = {'left': '左侧', 'front': '前方', 'right': '右侧', 'back': '后方', 'above': '上方', 'unknown': '画面中'}
CLARITY_ORDER = {'high': 0, 'medium': 1}
RISK = {'step': 70, 'stairs': 70, 'overhead': 50, 'car': 65, 'motorcycle': 65,
        'bicycle': 60, 'barrier': 60, 'bollard': 60, 'obstacle': 60, 'person': 50}
POSITION = {'front': 22, 'above': 12, 'left': 6, 'right': 6, 'back': -12, 'unknown': 0}
PROXIMITY = {'near': 32, 'mid': 10, 'far': -35, 'unknown': 0}


def score(event):
    if event.label == 'canopy':
        return 5  # Background roofs stay in details; they must not fill idle speech slots.
    if event.category == 'text':
        return 10 - CLARITY_ORDER.get(event.clarity, 2)
    if event.approaching and event.direction == 'back' and event.proximity == 'near':
        return 160
    return RISK.get(event.label, 25) + POSITION[event.direction] + PROXIMITY[event.proximity]


def event_key(event):
    if event.category == 'text':
        return f'sign:{event.text}'
    suffix = ':approaching' if event.approaching else ':near' if event.proximity == 'near' else ''
    return f'{event.label}:{event.direction}{suffix}'


def phrase(event, mode='walk'):
    if event.category == 'text':
        return f'标牌文字：{event.text[:80 if mode == "read" else 32]}'
    if event.approaching:
        return f'后方{event.text}疑似靠近，请注意'
    return f'{DIRECTION[event.direction]}发现{event.text}'


def summarize(meta: AnalyzeInput, result: VisionResult, recent: dict | None = None,
              now: float | None = None, repeat_seconds: float = 0.0,
              spatial: list[SpatialObservation] | None = None) -> AnalyzeResponse:
    response = AnalyzeResponse(session_id=meta.session_id, frame_id=meta.frame_id, status='ok')
    moment = time.monotonic() if now is None else now
    memory = recent if recent is not None else {}
    for key, spoken_at in list(memory.items()):
        if spoken_at <= moment - repeat_seconds:
            del memory[key]
    observations = spatial if spatial is not None else [SpatialObservation(**e.model_dump()) for e in result.events]
    events = [] if result.uncertain else [e for e in observations
        if (meta.mode == 'walk' or e.category == 'text')
        and (e.category != 'text' or e.clarity in CLARITY_ORDER)]
    events.sort(key=lambda e: -score(e))
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
            memory['unclear'] = moment
        return response
    # Filter repetitions BEFORE selection so other visible targets get a turn.
    eligible = [e for e in unique if repeat_seconds <= 0 or event_key(e) not in memory]
    # Distant background objects remain visible in details, but do not consume speech.
    if meta.mode == 'walk':
        eligible = [e for e in eligible if score(e) >= 15 or e.category == 'text']
    selected = eligible[:1]
    if meta.mode == 'walk' and selected and selected[0].category == 'obstacle':
        others = [e for e in eligible[1:] if e.category == 'obstacle' and score(e) >= 45
                  and phrase(e) != phrase(selected[0])]
        if others:
            # A comparable side/overhead hazard takes the second slot before another front object.
            diverse = [e for e in others if e.direction != selected[0].direction
                       and score(e) >= score(others[0])-20]
            selected.append((diverse or others)[0])
    if selected:
        keys = [event_key(e) for e in selected]
        response.speech = Speech(key='|'.join(keys),
            priority='urgent' if any(e.approaching for e in selected) else 'high' if any(e.category == 'obstacle' for e in selected) else 'normal' if selected[0].category == 'text' else 'low',
            text='；'.join(phrase(e, meta.mode) for e in selected))
        for key in keys:
            memory[key] = moment
        # Two people at the same bearing may have different coarse ranges but the
        # same spoken wording. Cover both without consuming two speech slots.
        selected_phrases = {phrase(e, meta.mode) for e in selected}
        for event in eligible:
            if phrase(event, meta.mode) in selected_phrases:
                memory[event_key(event)] = moment
    return response
