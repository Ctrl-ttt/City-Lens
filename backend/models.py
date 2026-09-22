from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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

    @model_validator(mode='after')
    def check_label(self):
        if self.label not in LABELS or LABELS[self.label][0] != self.category:
            raise ValueError('unsupported observation')
        if self.category == 'text':
            self.text = ' '.join(self.text.split())
            if not self.text:
                raise ValueError('empty sign')
        else:
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

