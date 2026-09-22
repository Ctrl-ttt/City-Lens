import json

import pytest
from backend.models import AnalyzeInput, VisionResult
from backend.rules import summarize
from backend.vision import parse_result, VisionError


def event(label, category='obstacle', direction='front'):
    return dict(category=category, label=label, direction=direction, text='模型任意说明')


def sign(text='中山路', clarity='high', direction='front'):
    return dict(category='text', label='sign', direction=direction, text=text, clarity=clarity)


def summary(events, mode='walk', uncertain=False):
    return summarize(AnalyzeInput(mode=mode, source='video', session_id='s', frame_id=3),
                     VisionResult.model_validate({'events': events, 'uncertain': uncertain}))


def test_priority_dedup_limit_keeps_obstacles_before_signs():
    response = summary([sign(), event('bus_stop', 'facility'), event('bicycle'),
                        event('stairs'), event('stairs'), event('barrier')])
    assert [e.label for e in response.events] == ['stairs', 'bicycle', 'barrier']
    assert response.speech.text == '前方发现楼梯'
    assert response.speech.priority == 'high'


def test_walk_automatically_reads_signs_before_facilities():
    response = summary([event('entrance', 'facility'), sign()])
    assert [e.label for e in response.events] == ['sign', 'entrance']
    assert response.speech.model_dump() == {
        'key': 'sign:中山路', 'text': '标牌文字：中山路', 'priority': 'normal'}


@pytest.mark.parametrize('mode', ['walk', 'read'])
def test_signs_are_sorted_by_clarity_not_input_order_or_direction(mode):
    response = summary([sign('可读路', 'medium', 'front'),
                        sign('清晰路', 'high', 'right'), sign('模糊路', 'low')], mode)
    assert [e.text for e in response.events] == (['清晰路'] if mode == 'read' else ['清晰路', '可读路'])
    assert response.speech.key == 'sign:清晰路'


def test_equal_clarity_order_is_stable_and_walk_limit_is_three():
    response = summary([sign(name) for name in ['甲路', '乙路', '丙路', '丁路']])
    assert [e.text for e in response.events] == ['甲路', '乙路', '丙路']


def test_sign_dedup_ignores_direction_and_clarity_and_normalizes_whitespace():
    response = summary([sign('  中山路\n 12号 ', 'medium', 'left'),
                        sign('中山路 12号', 'high', 'right'), sign('中山路 12号', 'high')])
    assert len(response.events) == 1
    assert response.events[0].direction == 'right'
    assert response.events[0].clarity == 'high'
    assert response.speech.key == 'sign:中山路 12号'
    assert summary([sign('中山路 12号', 'medium', 'unknown')]).speech.key == response.speech.key


def test_obstacle_dedup_still_distinguishes_direction():
    response = summary([event('bicycle', direction='left'), event('bicycle', direction='right')])
    assert [e.direction for e in response.events] == ['left', 'right']


def test_unclear_sign_does_not_hide_visible_obstacle():
    response = summary([sign('不可信路名', 'low'), event('stairs')])
    assert response.status == 'ok'
    assert [e.label for e in response.events] == ['stairs']
    assert response.speech.text == '前方发现楼梯'


@pytest.mark.parametrize('mode', ['walk', 'read'])
def test_unclear_sign_is_never_displayed_or_read(mode):
    response = summary([sign('不可信路名', 'low')], mode)
    assert response.events == []
    assert response.status == ('uncertain' if mode == 'read' else 'ok')
    assert (response.speech.text if response.speech else None) == (
        '文字看不清，请调整拍摄角度' if mode == 'read' else None)


@pytest.mark.parametrize('mode', ['walk', 'read'])
def test_uncertain_frame_never_reports_sign_text(mode):
    response = summary([sign()], mode, uncertain=True)
    assert response.status == 'uncertain'
    assert response.events == []
    assert (response.speech.key if response.speech else None) == (None if mode == 'walk' else 'unclear')


def test_read_excludes_obstacles_and_facilities_and_returns_one_clearest_sign():
    response = summary([event('stairs'), event('entrance', 'facility'),
                        sign('可读路', 'medium'), sign('清晰路'), sign('另一条路')], 'read')
    assert [e.text for e in response.events] == ['清晰路']
    assert response.speech.priority == 'normal'


@pytest.mark.parametrize('clarity', [None, '', 'unknown', 1, True, [], {}])
def test_invalid_sign_clarity_is_rejected(clarity):
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(json.dumps({'events': [sign(clarity=clarity)]}))


def test_missing_sign_clarity_is_rejected():
    observation = sign()
    del observation['clarity']
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(json.dumps({'events': [observation]}))


@pytest.mark.parametrize('text', ['', ' \n\t ', '字' * 81])
def test_empty_or_oversized_sign_is_rejected(text):
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(json.dumps({'events': [sign(text)]}))


@pytest.mark.parametrize('extra', [{'clarity': 'high'}, {'distance': 2}, {'confidence': 0.99}])
def test_obstacles_cannot_supply_clarity_distance_or_confidence(extra):
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(json.dumps({'events': [{**event('stairs'), **extra}]}))


@pytest.mark.parametrize('raw', ['```', '```json```', 'null', '[]', '{"events":[],"advice":"go"}', '{"events":[{"category":"facility","label":"bicycle","direction":"front"}]}'])
def test_malformed_outputs_rejected(raw):
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(raw)


def test_fenced_json_accepted():
    assert parse_result('```json\n{"events":[]}\n```').events == []
