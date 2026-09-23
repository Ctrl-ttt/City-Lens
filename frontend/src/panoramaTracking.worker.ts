import { PanoramaTracker } from './panoramaTracking';
import type { TrackingInput, TrackingOutput } from './panoramaTracking';

// One tracker/history per worker. Capture, backpressure, and termination belong to the caller.
const tracker = new PanoramaTracker();
const send = (message: TrackingOutput): void => self.postMessage(message);
self.onmessage = (event: MessageEvent<TrackingInput>): void => {
  const input = event.data;
  if (input.type === 'frame') {
    const snapshot = tracker.addFrame(input.frame);
    send({ type: 'ack', id: input.frame.id });
    if (snapshot) send({ type: 'snapshot', snapshot });
  } else if (input.type === 'result') {
    send({ type: 'snapshot', snapshot: tracker.resolve(input) });
  }
};
