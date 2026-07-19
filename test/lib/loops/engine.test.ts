import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopEngine } from '@/lib/loops/engine';
import type { Loop } from '@/lib/loops/model';

// -------- Fake HTMLVideoElement --------
//
// The engine only touches these properties/events on the video:
//   currentTime, playbackRate, preservesPitch, addEventListener('seeking'),
//   removeEventListener('seeking'), play(), duration (read only for the
//   degenerate-range branch — we hard-code a value).
// So a plain object with a `seeking` dispatcher is enough; no jsdom needed.

interface FakeVideo extends Pick<HTMLVideoElement, 'currentTime' | 'playbackRate' | 'preservesPitch'> {
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  play: () => Promise<void>;
  // Test hook: pretend `currentTime` advanced by playback (does NOT fire
  // seeking — that only happens on seeks).
  advance: (delta: number) => void;
  // Test hook: pretend the user manually seeked (fires `seeking`).
  userSeek: (t: number) => void;
}

function makeVideo(): FakeVideo {
  let currentTime = 0;
  let playbackRate = 1;
  let preservesPitch = true;
  const listeners = new Map<string, Set<() => void>>();
  const fire = (type: string) => {
    for (const cb of listeners.get(type) ?? []) cb();
  };
  const video: FakeVideo = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(t: number) {
      currentTime = t;
      fire('seeking');
    },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(r: number) {
      playbackRate = r;
    },
    get preservesPitch() {
      return preservesPitch;
    },
    set preservesPitch(v: boolean) {
      preservesPitch = v;
    },
    addEventListener(type, cb) {
      let s = listeners.get(type);
      if (!s) listeners.set(type, (s = new Set()));
      s.add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    async play() {},
    advance(delta) {
      // Setter dispatches `seeking`, so bypass it by mutating the closure
      // directly — organic playback advance shouldn't trip our own seek
      // handler.
      currentTime += delta;
    },
    userSeek(t) {
      // Same closure trick to bypass the setter's dispatch, then fire
      // `seeking` ourselves so the engine can't tell our own wraps apart
      // from real user seeks by anything other than destination.
      currentTime = t;
      fire('seeking');
    },
  };
  return video;
}

// -------- rAF harness --------
//
// The engine schedules its next tick with requestAnimationFrame. In tests we
// want to control ticks exactly, so we stub rAF to a queue and drain it via
// `tick()`.

let rafQueue: Array<() => void> = [];
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  rafQueue = [];
  let nextId = 1;
  const pending = new Map<number, () => void>();
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    const id = nextId++;
    const wrapped = () => {
      pending.delete(id);
      cb(0);
    };
    pending.set(id, wrapped);
    rafQueue.push(wrapped);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    const w = pending.get(id);
    if (w) {
      pending.delete(id);
      rafQueue = rafQueue.filter((x) => x !== w);
    }
  }) as typeof cancelAnimationFrame;
});
afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    const cb = rafQueue.shift();
    if (!cb) return;
    cb();
  }
}
function drain(maxTicks = 100) {
  for (let i = 0; i < maxTicks && rafQueue.length; i++) rafQueue.shift()!();
}

// -------- Fixtures --------

const loop = (over: Partial<Loop> = {}): Loop => ({
  id: 'l1',
  videoId: 'v',
  label: 'x',
  startTime: 10,
  endTime: 20,
  speed: 1,
  pitch: 0,
  repeatCount: null,
  playCount: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

// -------- Tests --------

describe('LoopEngine', () => {
  it('activates: seeks to start and applies loop.speed', () => {
    const video = makeVideo();
    video.playbackRate = 1;
    video.currentTime = 0;
    const engine = new LoopEngine(video as unknown as HTMLVideoElement);
    engine.activate(loop({ speed: 0.5 }));
    expect(video.currentTime).toBe(10);
    expect(video.playbackRate).toBe(0.5);
    expect(engine.activeLoop?.id).toBe('l1');
    engine.destroy();
  });

  // Helper: advance the video in small chunks (each below the 1s jump
  // threshold), ticking after each step so the engine sees organic playback.
  function playForward(video: FakeVideo, seconds: number, stepSize = 0.5) {
    let remaining = seconds;
    while (remaining > 0) {
      const step = Math.min(stepSize, remaining);
      video.advance(step);
      tick();
      remaining -= step;
    }
  }

  it('wraps at endTime and increments playCount on each pass', () => {
    const video = makeVideo();
    const onPlayCount = vi.fn();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement, { onPlayCount });
    engine.activate(loop());
    expect(video.currentTime).toBe(10);
    // Play forward from 10 → 20 in small steps so the engine sees it as
    // organic playback, not a user jump.
    playForward(video, 10);
    expect(onPlayCount).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(10); // wrapped back to start
    // And once more.
    playForward(video, 10);
    expect(onPlayCount).toHaveBeenCalledTimes(2);
    engine.destroy();
  });

  it('does not multi-fire playCount within a single lap (rearm required)', () => {
    const video = makeVideo();
    const onPlayCount = vi.fn();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement, { onPlayCount });
    engine.activate(loop());
    playForward(video, 10); // organic play to endTime, wraps once
    // Same lap: currentTime is now startTime again. Additional ticks without
    // advancing past endTime must not fire again.
    tick();
    tick();
    tick();
    expect(onPlayCount).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('exits after N reps on a finite loop', () => {
    const video = makeVideo();
    const onExit = vi.fn();
    const onRepChange = vi.fn();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement, {
      onExit,
      onRepChange,
    });
    engine.activate(loop({ repeatCount: 2 }));
    // Complete rep 1.
    playForward(video, 10);
    expect(onRepChange).toHaveBeenLastCalledWith(1, 2);
    expect(onExit).not.toHaveBeenCalled();
    // Complete rep 2 → exit.
    playForward(video, 10);
    expect(onRepChange).toHaveBeenLastCalledWith(2, 2);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(engine.activeLoop).toBeNull();
    engine.destroy();
  });

  it('restores ambient rate on deactivate', () => {
    const video = makeVideo();
    video.playbackRate = 1.5; // ambient
    const engine = new LoopEngine(video as unknown as HTMLVideoElement);
    engine.activate(loop({ speed: 0.5 }));
    expect(video.playbackRate).toBe(0.5);
    engine.deactivate();
    expect(video.playbackRate).toBe(1.5);
    engine.destroy();
  });

  it('setAmbientRate updates the restored rate on exit', () => {
    const video = makeVideo();
    video.playbackRate = 1.0;
    const engine = new LoopEngine(video as unknown as HTMLVideoElement);
    engine.activate(loop({ speed: 0.5 }));
    // User bumped the header speed while a loop was active.
    engine.setAmbientRate(1.25);
    engine.deactivate();
    expect(video.playbackRate).toBe(1.25);
    engine.destroy();
  });

  it('destroy() restores ambient rate (mid-loop teardown)', () => {
    const video = makeVideo();
    video.playbackRate = 1.0;
    const engine = new LoopEngine(video as unknown as HTMLVideoElement);
    engine.activate(loop({ speed: 0.25 }));
    engine.destroy();
    // Without the deactivate-in-destroy fix this would stay at 0.25 and
    // YouTube would then persist that rate to the next video.
    expect(video.playbackRate).toBe(1.0);
  });

  it('auto-exits when the user seeks outside the range', () => {
    const video = makeVideo();
    const onExit = vi.fn();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement, { onExit });
    engine.activate(loop({ speed: 0.5 }));
    // Simulate a user click on the progress bar landing past endTime.
    video.userSeek(50);
    expect(engine.activeLoop).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('tick detects a large jump past endTime and deactivates', () => {
    // Guards the "click after end still wraps" race: even if `seeking` fires
    // after the tick, a >1s jump in currentTime tells the tick this was a
    // user seek rather than organic playback.
    const video = makeVideo();
    const onExit = vi.fn();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement, { onExit });
    engine.activate(loop());
    // Manually advance by more than the 1s jump threshold, past endTime.
    video.advance(50); // currentTime is now 60, > endTime + 0.05 and > 1s jump
    tick();
    expect(engine.activeLoop).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('idles safely on a degenerate range (start === end)', () => {
    const video = makeVideo();
    const onPlayCount = vi.fn();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement, { onPlayCount });
    engine.activate(loop({ startTime: 5, endTime: 5 }));
    drain(50);
    expect(onPlayCount).not.toHaveBeenCalled();
    engine.destroy();
  });

  it('syncActive merges only patched fields (never overwrites with stale full loop)', () => {
    const video = makeVideo();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement);
    const original = loop({ speed: 0.5, endTime: 20 });
    engine.activate(original);
    // Push a new endTime only.
    engine.syncActive('l1', { endTime: 15 });
    expect(engine.activeLoop?.endTime).toBe(15);
    // speed is unchanged — the caller passed only endTime.
    expect(engine.activeLoop?.speed).toBe(0.5);
    engine.destroy();
  });

  it('clipToStart seeks to startTime without triggering the manual-seek exit', () => {
    const video = makeVideo();
    const onExit = vi.fn();
    const engine = new LoopEngine(video as unknown as HTMLVideoElement, { onExit });
    engine.activate(loop());
    video.advance(5); // currentTime = 15, inside loop
    engine.clipToStart();
    expect(video.currentTime).toBe(10);
    expect(engine.activeLoop?.id).toBe('l1');
    expect(onExit).not.toHaveBeenCalled();
    engine.destroy();
  });
});
