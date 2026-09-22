import time

from .models import AnalyzeInput, AnalyzeResponse, Speech, VisionResult

DIRECTION = {'left': '左前方', 'front': '前方', 'right': '右前方', 'unknown': '画面中'}
# 危险优先：P0 绊倒(step/stairs) → P1 碰撞(bicycle/barrier/bollard/obstacle)
# → P2 通行设施(crosswalk/escalator/elevator/entrance/bus_stop) → P3 信息标牌(sign)。
ORDER = {'step': 0, 'stairs': 0, 'bicycle': 1, 'barrier': 1, 'bollard': 1, 'obstacle': 1,
         'crosswalk': 2, 'escalator': 2, 'elevator': 2, 'entrance': 2, 'bus_stop': 2, 'sign': 3}
DIRECTION_ORDER = {'front': 0, 'left': 1, 'right': 2, 'unknown': 3}
CLARITY_ORDER = {'high': 0, 'medium': 1}


def _rank(event):
    tier = ORDER.get(event.label, 3)
    if event.category == 'text':
        return (tier, CLARITY_ORDER.get(event.clarity, 0))
    return (tier, DIRECTION_ORDER.get(event.direction, 3))


def _dedupe_speech(speech, recent, now, repeat_seconds):
    if speech is None or recent is None or repeat_seconds <= 0:
        return speech
    moment = time.monotonic() if now is None else now
    for key, spoken_at in list(recent.items()):
        if spoken_at <= moment - repeat_seconds:
            del recent[key]
    if speech.key in recent:
        return None
    recent[speech.key] = moment
    return speech


def summarize(meta: AnalyzeInput, result: VisionResult, recent: dict | None = None,
              now: float | None = None, repeat_seconds: float = 0.0) -> AnalyzeResponse:
    response = AnalyzeResponse(session_id=meta.session_id, frame_id=meta.frame_id, status='ok')
    speech = None
    if result.uncertain:
        response.status = 'uncertain'
        if meta.mode == 'read':
            speech = Speech(key='unclear', priority='normal', text='文字看不清，请调整拍摄角度')
    else:
        events = [e for e in result.events
                  if (meta.mode == 'walk' or e.category == 'text')
                  and (e.category != 'text' or e.clarity in CLARITY_ORDER)]
        events.sort(key=_rank)
        seen = set()
        for event in events:
            key = (event.label, event.text) if event.category == 'text' else (event.label, event.direction)
            if key not in seen:
                seen.add(key)
                response.events.append(event)
        response.events = response.events[:1 if meta.mode == 'read' else 3]
        if not response.events:
            if meta.mode == 'read':
                response.status = 'uncertain'
                speech = Speech(key='unclear', priority='normal', text='文字看不清，请调整拍摄角度')
        else:
            top = response.events[0]
            if top.category == 'text':
                speech = Speech(key=f'sign:{top.text}', priority='normal', text=f'标牌文字：{top.text}')
            else:
                speech = Speech(
                    key=f'{top.label}:{top.direction}',
                    priority='high' if top.category == 'obstacle' else 'low',
                    text=f'{DIRECTION[top.direction]}发现{top.text}',
                )
    response.speech = _dedupe_speech(speech, recent, now, repeat_seconds)
    return response
