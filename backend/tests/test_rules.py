import pytest
from backend.models import AnalyzeInput, VisionResult
from backend.rules import summarize
from backend.vision import parse_result, VisionError


def event(label, category='obstacle', direction='front'):
    return dict(category=category, label=label, direction=direction, text='模型任意说明')


def test_priority_dedup_limit_and_no_unsolicited_ocr():
    result = VisionResult.model_validate({'events': [event('sign', 'text'), event('bus_stop', 'facility'), event('bicycle'), event('stairs'), event('stairs'), event('barrier')]})
    meta = AnalyzeInput(mode='walk', source='video', session_id='s', frame_id=3)
    response = summarize(meta, result)
    assert [e.label for e in response.events] == ['stairs', 'bicycle', 'barrier']
    assert response.speech.text == '前方发现楼梯'
    assert response.speech.priority == 'high'


def test_read_excludes_obstacles():
    result = VisionResult.model_validate({'events': [event('stairs'), event('sign', 'text')]})
    response = summarize(AnalyzeInput(mode='read', source='camera', session_id='s', frame_id=1), result)
    assert [e.label for e in response.events] == ['sign']
    assert response.speech.priority == 'normal'


@pytest.mark.parametrize('raw', ['```', '```json```', 'null', '[]', '{"events":[],"advice":"go"}', '{"events":[{"category":"facility","label":"bicycle","direction":"front"}]}'])
def test_malformed_outputs_rejected(raw):
    with pytest.raises(VisionError, match='invalid_model_output'):
        parse_result(raw)


def test_fenced_json_accepted():
    assert parse_result('```json\n{"events":[]}\n```').events == []
