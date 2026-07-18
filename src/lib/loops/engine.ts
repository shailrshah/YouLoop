import type { Loop } from './model';

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
  private wrapGuard = false; // true while we perform our own wrap-seek

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

  activate(loop: Loop): void {
    this.ambientRate = this.video.playbackRate;
    this.active = loop;
    this.currentRep = 0;
    this.video.preservesPitch = true;
    this.video.playbackRate = loop.speed || 1;
    if (
      this.video.currentTime < loop.startTime ||
      this.video.currentTime > loop.endTime
    ) {
      this.wrapGuard = true;
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
    this.wrapGuard = true;
    this.video.currentTime = this.active.startTime;
    void this.video.play();
  }

  /** Call if the active loop's start/end/speed changed underneath us. */
  syncActive(loop: Loop): void {
    if (this.active && this.active.id === loop.id) {
      this.active = loop;
      this.video.playbackRate = loop.speed || 1;
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
    if (this.wrapGuard) {
      this.wrapGuard = false;
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
    if (this.video.currentTime >= loop.endTime) {
      this.cb.onPlayCount?.(loop.id); // completed a pass
      if (loop.repeatCount != null) {
        this.currentRep += 1;
        this.cb.onRepChange?.(this.currentRep, loop.repeatCount);
        if (this.currentRep >= loop.repeatCount) {
          this.deactivate(); // last rep done -> exit, continue past endTime
          return;
        }
      }
      this.wrapGuard = true;
      this.video.currentTime = loop.startTime;
    }
    this.rafId = requestAnimationFrame(this.tick);
  }
}
