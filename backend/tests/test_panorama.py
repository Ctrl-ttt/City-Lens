import io
import json
import math

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.models import AnalyzeInput, Observation, SpatialObservation, VisionResult
from backend.panorama import FACE_SIZE, HEADER, FACES, angular_span, bearing, direction_from_bearing, prepare_panorama
from backend.rules import summarize
from backend.spatial import SpatialSessions, compatible
from backend.vision import Settings, VisionError, parse_result


def meta(frame=1, **kw):
    return AnalyzeInput(session_id='panorama-test', frame_id=frame, mode='walk', source='video',
                        projection='equirectangular', **kw)


def event(label='car', view='front', box=None, **kw):
    return Observation(category='obstacle', label=label, direction='front', view=view,
                       box=box if box is not None else [400, 300, 600, 700], **kw)


def jpeg(pixels):
    out = io.BytesIO(); Image.fromarray(pixels).save(out, format='JPEG', quality=98)
    return out.getvalue()


def test_panorama_faces_have_expected_cardinal_colors_and_heading():
    pixels = np.zeros((480, 960, 3), dtype=np.uint8)
    # Test the actual projection, not just a direction enum.
    pixels[:, 0:120] = pixels[:, 840:] = [255, 255, 0]  # rear seam
    pixels[:, 120:360] = [255, 0, 0]  # left
    pixels[:, 360:600] = [0, 255, 0]  # front
    pixels[:, 600:840] = [0, 0, 255]  # right
    pixels[:80] = [255, 0, 255]  # above
    pixels[-80:] = [0, 255, 255]  # below
    atlas = np.asarray(Image.open(io.BytesIO(prepare_panorama(jpeg(pixels), meta()))))
    colors = [[0,255,0], [255,0,0], [0,0,255], [255,255,0], [255,0,255], [0,255,255]]
    for i, expected in enumerate(colors):
        actual = atlas[(i//3)*(FACE_SIZE+HEADER)+HEADER+FACE_SIZE//2, (i%3)*FACE_SIZE+FACE_SIZE//2]
        assert np.max(np.abs(actual.astype(int)-expected)) < 8
    shifted = np.asarray(Image.open(io.BytesIO(prepare_panorama(jpeg(pixels), meta(heading_deg=90)))))
    assert shifted[HEADER+FACE_SIZE//2, FACE_SIZE//2, 2] > 240


@pytest.mark.parametrize('view,expected', [('front','front'),('left','left'),('right','right'),('back','back'),('up','above')])
def test_face_center_directions(view, expected):
    assert direction_from_bearing(*bearing(event(view=view))) == expected


def test_fisheye_square_is_not_silently_treated_as_stitched_panorama():
    with pytest.raises(VisionError, match='invalid_panorama'):
        prepare_panorama(jpeg(np.zeros((640,640,3), dtype=np.uint8)), meta())


def test_large_overhead_box_does_not_imply_close_head_clearance():
    tracker=SpatialSessions()
    events,_=tracker.process(meta(),VisionResult(events=[event('overhead','up',[10,10,990,990])]),960,480,Settings(),0)
    assert events[0].proximity=='unknown' and events[0].distance_basis=='unknown'


def test_background_roof_is_visible_but_not_spoken_as_a_hazard():
    roof=Observation(category='facility',label='canopy',direction='above')
    result=summarize(meta(),VisionResult(events=[roof]), score_threshold=70, detail_level='medium')
    assert result.events[0].label=='canopy'
    assert result.speech is None


def test_camera_carrier_head_fragment_does_not_monopolize_front_alerts():
    tracker=SpatialSessions()
    events,_=tracker.process(meta(),VisionResult(events=[event('person','front',[200,800,650,1000]),event('stairs','front')]),960,480,Settings(),0)
    assert [e.label for e in events]==['stairs']


def test_down_face_person_is_treated_as_the_camera_carrier_but_side_people_remain():
    tracker = SpatialSessions()
    events, _ = tracker.process(meta(), VisionResult(events=[
        event('person', 'down', [100, 100, 900, 900]),
        event('person', 'left', [350, 250, 650, 900]),
    ]), 960, 480, Settings(), 0)
    assert len(events) == 1
    assert events[0].label == 'person' and events[0].view == 'left'


def test_clipped_person_height_is_not_used_as_a_full_body_distance():
    tracker=SpatialSessions()
    events,_=tracker.process(meta(),VisionResult(events=[event('person','front',[200,300,650,1000])]),960,480,Settings(),0)
    assert events[0].distance_basis=='apparent_width'


def test_clipped_width_and_height_cannot_supply_a_range_estimate():
    tracker=SpatialSessions()
    events,_=tracker.process(meta(),VisionResult(events=[event('person','back',[0,300,650,1000])]),960,480,Settings(),0)
    assert events[0].proximity=='unknown'


def test_width_fallback_tracks_growth_but_never_mixes_axes():
    tracker=SpatialSessions()
    for i,width in enumerate([180,220,270]):
        raw=event('person','back',[500-width//2,300,500+width//2,1000])
        events,_=tracker.process(meta(i+1),VisionResult(events=[raw]),960,480,Settings(),i*2)
    assert events[0].distance_basis=='apparent_width' and events[0].approaching
    raw=event('person','back',[350,250,650,950])
    events,_=tracker.process(meta(4),VisionResult(events=[raw]),960,480,Settings(),6)
    assert events[0].distance_basis=='apparent_size' and not events[0].approaching


def angular_person(yaw, height_degrees):
    """Project an upright target of known angular height onto its nearest face."""
    view = min(['front', 'right', 'back', 'left'],
               key=lambda name: abs((yaw-FACES[name][0]+180)%360-180))
    delta = math.radians((yaw-FACES[view][0]+180)%360-180)
    x = 500*(1+math.tan(delta))
    half_height = 500*math.tan(math.radians(height_degrees)/2)/math.cos(delta)
    return event('person', view, [round(x-15), round(500-half_height), round(x+15), round(500+half_height)])


@pytest.mark.parametrize('yaws', [[130, 140, 155], [180, 165, 146], [170, 179, -170]])
def test_constant_angular_size_never_approaches_despite_perspective_or_seam(yaws):
    tracker = SpatialSessions()
    for i, yaw in enumerate(yaws):
        raw = angular_person(yaw, 38)
        assert math.degrees(angular_span(raw, 1)) == pytest.approx(38, abs=0.2)
        events, _ = tracker.process(meta(i+1), VisionResult(events=[raw]), 960, 480, Settings(), i*2)
        assert not events[0].approaching
    # Association survived; the negative result isn't merely a track reset.
    assert len(tracker.sessions['panorama-test'].tracks[0].scales) == 3


def test_spherical_seam_association_triggers_on_angular_growth():
    tracker = SpatialSessions()
    for i, (yaw, extent) in enumerate(zip([130, 140, 155], [25, 32, 41])):
        events, _ = tracker.process(meta(i+1), VisionResult(events=[angular_person(yaw, extent)]),
                                    960, 480, Settings(), i*2)
        assert events[0].approaching == (i == 2)


@pytest.mark.parametrize('reverse', [False, True])
def test_associations_use_immutable_previous_frame_regardless_of_event_order(reverse):
    tracker = SpatialSessions()
    for i, (yaws, extent) in enumerate(zip([[130, 180], [147, 166], [130, 180]], [30, 38, 48])):
        observations = [angular_person(yaw, extent) for yaw in yaws]
        events, _ = tracker.process(meta(i+1), VisionResult(events=observations[::-1] if reverse else observations),
                                    960, 480, Settings(), i*2)
    assert all(e.approaching for e in events)
    assert [len(t.scales) for t in tracker.sessions['panorama-test'].tracks] == [3, 3]


def test_polar_face_switch_resets_incompatible_axis_history():
    a = SpatialObservation(**event('person', 'back', [400, 0, 600, 200]).model_dump(), distance_basis='apparent_width')
    b = SpatialObservation(**event('person', 'up', [400, 0, 600, 200]).model_dump(), distance_basis='apparent_width')
    a.yaw_deg, a.pitch_deg = bearing(a)
    b.yaw_deg, b.pitch_deg = bearing(b)
    assert not compatible(a, b)


def test_rear_side_approach_has_urgent_score_before_front_hazards():
    tracker = SpatialSessions()
    for i, extent in enumerate([25, 32, 41]):
        events, _ = tracker.process(meta(i+1), VisionResult(events=[angular_person(125, extent)]),
                                    960, 480, Settings(), i*2)
    assert events[0].direction == 'right' and events[0].approaching
    front = SpatialObservation(**event('stairs').model_dump(), proximity='near')
    response = summarize(meta(), VisionResult(), spatial=[front, *events])
    assert response.speech.priority == 'urgent'
    assert response.speech.text.startswith('后方行人疑似靠近')


def test_width_fallback_does_not_treat_height_crop_changes_as_motion():
    tracker=SpatialSessions()
    for i,y in enumerate([500,400,300]):
        events,_=tracker.process(meta(i+1),VisionResult(events=[event('person','back',[350,y,650,1000])]),960,480,Settings(),i*2)
        assert not events[0].approaching


def test_adjacent_face_duplicates_are_merged_across_angular_boundary():
    tracker=SpatialSessions()
    observations=[event('car','front',[950,300,1000,700]),event('car','right',[0,300,50,700])]
    events,_=tracker.process(meta(),VisionResult(events=observations),960,480,Settings(),0)
    assert len(events)==1


def test_valid_compact_json_and_invalid_label_remain_distinct():
    assert parse_result('{"events":[{"label":"person","direction":"left","box":[10,20,100,400]}]}').events[0].text=='行人'
    with pytest.raises(VisionError):
        parse_result('{"events":[{"label":"facility","direction":"left"}]}')


def test_atlas_global_box_determines_direction_without_model_view_guess():
    result=parse_result('{"events":[{"label":"person","box":[725,346,825,490]}]}',panorama=True)
    e=result.events[0]
    assert e.view=='right'
    assert 0 <= e.box[0] < e.box[2] <= 1000
    assert e.direction=='unknown'  # Assigned later from the actual perspective ray.


def test_unlocalizable_roof_and_missing_box_do_not_hide_grounded_obstacle():
    result=parse_result(json.dumps({'events':[
        {'label':'car','box':[100,100,200,300]},
        {'label':'canopy','box':[0,0,999,650]},
        {'label':'sign','text':'测试牌','clarity':'high'}]}),panorama=True)
    assert [e.label for e in result.events]==['car']
    assert not result.uncertain
    only_missing=parse_result('{"events":[{"label":"person"}]}',panorama=True)
    assert only_missing.uncertain and only_missing.events==[]


def test_missing_view_is_not_guessed_and_metric_fields_are_not_trusted():
    tracker = SpatialSessions()
    events, _ = tracker.process(meta(), VisionResult(events=[event(view=None)]), 960, 480, Settings(), 0)
    assert events == []
    for fields in ({'approaching':True}, {'proximity':'near'}, {'distance_basis':'apparent_size'}):
        with pytest.raises(VisionError):
            parse_result(json.dumps({'events': [{**event().model_dump(), **fields}]}))


def rear_sequence(heights, times=None, session_ids=None):
    tracker = SpatialSessions(); results = []
    for i,h in enumerate(heights):
        m = meta(i+1)
        if session_ids: m.session_id = session_ids[i]
        events, _ = tracker.process(m, VisionResult(events=[event('person','back',[400,500-h//2,600,500+h//2])]),
                                     960,480,Settings(), times[i] if times else i*2)
        results.append(events[0])
    return results


def test_rear_approach_needs_three_consistent_frames_and_near_size():
    events = rear_sequence([300,380,480])
    assert [e.approaching for e in events] == [False,False,True]
    result = summarize(meta(), VisionResult(), spatial=[events[-1], SpatialObservation(**event().model_dump())])
    assert result.speech.priority == 'urgent'
    assert result.speech.text.startswith('后方行人疑似靠近')
    assert '前方' in result.speech.text and '米' not in result.speech.text


def test_rear_tracking_tolerates_actual_cloud_sampling_interval():
    assert rear_sequence([300,380,480], times=[0,6.1,12.2])[-1].approaching


def test_front_approach_needs_three_consistent_near_observations():
    tracker = SpatialSessions(); observations = []
    for i, height in enumerate([300, 380, 480]):
        current, _ = tracker.process(meta(i + 1), VisionResult(events=[event('car', 'front', [400, 500-height//2, 600, 500+height//2])]),
                                     960, 480, Settings(), i * 2)
        observations.append(current[0])
    assert [item.approaching for item in observations] == [False, False, True]
    response = summarize(meta(), VisionResult(), spatial=[observations[-1]])
    assert response.speech.priority == 'urgent'
    assert response.speech.text.startswith('前方车辆疑似正在靠近')


@pytest.mark.parametrize('heights', [[450,450,450], [450,400,350], [100,130,160], [300,700,480]])
def test_rear_stationary_receding_distant_and_jumpy_boxes_do_not_trigger(heights):
    assert not any(e.approaching for e in rear_sequence(heights))


def test_seek_new_session_and_long_gap_clear_motion_evidence():
    assert not rear_sequence([300,380,480], session_ids=['a','a','b'])[-1].approaching
    assert not rear_sequence([300,380,480], times=[0,2,20])[-1].approaching


def test_multiple_similar_people_cannot_be_combined_into_one_approach():
    tracker = SpatialSessions()
    for i,h in enumerate([300,380,480]):
        observations = [event('person','back',[x,500-h//2,x+120,500+h//2]) for x in [400,420]]
        events,_ = tracker.process(meta(i+1),VisionResult(events=observations),960,480,Settings(),i*2)
        assert not any(e.approaching for e in events)


def test_front_priority_side_coverage_and_two_target_budget():
    observations = [SpatialObservation(**event(label,view).model_dump(), proximity='mid') for label,view in
                    [('car','front'),('bollard','front'),('barrier','left'),('person','back')]]
    for e in observations: e.direction = e.view
    response = summarize(meta(),VisionResult(),spatial=observations)
    assert response.speech.text == '前方发现车辆；左侧发现围挡'
    assert len(response.speech.key.split('|')) == 2


def test_same_direction_people_with_different_ranges_do_not_repeat_identical_phrase():
    near=SpatialObservation(**event('person','back').model_dump(),proximity='near')
    mid=SpatialObservation(**event('person','back').model_dump(),proximity='mid')
    near.direction=mid.direction='back'
    side=SpatialObservation(**event('car','left').model_dump());side.direction='left'
    recent={}
    first=summarize(meta(),VisionResult(),recent,now=0,repeat_seconds=8,spatial=[near,mid,side])
    assert first.speech.text.count('后方发现行人')==1
    assert '左侧发现车辆' in first.speech.text
    assert summarize(meta(2),VisionResult(),recent,now=2,repeat_seconds=8,spatial=[mid]).speech is None


def test_near_side_vehicle_outranks_distant_front_vehicle_and_overhead_gets_slot():
    far = SpatialObservation(**event('car').model_dump(),proximity='far')
    near = SpatialObservation(**event('car','left').model_dump(),proximity='near'); near.direction='left'
    above = SpatialObservation(**event('overhead','up').model_dump()); above.direction='above'
    response = summarize(meta(),VisionResult(),spatial=[far,near,above])
    assert response.speech.text == '左侧发现车辆；上方发现悬空障碍'


def test_repeated_first_target_falls_through_to_other_targets():
    recent={}
    observations=[event('stairs'),event('car'),event('barrier','left')]
    result=VisionResult(events=observations)
    first=summarize(meta(),result,recent,now=0,repeat_seconds=8)
    second=summarize(meta(2),result,recent,now=2,repeat_seconds=8)
    assert len(first.speech.key.split('|')) == 2
    assert second.speech is not None and '围挡' in second.speech.text
    assert summarize(meta(3),result,recent,now=4,repeat_seconds=8).speech is None


def test_session_memory_is_bounded_and_times_out():
    tracker=SpatialSessions()
    for i in range(100):
        m=meta(i);m.session_id=f's{i}'
        tracker.process(m,VisionResult(),960,480,Settings(),0)
    assert len(tracker.sessions)==32
    tracker.process(meta(),VisionResult(),960,480,Settings(),61)
    assert len(tracker.sessions)==1


def test_http_panorama_uses_one_request_with_atlas_and_maps_model_view():
    requests=[]
    def handler(request):
        requests.append(json.loads(request.content))
        result={'uncertain':False,'events':[{'label':'car','box':[100,650,200,900]}]}
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(result)}}]})
    with TestClient(create_app(Settings(api_key='test'),httpx.MockTransport(handler))) as client:
        fields={k:str(v) for k,v in meta().model_dump().items()}
        response=client.post('/api/analyze',data=fields,files={'image':('frame.jpg',jpeg(np.zeros((480,960,3),dtype=np.uint8)),'image/jpeg')})
    assert response.json()['events'][0]['direction']=='back'
    assert len(requests)==1
    assert '六宫格' in requests[0]['messages'][1]['content'][0]['text']
