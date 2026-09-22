from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Mode = Literal['walk', 'read']
Source = Literal['camera', 'video']
LABELS = {
    'bicycle': ('obstacle', '自行车'),
    'barrier': ('obstacle', '围挡'),
    'bollard': ('obstacle', '路障'),
    'step': ('obstacle', '台阶'),
    'stairs': ('obstacle', '楼梯'),
    'obstacle': ('obstacle', '障碍物'),
    'crosswalk': ('facility', '斑马线'),
    'elevator': ('facility', '电梯入口'),
    'escalator': ('facility', '自动扶梯'),
    'entrance': ('facility', '出入口'),
    'bus_stop': ('facility', '公交站'),
    'sign': ('text', '标牌'),
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Observation(StrictModel):
    category: Literal['obstacle', 'facility', 'text']
    label: str = Field(max_length=24)
    direction: Literal['left', 'front', 'right', 'unknown']
    text: str = Field(default='', max_length=80)
    clarity: Literal['high', 'medium', 'low'] | None = None
    box: list[int] | None = None

    @field_validator('text', mode='before')
    @classmethod
    def null_text_becomes_empty(cls, value):
        # Qwen-VL writes "text": null for obstacle/facility events even though the prompt asks for a string.
        return '' if value is None else value

    @field_validator('box', mode='before')
    @classmethod
    def box_is_normalized_or_dropped(cls, value):
        # The model grounds in 0-1000 normalized coordinates; anything malformed loses the box, not the event.
        if not isinstance(value, (list, tuple)) or len(value) != 4:
            return None
        try:
            coords = [round(float(item)) for item in value]
        except (TypeError, ValueError):
            return None
        if any(item < 0 or item > 1000 for item in coords):
            return None
        return coords

    @model_validator(mode='after')
    def check_label(self):
        if self.label not in LABELS or LABELS[self.label][0] != self.category:
            raise ValueError('unsupported observation')
        if self.category == 'text':
            self.text = ' '.join(self.text.split())
            if not self.text or self.clarity is None:
                raise ValueError('sign requires text and clarity')
        else:
            if self.clarity is not None:
                raise ValueError('clarity is only valid for signs')
            # Do not let unconstrained model descriptions become navigation advice.
            self.text = LABELS[self.label][1]
        return self


class VisionResult(StrictModel):
    uncertain: bool = False
    events: list[Observation] = Field(default_factory=list, max_length=12)


class AnalyzeInput(StrictModel):
    session_id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    frame_id: int = Field(ge=0, le=2**31-1)
    mode: Mode
    source: Source


class RealtimeFrame(AnalyzeInput):
    type: Literal['frame']
    mode: Literal['walk']
    image: str = Field(min_length=4, max_length=256 * 1024)


class Speech(StrictModel):
    key: str
    priority: Literal['high', 'normal', 'low']
    text: str


class AnalyzeResponse(StrictModel):
    session_id: str
    frame_id: int
    status: Literal['ok', 'uncertain', 'error']
    events: list[Observation] = Field(default_factory=list)
    speech: Speech | None = None
    latency_ms: int = 0
    error_code: str | None = None
    message: str | None = None

