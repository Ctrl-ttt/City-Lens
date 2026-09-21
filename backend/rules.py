from .models import AnalyzeInput, AnalyzeResponse, Speech, VisionResult

DIRECTION = {'left': '左前方', 'front': '前方', 'right': '右前方', 'unknown': '画面中'}
ORDER = {'step': 0, 'stairs': 0, 'bicycle': 1, 'barrier': 1, 'bollard': 1, 'obstacle': 1}


def summarize(meta: AnalyzeInput, result: VisionResult) -> AnalyzeResponse:
    response = AnalyzeResponse(session_id=meta.session_id, frame_id=meta.frame_id, status='ok')
    if result.uncertain:
        response.status = 'uncertain'
        if meta.mode == 'read':
            response.speech = Speech(key='unclear', priority='normal', text='文字看不清，请调整拍摄角度')
        return response
    events = [e for e in result.events if (e.category == 'text') == (meta.mode == 'read')]
    events.sort(key=lambda e: ORDER.get(e.label, 2))
    seen = set()
    for event in events:
        key = (event.label, event.direction, event.text if event.category == 'text' else '')
        if key not in seen:
            seen.add(key)
            response.events.append(event)
    response.events = response.events[:3]
    if not response.events:
        if meta.mode == 'read':
            response.status = 'uncertain'
            response.speech = Speech(key='unclear', priority='normal', text='文字看不清，请调整拍摄角度')
        return response
    top = response.events[0]
    if top.category == 'text':
        response.speech = Speech(key=f'sign:{top.text}', priority='normal', text=f'标牌文字：{top.text}')
    else:
        response.speech = Speech(
            key=f'{top.label}:{top.direction}',
            priority='high' if top.category == 'obstacle' else 'low',
            text=f'{DIRECTION[top.direction]}发现{top.text}',
        )
    return response

