import json

import pytest
from backend.models import AnalyzeInput, SpatialObservation, VisionResult
from backend.rules import score, summarize
from backend.spatial import calculate_approach_speed
from backend.vision import parse_result, VisionError


def event(label, category='obstacle', direction='front'):
    return dict(category=category, label=label, direction=direction, text='模型任意说明')


def sign(text='中山路', clarity='high', direction='front'):
    return dict(category='text', label='sign', direction=direction, text=text, clarity=clarity)


def obstacle(label='car', direction='front', proximity='unknown', confidence=None, approaching=False):
    return SpatialObservation(category='obstacle', label=label, direction=direction,
                              proximity=proximity, approaching=approaching, confidence=confidence)


def summary(events, mode='walk', uncertain=False, min_confidence=0.0, continuous_repeat_seconds=0.0):
    return summarize(AnalyzeInput(mode=mode, source='video', session_id='s', frame_id=3),
                     VisionResult.model_validate({'events': events, 'uncertain': uncertain}),
                     min_confidence=min_confidence, continuous_repeat_seconds=continuous_repeat_seconds)


def spatial_summary(events, mode='walk', min_confidence=0.0):
    return summarize(AnalyzeInput(mode=mode, source='video', session_id='s', frame_id=3),
                     VisionResult.model_validate({'events': events}), spatial=events,
                     min_confidence=min_confidence, score_threshold=70, detail_level='medium')


def test_walk_excludes_signs_and_keeps_priority_dedup_limit():
    response = summary([sign(), event('bus_stop', 'facility'), event('car'),
                        event('stairs'), event('stairs'), event('barrier')])
    assert [e.label for e in response.events] == ['stairs', 'car', 'barrier', 'bus_stop']
    assert response.speech.text == '前方发现楼梯；前方发现车辆'
    assert response.speech.priority == 'high'


def test_new_score_threshold_and_detail_profiles():
    events = [SpatialObservation(**event('stairs'), proximity='near'),
              SpatialObservation(**event('car', direction='right'), proximity='near'),
              SpatialObservation(**event('barrier', direction='left'), proximity='near')]
    assert score(events[0]) == score(SpatialObservation(**event('escalator', 'facility'))) + 32
    assert summarize(AnalyzeInput(mode='walk', source='video', session_id='s', frame_id=1), VisionResult(), spatial=events,
                     score_threshold=130, detail_level='low').speech is None
    for level, count in [('low', 3), ('medium', 2), ('high', 1)]:
        response = summarize(AnalyzeInput(mode='walk', source='video', session_id='s', frame_id=1), VisionResult(),
                             spatial=events, score_threshold=0, detail_level=level)
        assert len(response.speech.key.split('|')) == count


@pytest.mark.parametrize('samples, level', [
    ([(0, 100), (1, 104), (2, 108)], 'slow'),
    ([(0, 100), (1, 120), (2, 145)], 'medium'),
    ([(0, 100), (1, 180), (2, 330)], 'fast'),
    ([(0, 100), (1, 90), (2, 80)], 'unknown'),
])
def test_calculate_approach_speed_levels(samples, level):
    rate, actual = calculate_approach_speed(samples)
    assert actual == level
    assert rate is None or rate >= 0


def test_box_is_kept_as_normalized_ints():
    result = parse_result(json.dumps({'events': [{**event('stairs'), 'box': [1.0, 2.4, 300, 400]}]}))
    assert result.events[0].box == [1, 2, 300, 400]


def test_malformed_box_is_dropped_not_rejected():
    for box in (None, [1, 2, 3], [1, 2, 3, 'x'], [1, 2, 3, 4000], 'front', {'x1': 1}):
        result = parse_result(json.dumps({'events': [{**event('stairs'), 'box': box}]}))
        assert result.events[0].box is None
    result = parse_result(json.dumps({'events': [dict(sign(), box=[63, 109, 342, 278])]}))
    assert result.events[0].box == [63, 109, 342, 278]


def test_escalator_is_a_facility_and_keeps_model_category():
    result = parse_result(json.dumps({'events': [{**event('escalator', 'facility'), 'text': None}]}))
    assert result.events[0].text == '自动扶梯'
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(json.dumps({'events': [event('escalator')]}))
    response = summary([event('escalator', 'facility')])
    assert response.speech.text == '前方发现自动扶梯'
    assert response.speech.priority == 'high'


def test_walk_drops_signs_and_keeps_facility_priority():
    response = summary([event('entrance', 'facility'), sign()])
    assert [e.label for e in response.events] == ['entrance']
    assert response.speech.model_dump() == {
        'key': 'entrance:front', 'text': '前方发现出入口', 'priority': 'low'}


def test_danger_tiers_order_steps_obstacles_then_facilities():
    response = summary([sign(), event('escalator', 'facility'),
                        event('car'), event('stairs')])
    assert [e.label for e in response.events] == ['stairs', 'escalator', 'car']
    assert response.speech.text == '前方发现楼梯；前方发现车辆'


def test_collision_tier_orders_front_before_sides():
    response = summary([event('barrier', direction='right'),
                        event('bollard', direction='left'), event('car')])
    assert [(e.label, e.direction) for e in response.events] == [
        ('car', 'front'), ('barrier', 'right'), ('bollard', 'left')]


@pytest.mark.parametrize('mode', ['walk', 'read'])
def test_signs_are_sorted_by_clarity_not_input_order_or_direction(mode):
    response = summary([sign('可读路', 'medium', 'front'),
                        sign('清晰路', 'high', 'right'), sign('模糊路', 'low')], mode)
    if mode == 'read':
        assert [e.text for e in response.events] == ['清晰路']
        assert response.speech.key == 'sign:清晰路'
    else:
        assert response.events == []
        assert response.speech is None


def test_equal_clarity_order_is_stable_in_read_mode():
    response = summary([sign(name) for name in ['甲路', '乙路', '丙路', '丁路']], 'read')
    assert [e.text for e in response.events] == ['甲路']


def test_sign_dedup_ignores_direction_and_clarity_and_normalizes_whitespace():
    response = summary([sign('  中山路\n 12号 ', 'medium', 'left'),
                        sign('中山路 12号', 'high', 'right'), sign('中山路 12号', 'high')], 'read')
    assert len(response.events) == 1
    assert response.events[0].direction == 'right'
    assert response.events[0].clarity == 'high'
    assert response.speech.key == 'sign:中山路 12号'
    assert summary([sign('中山路 12号', 'medium', 'unknown')], 'read').speech.key == response.speech.key


def test_obstacle_dedup_still_distinguishes_direction():
    response = summary([event('car', direction='left'), event('car', direction='right')])
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


@pytest.mark.parametrize('extra', [{'clarity': 'high'}, {'distance': 2}])
def test_obstacles_cannot_supply_clarity_or_distance(extra):
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(json.dumps({'events': [{**event('stairs'), **extra}]}))


@pytest.mark.parametrize('raw,expected', [(0.99, 0.99), (0, 0.0), (1, 1.0), (None, None), (True, None), ('high', None), (-0.1, None), (1.2, None)])
def test_confidence_is_kept_as_ratio_or_dropped(raw, expected):
    result = parse_result(json.dumps({'events': [{**event('stairs'), 'confidence': raw}]}))
    assert result.events[0].confidence == expected


def test_obstacle_null_text_is_normalized_to_label():
    result = parse_result(json.dumps({'events': [{**event('stairs'), 'text': None}]}))
    assert result.events[0].text == '楼梯'


def test_sign_with_null_text_is_rejected():
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(json.dumps({'events': [{**sign(), 'text': None}]}))


@pytest.mark.parametrize('raw', ['```', '```json```', 'null', '[]', '{"events":[],"advice":"go"}', '{"events":[{"category":"facility","label":"car","direction":"front"}]}'])
def test_malformed_outputs_rejected(raw):
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(raw)


def test_bicycle_from_an_older_model_is_silently_dropped():
    result = parse_result('{"events":[{"label":"bicycle","direction":"front","box":[10,20,200,500]}]}')
    assert result.events == []


def test_fenced_json_accepted():
    assert parse_result('```json\n{"events":[]}\n```').events == []


def test_duplicated_field_opener_is_repaired():
    raw = '{"events":[{"label":"person","direction":"front","box":[1,2,3,4],"confidence":0.9},{"label":"person","direction":"front","box":":[5,6,7,8],"confidence":0.8}]}'
    result = parse_result(raw)
    assert [list(e.box) for e in result.events] == [[1, 2, 3, 4], [5, 6, 7, 8]]


def repeat_summary(events, recent, now, mode='walk', session='s', repeat_seconds=4.0, uncertain=False):
    return summarize(AnalyzeInput(mode=mode, source='video', session_id=session, frame_id=3),
                     VisionResult.model_validate({'events': events, 'uncertain': uncertain}),
                     recent, now=now, repeat_seconds=repeat_seconds)


def test_repeat_speech_suppressed_within_window_and_recovers_at_boundary():
    recent = {}
    stairs = [event('stairs')]
    assert repeat_summary(stairs, recent, now=100.0).speech.text == '前方发现楼梯'
    suppressed = repeat_summary(stairs, recent, now=103.9)
    assert suppressed.speech is None
    assert [e.label for e in suppressed.events] == ['stairs']
    assert repeat_summary(stairs, recent, now=104.0).speech.text == '前方发现楼梯'


def test_repeat_suppression_tracks_speech_key_not_frame():
    recent = {}
    assert repeat_summary([event('stairs')], recent, now=0.0).speech is not None
    different = repeat_summary([event('car')], recent, now=1.0)
    assert different.speech.text == '前方发现车辆'


def test_repeat_suppression_is_per_session_dict():
    first, second = {}, {}
    assert repeat_summary([event('stairs')], first, now=0.0, session='sa').speech is not None
    assert repeat_summary([event('stairs')], second, now=0.0, session='sb').speech is not None


def test_repeat_suppression_disabled_when_window_is_zero():
    recent = {}
    assert repeat_summary([event('stairs')], recent, now=0.0, repeat_seconds=0).speech is not None
    assert repeat_summary([event('stairs')], recent, now=1.0, repeat_seconds=0).speech is not None


def test_read_unclear_speech_is_deduped_within_window():
    recent = {}
    def unclear(now):
        return repeat_summary([], recent, now=now, mode='read', uncertain=True)
    assert unclear(0.0).speech.key == 'unclear'
    assert unclear(1.0).speech is None
    assert unclear(4.2).speech.key == 'unclear'


def test_far_obstacle_is_not_spoken_but_kept_in_details():
    response = spatial_summary([obstacle('car', proximity='far'),
                                obstacle('bollard', proximity='near')])
    assert [e.label for e in response.events] == ['bollard', 'car']
    assert response.speech.key == 'bollard:front:near'
    assert response.speech.text == '前方发现路障，较近'


def test_far_person_with_unknown_confidence_is_also_silent():
    response = spatial_summary([obstacle('person', proximity='far')])
    assert response.events[0].label == 'person'
    assert response.speech is None


def test_low_confidence_low_risk_obstacle_is_not_spoken():
    response = spatial_summary([obstacle('person', confidence=0.3)], min_confidence=0.5)
    assert [e.label for e in response.events] == ['person']
    assert response.speech is None


def test_low_confidence_high_risk_is_spoken_as_hazy_warning():
    response = spatial_summary([obstacle('stairs', confidence=0.3)], min_confidence=0.5)
    assert response.speech.text == '前方疑似有楼梯，请留意'
    assert response.speech.key == 'stairs:front'
    assert response.speech.priority == 'high'


def test_confident_detection_keeps_normal_wording():
    response = spatial_summary([obstacle('person', confidence=0.9)], min_confidence=0.5)
    assert response.speech.text == '前方发现行人'


def test_confidence_floor_zero_disables_hazy_filtering():
    response = spatial_summary([obstacle('person', confidence=0.1)], min_confidence=0.0)
    assert response.speech.text == '前方发现行人'


def continuous_summary(events, recent, now, repeat_seconds=4.0, continuous_repeat_seconds=12.0):
    return summarize(AnalyzeInput(mode='walk', source='video', session_id='s', frame_id=3),
                     VisionResult.model_validate({'events': events}), recent, now=now,
                     repeat_seconds=repeat_seconds, continuous_repeat_seconds=continuous_repeat_seconds)


def test_continuous_objects_use_wider_repeat_window():
    recent = {}
    assert continuous_summary([event('stairs')], recent, now=0.0).speech.text == '前方发现楼梯'
    assert continuous_summary([event('stairs')], recent, now=5.0).speech is None
    assert continuous_summary([event('stairs')], recent, now=13.0).speech.text == '前方发现楼梯'


def test_point_hazards_keep_the_short_window():
    recent = {}
    assert continuous_summary([event('bollard')], recent, now=0.0).speech.text == '前方发现路障'
    assert continuous_summary([event('bollard')], recent, now=5.0).speech.text == '前方发现路障'


def test_arrow_and_symbol_noise_is_audited_out_of_sign_text():
    response = summary([sign('→ 中山路12号 ↑')], 'read')
    assert response.events[0].text == '中山路12号'
    assert response.speech.key == 'sign:中山路12号'


def test_gibberish_sign_text_is_dropped():
    response = summary([sign('的的的'), sign('➤➤➤')], 'read')
    assert response.events == []
    assert response.status == 'uncertain'
    assert response.speech.key == 'unclear'


@pytest.mark.parametrize('mode', ['walk', 'read'])
def test_symbol_only_sign_in_read_mode_becomes_unclear(mode):
    response = summary([sign('➤ ➤ ➤')], mode)
    assert response.events == []
    if mode == 'read':
        assert response.status == 'uncertain'
        assert response.speech.key == 'unclear'
    else:
        assert response.status == 'ok'
        assert response.speech is None
