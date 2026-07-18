import type { Loop } from '@/lib/loops/model';

const CONTAINER_ID = 'youloop-markers';

/**
 * Overlays A/B pins on YouTube's progress bar to mark the active loop's
 * boundaries (and the pending A-mark during A/B capture).
 *
 * Pins are children of `.ytp-progress-bar-container` and use
 * `pointer-events: none` so YouTube's scrubber stays fully clickable.
 * Positions are percentages of `video.duration`. YouTube sometimes
 * re-renders the progress-bar subtree (fullscreen, quality switch), so a
 * MutationObserver re-parents the overlay if needed.
 */
export function attachLoopMarkers(video: HTMLVideoElement) {
  const overlay = document.createElement('div');
  overlay.id = CONTAINER_ID;
  overlay.style.cssText = [
    'position: absolute',
    'top: 0',
    'bottom: 0',
    'left: 0',
    'right: 0',
    'pointer-events: none',
    // Sit above YouTube's played/buffered/hover-preview bars (all in the
    // 0–30 range) but below the scrubber knob so it stays interactive.
    'z-index: 100',
  ].join(';');

  // Build a labeled pin: vertical stem drops below the progress bar with a
  // small square flag holding a single-letter glyph. Sits below the bar so
  // it doesn't fight the scrubber knob.
  const makePin = (label: 'A' | 'B', color: string, textColor: string) => {
    const pin = document.createElement('div');
    pin.style.cssText = [
      'position: absolute',
      'top: -2px',
      'bottom: -14px',
      'width: 2px',
      `background: ${color}`,
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
      `background: ${color}`,
      `color: ${textColor}`,
      'font: 700 9px/1 "Roboto","Arial",sans-serif',
      'padding: 1px 4px 2px',
      'border-radius: 3px',
      'letter-spacing: 0.3px',
      'box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5)',
    ].join(';');
    pin.appendChild(flag);
    return pin;
  };

  // Green A pin — shown for the pending A/B state and for the active loop's start.
  const pinA = makePin('A', '#22c55e', '#062d10');
  // Green B pin — shown for the active loop's end.
  const pinB = makePin('B', '#22c55e', '#062d10');
  overlay.appendChild(pinA);
  overlay.appendChild(pinB);

  let active: Loop | null = null;
  let pendingTime: number | null = null;
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
    pinA.style.display = 'none';
    pinB.style.display = 'none';
    if (!Number.isFinite(dur) || dur <= 0) return;

    // A/B pins: active loop's start (A) and end (B), plus the pending A-mark
    // during A/B capture. Pending takes precedence — the user is mid-capture.
    if (pendingTime != null) {
      showPin(pinA, pendingTime, dur);
    } else if (active) {
      showPin(pinA, active.startTime, dur);
      showPin(pinB, active.endTime, dur);
    }
  };

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
      overlay.remove();
    },
  };
}

export type LoopMarkers = ReturnType<typeof attachLoopMarkers>;
