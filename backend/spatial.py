"""Bounded session-local apparent-size tracking; this is not metric depth or TTC."""
from collections import OrderedDict, deque
from dataclasses import dataclass, field
import math

from .distance import estimate_distance_m, estimate_person_width_m
from .models import AnalyzeInput, SpatialObservation, VisionResult
from .panorama import angular_span, bearing, direction_from_bearing


@dataclass
class Track:
    event: SpatialObservation
    seen: float
    scales: deque = field(default_factory=lambda: deque(maxlen=3))
    basis: str = 'unknown'


@dataclass
class Session:
    seen: float
    signature: tuple
    frame: int = -1
    tracks: list[Track] = field(default_factory=list)
    recent: dict = field(default_factory=dict)


def center(box):
    return ((box[0]+box[2])/2, (box[1]+box[3])/2)


def scale(event, axis):
    if event.yaw_deg is not None:
        return angular_span(event, axis)
    return event.box[axis+2]-event.box[axis] if event.box else None


def compatible(a, b):
    if a.label != b.label or not a.box or not b.box:
        return False
    if a.yaw_deg is not None and b.yaw_deg is not None:
        # Polar faces rotate the meaning of local width/height. Start fresh there.
        if a.view != b.view and ({a.view, b.view} & {'up', 'down'}):
            return False
        p1, p2 = math.radians(a.pitch_deg or 0), math.radians(b.pitch_deg or 0)
        cosine = math.sin(p1)*math.sin(p2) + math.cos(p1)*math.cos(p2)*math.cos(math.radians(a.yaw_deg-b.yaw_deg))
        if math.degrees(math.acos(max(-1, min(1, cosine)))) > 20:
            return False
    elif a.yaw_deg is not None or b.yaw_deg is not None or a.view != b.view or a.direction != b.direction:
        return False
    else:
        ax, ay = center(a.box); bx, by = center(b.box)
        if math.hypot(ax-bx, ay-by) >= 100:
            return False
    axis = 0 if a.distance_basis == b.distance_basis == 'apparent_width' else 1
    size_a, size_b = scale(a, axis), scale(b, axis)
    return bool(size_a and size_b and 0.65 < size_a / size_b < 1.55)


class SpatialSessions:
    def __init__(self):
        self.sessions = OrderedDict()

    def process(self, meta: AnalyzeInput, result: VisionResult, width: int, height: int, settings, now: float):
        for key, value in list(self.sessions.items()):
            if now-value.seen > 60:
                del self.sessions[key]
        signature = (meta.source, meta.mode, meta.projection, meta.heading_deg)
        session = self.sessions.get(meta.session_id)
        if session is None or session.signature != signature or meta.frame_id <= session.frame:
            session = Session(now, signature)
            self.sessions[meta.session_id] = session
        self.sessions.move_to_end(meta.session_id)
        while len(self.sessions) > 32:
            self.sessions.popitem(last=False)
        session.seen, session.frame = now, meta.frame_id
        enriched = []
        for raw in ([] if result.uncertain else result.events):
            event = SpatialObservation(**raw.model_dump())
            if meta.projection == 'equirectangular':
                angles = bearing(raw)
                if angles is None:
                    continue  # Missing panel provenance must not become a guessed direction.
                event.yaw_deg, event.pitch_deg = angles
                event.direction = direction_from_bearing(*angles)
                if event.label == 'person' and event.pitch_deg < -55:
                    continue  # Nadir bodies are usually the camera carrier; not a route alert.
                if event.label == 'person' and event.box and event.box[1] >= 700 and event.box[3] >= 980:
                    continue  # Head-only fragment at a face's bottom edge lacks usable route grounding.
                w = h = 384
                fov = 90
            else:
                event.view = None
                if event.direction == 'back':
                    continue  # Ordinary forward cameras cannot see behind the wearer.
                w, h, fov = width, height, settings.camera_hfov_deg
            # Physical sizes for stairs, signs, overhead objects vary too much for this approximation.
            complete_height = event.box and event.box[1] > 5 and event.box[3] < 995
            if complete_height and event.label in {'bicycle', 'person', 'car', 'motorcycle', 'bollard', 'barrier'}:
                estimate = estimate_distance_m(event, w, h, fov)
                if estimate is not None:
                    event.distance_basis = 'apparent_size'
                    event.proximity = 'near' if estimate <= 2.5 else 'mid' if estimate <= 5 else 'far'
            elif not complete_height and event.label == 'person':
                estimate = estimate_person_width_m(event, fov)
                if estimate is not None:
                    event.distance_basis = 'apparent_width'
                    event.proximity = 'near' if estimate <= 2.5 else 'mid' if estimate <= 5 else 'far'
            # A large overhead box may be a distant roof; angular extent alone
            # must never promote it to a nearby collision hazard.
            enriched.append(event)
        # Face edges overlap in detections even at a 90-degree projection. Prefer a
        # complete box and merge same-class angular duplicates across adjacent faces.
        if meta.projection == 'equirectangular':
            distinct = []
            for event in sorted(enriched, key=lambda e: bool(e.box and min(e.box[:2]) > 10 and max(e.box[2:]) < 990), reverse=True):
                duplicate = any(e.label == event.label and e.view != event.view
                    and abs((e.yaw_deg-event.yaw_deg+180)%360-180) < 12
                    and abs(e.pitch_deg-event.pitch_deg) < 12 for e in distinct)
                if not duplicate:
                    distinct.append(event)
            enriched = distinct
        tracks = []
        old = [t for t in session.tracks if 0 < now-t.seen <= 10]
        for event in enriched:
            matches = [t for t in old if compatible(event, t.event)]
            # Ambiguous same-class associations reset motion; never join different people into an approach.
            match = matches[0] if len(matches) == 1 and sum(compatible(e, matches[0].event) for e in enriched) == 1 else None
            # Copy matched history: every association in this frame must see the
            # same previous frame, regardless of the model's event ordering.
            track = Track(event, now, deque(match.scales, maxlen=3), match.basis) if match else Track(event, now)
            if event.distance_basis != track.basis:
                track.scales.clear()
                track.basis = event.distance_basis
            if event.box and track.basis != 'unknown':
                axis = 0 if track.basis == 'apparent_width' else 1
                extent = scale(event, axis)
                if extent:
                    track.scales.append((now, extent))
            rear = event.direction == 'back' or (event.yaw_deg is not None and abs(event.yaw_deg) >= 120)
            if len(track.scales) == 3 and rear and event.proximity == 'near':
                (t0,h0),(t1,h1),(t2,h2) = track.scales
                event.approaching = (1 <= t2-t0 <= 20 and h1 >= h0*1.08 and h2 >= h1*1.08
                                     and h2 >= h0*1.25 and event.label in {'person','bicycle','car','motorcycle'})
            track.event, track.seen = event, now
            tracks.append(track)
        session.tracks = tracks[:12]
        return enriched, session.recent
