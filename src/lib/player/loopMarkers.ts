import type { Loop } from '@/lib/loops/model';

const CONTAINER_ID = 'youloop-markers';

/**
 * Overlays a translucent band on YouTube's progress bar spanning the active
 * loop's start/end. The band is a child of `.ytp-progress-bar-container` so it
 * inherits the container's width and layers above the scrubber's fill.
 *
 * Positions are percentages of `video.duration`. YouTube's chrome sometimes
 * re-renders the progress-bar subtree (fullscreen toggle, quality switch),
 * so a MutationObserver on the player re-parents the overlay if needed.
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
    'pointer-events: none', // never eat clicks — YouTube's scrubber must stay clickable
    'display: none',
    'z-index: 40',
  ].join(';');

  const band = document.createElement('div');
  band.style.cssText = [
    'position: absolute',
    'top: 0',
    'bottom: 0',
    // Yellow reads clearly on top of both YouTube's red played fill and the
    // grey unplayed track; blue got muddy over red.
    'background: rgba(255, 225, 74, 0.35)',
    'border-left: 2px solid #ffe14a',
    'border-right: 2px solid #ffe14a',
    'box-sizing: border-box',
  ].join(';');
  overlay.appendChild(band);

  let active: Loop | null = null;
  let mounted = false;

  const findContainer = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.ytp-progress-bar-container');

  const mount = () => {
    if (mounted && overlay.isConnected) return;
    const host = findContainer();
    if (!host) return;
    // Ensure the host is a positioning context. It is by default in YouTube's
    // styles, but re-assert defensively without overriding an existing value.
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(overlay);
    mounted = true;
    render();
  };

  const render = () => {
    if (!active || !Number.isFinite(video.duration) || video.duration <= 0) {
      overlay.style.display = 'none';
      return;
    }
    const dur = video.duration;
    const startPct = Math.max(0, Math.min(100, (active.startTime / dur) * 100));
    const endPct = Math.max(0, Math.min(100, (active.endTime / dur) * 100));
    band.style.left = `${startPct}%`;
    band.style.width = `${Math.max(0, endPct - startPct)}%`;
    overlay.style.display = 'block';
  };

  // Re-parent when YouTube swaps out the progress bar (fullscreen, layout).
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
      mount(); // in case the container didn't exist earlier
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
