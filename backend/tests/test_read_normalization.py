import json

import pytest

from backend.models import AnalyzeInput
from backend.rules import summarize
from backend.vision import parse_result, VisionError


def read(events, **kwargs):
    return parse_result(json.dumps({'events': events}, ensure_ascii=False), mode='read', **kwargs)


def test_read_recovers_metadata_and_preserves_text():
    result = parse_result('识别结果：\n```json\n' + json.dumps({'events': [
        {'label': 'sign', 'text': '南京南站', 'direction': '左前方', 'clarity': '清晰',
         'bbox': [10, 20, 200, 300], 'explanation': 'extra'}]}, ensure_ascii=False) + '\n```', mode='read')
    event = result.events[0]
    assert (event.text, event.direction, event.clarity, event.box) == ('南京南站', 'left', 'high', [10, 20, 200, 300])


def test_one_invalid_sign_does_not_discard_a_readable_sign():
    result = read([{'label': 'sign', 'text': None},
                   {'label': 'sign', 'text': '站' * 100, 'clarity': 'medium'}])
    assert len(result.events) == 1
    assert result.events[0].text == '站' * 80
    assert result.events[0].direction == 'unknown'


def test_missing_clarity_is_not_fabricated_as_readable():
    result = read([{'label': 'sign', 'text': '不确定文字'}])
    response = summarize(AnalyzeInput(session_id='read-test', frame_id=1, source='camera', mode='read'), result)
    assert response.status == 'uncertain'
    assert response.events == []
    assert response.speech.text == '文字看不清，请调整拍摄角度'


def test_panorama_still_grounds_read_box():
    result = read([{'label': 'sign', 'text': '出口', 'clarity': 'high',
                    'bbox': [400, 200, 550, 600]}], panorama=True)
    assert result.events[0].view == 'front'


@pytest.mark.parametrize('raw', ['文字：南京站', '{"events":[', '{"events":[]} {"events":[]}'])
def test_invalid_read_json_is_rejected_without_logging_ocr(raw, caplog):
    with pytest.raises(VisionError):
        parse_result(raw, mode='read')
    assert 'vision_parse' in caplog.text
    assert '南京站' not in caplog.text


def test_validation_diagnostics_do_not_log_text(caplog):
    with pytest.raises(VisionError):
        parse_result('{"uncertain":{},"events":[{"label":"sign","text":"私人文字","clarity":"high"}]}', mode='read')
    assert 'field=uncertain' in caplog.text
    assert '私人文字' not in caplog.text
