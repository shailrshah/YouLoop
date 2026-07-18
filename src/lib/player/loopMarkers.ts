import type { Loop } from '@/lib/loops/model';

const CONTAINER_ID = 'youloop-markers';
const MIN_LOOP = 0.1; // seconds; kept in sync with Panel.svelte

export interface MarkerCallbacks {
  /** Live update as the user drags a pin. Feed to engine.syncActive. */
  onDrag?: (id: string, kind: 'startTime' | 'endTime', time: number) => void;
  /** Final commit on drag end. Feed to updateLoop. */
  onCommit?: (id: string, kind: 'startTime' | 'endTime', time: number) => void;
}

/**
 * Overlays draggable A/B pins on YouTube's progress bar to mark the active
 * loop's boundaries (and the pending A-mark during A/B capture).
 *
 * Pin flags are interactive hitboxes — pointerdown starts a drag, pointermove
 * translates mouse X within `.ytp-progress-bar-container` into a new time,
 * pointerup commits. The rest of the overlay uses `pointer-events: none` so
 * YouTube's scrubber stays fully clickable.
 *
 * YouTube sometimes re-renders the progress-bar subtree (fullscreen, quality
 * switch), so a MutationObserver re-parents the overlay if needed.
 */
export function attachLoopMarkers(video: HTMLVideoElement, cb: MarkerCallbacks = {}) {
  const overlay = document.createElement('div');
  overlay.id = CONTAINER_ID;
  overlay.style.cssText = [
    'position: absolute',
    'top: 0',
    'bottom: 0',
    'left: 0',
    'right: 0',
    'pointer-events: none', // children opt in individually
    'z-index: 100',
  ].join(';');

  // Build a labeled pin: vertical stem drops below the progress bar with a
  // draggable flag holding a single-letter glyph. The flag alone captures
  // pointer events so the stem doesn't shadow YouTube's scrubber.
  const makePin = (label: 'A' | 'B') => {
    const pin = document.createElement('div');
    pin.style.cssText = [
      'position: absolute',
      'top: -2px',
      'bottom: -14px',
      'width: 2px',
      'background: #22c55e',
      'transform: translateX(-1px)', // center the stem on the mark
      'display: none',
      'pointer-events: none',
    ].join(';');
    const flag = document.createElement('div');
    flag.textContent = label;
    flag.style.cssText = [
      'position: absolute',
      'left: 1px',
      'bottom: -12px',
      'transform: translateX(-50%)',
      'background: #22c55e',
      'color: #062d10',
      'font: 700 9px/1 "Roboto","Arial",sans-serif',
      'padding: 2px 5px 3px',
      'border-radius: 3px',
      'letter-spacing: 0.3px',
      'box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5)',
      'cursor: ew-resize',
      'pointer-events: auto',
      'user-select: none',
      'touch-action: none',
    ].join(';');
    pin.appendChild(flag);
    return { pin, flag };
  };

  const a = makePin('A');
  const b = makePin('B');
  overlay.appendChild(a.pin);
  overlay.appendChild(b.pin);

  let active: Loop | null = null;
  let pendingTime: number | null = null;
  let dragging: {
    id: string;
    kind: 'startTime' | 'endTime';
    otherTime: number; // fixed boundary — start when dragging end, end when dragging start
  } | null = null;
  let mounted = false;

  const findContainer = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.ytp-progress-bar-container');

  const mount = () => {
    if (mounted && overlay.isConnected) return;
    const host = findContainer();
    if (!host) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(overlay);
    mounted = true;
    render();
  };

  const pctOf = (t: number, dur: number) =>
    Math.max(0, Math.min(100, (t / dur) * 100));

  const showPin = (pin: HTMLElement, time: number, dur: number) => {
    pin.style.left = `${pctOf(time, dur)}%`;
    pin.style.display = 'block';
  };

  const render = () => {
    const dur = video.duration;
    a.pin.style.display = 'none';
    b.pin.style.display = 'none';
    if (!Number.isFinite(dur) || dur <= 0) return;

    if (pendingTime != null) {
      showPin(a.pin, pendingTime, dur);
    } else if (active) {
      showPin(a.pin, active.startTime, dur);
      showPin(b.pin, active.endTime, dur);
    }
  };

  // Translate a clientX (from a pointer event) into a time in seconds within
  // the progress bar's coordinate space, clamped to the video's duration.
  const clientXToTime = (clientX: number): number | null => {
    const host = findContainer();
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return null;
    const raw = ((clientX - rect.left) / rect.width) * dur;
    return Math.max(0, Math.min(dur, raw));
  };

  const startDrag = (kind: 'startTime' | 'endTime') => (e: PointerEvent) => {
    if (!active) return;
    // Stop YouTube's scrubber from seeing this pointerdown — it would grab
    // the pointer and start seeking the video instead.
    e.preventDefault();
    e.stopPropagation();
    const flag = e.currentTarget as HTMLElement;
    flag.setPointerCapture(e.pointerId);
    dragging = {
      id: active.id,
      kind,
      otherTime: kind === 'startTime' ? active.endTime : active.startTime,
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const t = clientXToTime(e.clientX);
    if (t == null) return;
    const clamped =
      dragging.kind === 'startTime'
        ? Math.min(dragging.otherTime - MIN_LOOP, t)
        : Math.max(dragging.otherTime + MIN_LOOP, t);
    // Update the visual immediately so the pin follows the cursor even if
    // the store hasn't round-tripped yet, then let the callback update the
    // underlying loop (which will render() with the new value).
    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 0) {
      showPin(dragging.kind === 'startTime' ? a.pin : b.pin, clamped, dur);
    }
    cb.onDrag?.(dragging.id, dragging.kind, clamped);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    const t = clientXToTime(e.clientX);
    const clamped =
      t == null
        ? null
        : dragging.kind === 'startTime'
          ? Math.min(dragging.otherTime - MIN_LOOP, t)
          : Math.max(dragging.otherTime + MIN_LOOP, t);
    if (clamped != null) cb.onCommit?.(dragging.id, dragging.kind, clamped);
    dragging = null;
  };

  a.flag.addEventListener('pointerdown', startDrag('startTime'));
  b.flag.addEventListener('pointerdown', startDrag('endTime'));
  // Listen on document so the drag survives the cursor leaving the flag.
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);

  const bodyObserver = new MutationObserver(() => {
    if (!overlay.isConnected) {
      mounted = false;
      mount();
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  const onDurationChange = () => render();
  video.addEventListener('durationchange', onDurationChange);
  video.addEventListener('loadedmetadata', onDurationChange);

  mount();

  return {
    setActive(loop: Loop | null) {
      active = loop;
      mount();
      render();
    },
    setPending(time: number | null) {
      pendingTime = time;
      mount();
      render();
    },
    destroy() {
      bodyObserver.disconnect();
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('loadedmetadata', onDurationChange);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      overlay.remove();
    },
  };
}

export type LoopMarkers = ReturnType<typeof attachLoopMarkers>;
