"""Explicit, paid video evaluation. Results stay in ignored work/, never uploaded whole.

Install optional decoder: python -m pip install -r scripts/video-requirements.txt
Run from repository root: python -m scripts.evaluate_video --help
"""
import argparse
import asyncio
from dataclasses import replace
import io
import json
from pathlib import Path
import time

import av
import httpx
from PIL import Image

from backend.app import load_settings
from backend.models import AnalyzeInput
from backend.panorama import prepare_panorama
from backend.rules import summarize
from backend.spatial import SpatialSessions
from backend.vision import observe, VisionError


def extract(path, seconds, stream_index, max_side=960):
    with av.open(str(path)) as container:
        stream = container.streams.video[stream_index]
        container.seek(int(seconds / stream.time_base), stream=stream)
        for frame in container.decode(stream):
            if frame.time is not None and frame.time >= seconds:
                image = frame.to_image()
                image.thumbnail((max_side,max_side))
                out=io.BytesIO(); image.save(out,format='JPEG',quality=80)
                return out.getvalue(), image.size, float(frame.time)
    raise ValueError('Requested timestamp is beyond the video')


async def run(args):
    config = load_settings()
    if args.model:
        config = replace(config,model=args.model)
    if config.provider == 'sample' or not config.http_configured:
        raise SystemExit('Configure a live HTTP model in .env; fixed samples are not evaluation.')
    raw = args.video.suffix.lower() == '.insv'
    if raw and args.projection == 'equirectangular':
        raise SystemExit('Raw INSV is dual fisheye. Export a stitched 2:1 panorama MP4 first.')
    if raw:
        config = replace(config,camera_hfov_deg=180)  # Never apply pinhole range to raw fisheye.
    destination = Path('work/panorama-check') / args.name
    destination.mkdir(parents=True,exist_ok=True)
    rows=[]; trackers={}; timings=[]
    async with httpx.AsyncClient(timeout=config.timeout) as client:
        for seconds in args.times:
            for stream in args.streams:
                data,size,actual=extract(args.video,seconds,stream,1920 if args.projection=='equirectangular' else 960)
                meta=AnalyzeInput(session_id=f'eval-{stream}',frame_id=len(rows)+1,mode='walk',source='video',
                                  projection=args.projection,heading_deg=args.heading)
                if args.save_frames:
                    (destination/f'{actual:.2f}-stream-{stream}.jpg').write_bytes(data)
                started=time.perf_counter()
                row={'video_seconds':actual,'stream':stream}
                try:
                    prepared=prepare_panorama(data,meta) if args.projection=='equirectangular' else data
                    result=await observe(prepared,'walk',config,client,panorama=args.projection=='equirectangular')
                    tracker=trackers.setdefault(stream,SpatialSessions())
                    spatial,recent=tracker.process(meta,result,*size,config,actual)
                    response=summarize(meta,result,recent,now=actual,repeat_seconds=config.speech_repeat_seconds,spatial=spatial)
                    row['analysis']=response.model_dump()
                except VisionError as e:
                    row['error']=e.code
                row['seconds']=round(time.perf_counter()-started,3)
                row['within_live_deadline']=row['seconds']<=6 and 'error' not in row
                rows.append(row);timings.append(row['seconds'])
                print(json.dumps({'at':round(actual,2),'stream':stream,'seconds':row['seconds'],
                                  'error':row.get('error'),'events':len(row.get('analysis',{}).get('events',[])),
                                  'within_live_deadline':row['within_live_deadline']}),flush=True)
                (destination/'results.json').write_text(json.dumps({'model':config.model,'projection':args.projection,
                    'raw_fisheye':raw,'limitations':'Raw fisheye directions are not calibrated; tests are not accuracy or safety validation.',
                    'rows':rows},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'requests':len(rows),'successful':sum('error' not in r for r in rows),
                      'within_live_deadline':sum(r['within_live_deadline'] for r in rows),
                      'output':str(destination/'results.json')}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video',type=Path)
    parser.add_argument('--projection',choices=['rectilinear','equirectangular'],default='rectilinear')
    parser.add_argument('--times',nargs='+',type=float,default=[5,7,9])
    parser.add_argument('--streams',nargs='+',type=int,default=[0])
    parser.add_argument('--heading',type=int,default=0)
    parser.add_argument('--model')
    parser.add_argument('--name',default='video-evaluation')
    parser.add_argument('--save-frames',action='store_true',help='Explicitly save selected frames locally for visual verification.')
    args=parser.parse_args()
    if Path(args.name).name != args.name or args.name in {'.','..'}:
        parser.error('--name must be a simple directory name')
    if any(t<0 for t in args.times) or any(i<0 for i in args.streams):
        parser.error('Timestamps and stream indices must not be negative')
    asyncio.run(run(args))
