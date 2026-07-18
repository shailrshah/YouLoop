import type { Loop } from './model';

// preservesPitch is standard on Chrome and Firefox 104+; older Firefox used
// mozPreservesPitch. Cover both without touching an undeclared property.
type PitchableVideo = HTMLVideoElement & { mozPreservesPitch?: boolean };
function setPreservesPitch(v: HTMLVideoElement, on: boolean): void {
  const pv = v as PitchableVideo;
  if ('preservesPitch' in v) pv.preservesPitch = on;
  else if ('mozPreservesPitch' in v) pv.mozPreservesPitch = on;
}
function getPreservesPitch(v: HTMLVideoElement): boolean {
  const pv = v as PitchableVideo;
  if ('preservesPitch' in v) return pv.preservesPitch;
  if ('mozPreservesPitch' in v) return pv.mozPreservesPitch ?? true;
  return true;
}

export interface EngineCallbacks {
  onRepChange?: (current: number, total: number | null) => void;
  onExit?: (loopId: string) => void;
  onPlayCount?: (loopId: string) => void;
}

/**
 * Drives loop playback on a single <video> element:
 *  - wraps at endTime (infinite) or counts reps then exits (finite)
 *  - clip key: seek to active loop start, keep playing
 *  - applies per-loop speed on activation, restores ambient rate on exit
 *    (never overrides YouTube's global speed persistently)
 *  - auto-exits when the user manually seeks outside the loop range
 */
export class LoopEngine {
  private active: Loop | null = null;
  private currentRep = 0;
  private ambientRate = 1;
  private rafId: number | null = null;
  private pendingSelfSeeks = 0; // seeks we initiated; onSeeking should ignore them
  private wrapArmed = true; // false right after a wrap-seek, until we observe currentTime < endTime again

  constructor(
    private video: HTMLVideoElement,
    private cb: EngineCallbacks = {},
  ) {
    this.tick = this.tick.bind(this);
    this.onSeeking = this.onSeeking.bind(this);
    this.video.addEventListener('seeking', this.onSeeking);
  }

  get activeLoop(): Loop | null {
    return this.active;
  }

  /**
   * Record a user-driven playback-rate change so that when the active loop
   * exits, we restore this new rate (not the pre-activation one). No-op if no
   * loop is active — the caller will have already set video.playbackRate.
   */
  setAmbientRate(rate: number): void {
    this.ambientRate = rate;
  }

  /** Reset the current-rep counter (call after changing repeatCount mid-play). */
  resetRep(): void {
    this.currentRep = 0;
    if (this.active) this.cb.onRepChange?.(0, this.active.repeatCount);
  }

  activate(loop: Loop): void {
    this.ambientRate = this.video.playbackRate;
    this.active = loop;
    this.currentRep = 0;
    this.wrapArmed = true;
    setPreservesPitch(this.video, true);
    this.video.playbackRate = loop.speed || 1;
    if (
      this.video.currentTime < loop.startTime ||
      this.video.currentTime > loop.endTime
    ) {
      this.pendingSelfSeeks++;
      this.video.currentTime = loop.startTime;
    }
    this.cb.onRepChange?.(this.currentRep, loop.repeatCount);
    this.start();
  }

  deactivate(restoreRate = true): void {
    if (!this.active) return;
    const id = this.active.id;
    this.active = null;
    this.stop();
    if (restoreRate) this.video.playbackRate = this.ambientRate;
    this.cb.onExit?.(id);
  }

  /** Clip key `0`: jump to active loop start and keep playing. No-op if idle. */
  clipToStart(): void {
    if (!this.active) return;
    this.pendingSelfSeeks++;
    this.video.currentTime = this.active.startTime;
    void this.video.play();
  }

  /**
   * Merge a partial update into the active loop, if it matches. Callers pass
   * only the fields they changed so we never overwrite the engine's view with
   * a stale copy of the rest of the loop.
   */
  syncActive(id: string, patch: Partial<Loop>): void {
    if (this.active && this.active.id === id) {
      this.active = { ...this.active, ...patch };
      if (patch.speed != null) this.video.playbackRate = this.active.speed || 1;
      this.start(); // in case the tick had exited early on a prior degenerate range
    }
  }

  destroy(): void {
    this.stop();
    this.video.removeEventListener('seeking', this.onSeeking);
  }

  private start(): void {
    if (this.rafId == null) this.rafId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private onSeeking(): void {
    if (!this.active) return;
    if (this.pendingSelfSeeks > 0) {
      this.pendingSelfSeeks--;
      return;
    }
    const t = this.video.currentTime;
    if (t < this.active.startTime - 0.05 || t > this.active.endTime + 0.05) {
      this.deactivate(); // manual seek outside range -> auto-exit
    }
  }

  private tick(): void {
    const loop = this.active;
    if (!loop) {
      this.rafId = null;
      return;
    }
    if (loop.endTime <= loop.startTime) {
      // Degenerate range would trigger every frame — pause instead of thrashing.
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    // Re-assert pitch preservation — YouTube ads / quality switches can flip
    // it off, giving chipmunk audio for the rest of the loop.
    if (!getPreservesPitch(this.video)) setPreservesPitch(this.video, true);

    const t = this.video.currentTime;
    // Re-arm the wrap trigger once we've observed playback inside the loop
    // again. Without this, the browser's async seek can leave currentTime past
    // endTime for one or two frames after our wrap-seek, so the tick would
    // count multiple completions per lap.
    if (!this.wrapArmed && t < loop.endTime - 0.05) this.wrapArmed = true;
    if (this.wrapArmed && t >= loop.endTime) {
      this.wrapArmed = false;
      this.cb.onPlayCount?.(loop.id); // completed a pass
      if (loop.repeatCount != null) {
        this.currentRep += 1;
        this.cb.onRepChange?.(this.currentRep, loop.repeatCount);
        if (this.currentRep >= loop.repeatCount) {
          this.deactivate(); // last rep done -> exit, continue past endTime
          return;
        }
      }
      this.pendingSelfSeeks++;
      this.video.currentTime = loop.startTime;
      // Re-assert in case YouTube (ads, quality switches) reset either.
      setPreservesPitch(this.video, true);
      if (this.video.playbackRate !== (loop.speed || 1)) {
        this.video.playbackRate = loop.speed || 1;
      }
    }
    this.rafId = requestAnimationFrame(this.tick);
  }
}
