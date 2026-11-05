// the contract a streaming source keeps with the app that drives it (phosphorus's
// AppSession): opened once with the viewer's window, then asked for videos, keyframes
// and input until it quits. AfterglowSource keeps it; the driver declares its own copy
// and TypeScript checks the two agree

export type Start = {
  argv: string[];
  name: string;
  // the viewer's window in device pixels, the screen it may grow to, its pixel ratio
  w: number;
  h: number;
  sw: number;
  sh: number;
  scale: number;
  full: boolean;
  fps?: number;
};

// what a source starts with: the start, its sizes kept to what's allowed
export type Opened = Start & { dpi: number };

// fps 0: the source's own choice
export type Video = { w: number; h: number; fps: number; kbps: number; full: boolean };

// the bytes in front of a frame handed on with room: the driver writes its own
// header there and sends the frame as it is
export const FrameRoom = 8;

// one run of the video: stale once the driver starts another
export interface VideoSink {
  config(avcc: Uint8Array, w: number, h: number): void;
  // data is AVCC; with room, data[0..FrameRoom) is free for a header and the rest is AVCC
  frame(key: boolean, data: Uint8Array, room?: boolean): void;
  // the video stopped by itself; got: whether it ever made a frame
  ended(got: boolean): void;
}

// what a source tells the driver besides frames
export interface Sink {
  // title, windows, cursor: kept and replayed to a viewer that comes later
  meta(m: { t: string } & Record<string, unknown>): void;
  // clip, note: to the viewer now, if there is one
  say(m: { t: string } & Record<string, unknown>): void;
  // the app is gone
  exit(error: string, log?: string, code?: number): void;
}

export interface Source {
  // a keyframe can be asked of the running video; otherwise a fresh video makes one
  readonly keyframes: boolean;
  // the encoder's name for the viewer's stats
  readonly label: string;
  // the least time between two fresh videos: what one costs the host to start
  readonly restartGapMs?: number;
  open(s: Opened, sink: Sink): Promise<void>;
  // a fresh video at this size and rate, replacing any running; its first frame a keyframe
  video(v: Video, sink: VideoSink): void;
  stopVideo(): void;
  keyframe(): void;
  // one input message from the viewer, already checked as an array; w, h the video's size
  input(m: unknown[], w: number, h: number): void;
  // the viewer's window resized: the app's to match (the video restarts after)
  resize(w: number, h: number): void;
  // the app asked to close, politely: it may ask to save first
  close(): void;
  // everything ended
  quit(): void;
}
