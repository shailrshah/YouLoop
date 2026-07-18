const BUTTON_ID = 'youloop-toggle';

export interface PlayerButtonHandle {
  setCollapsed(collapsed: boolean): void;
  setLoopCount(n: number): void;
  destroy(): void;
}

/**
 * Injects a "YL" toggle button into YouTube's `.ytp-right-controls` just
 * before the fullscreen button. Clicking it toggles the panel's collapsed
 * state (mirrored to the caller). Re-injects on player-subtree re-renders
 * (fullscreen toggle, quality change, SPA nav).
 */
export function attachPlayerButton(onToggle: () => void): PlayerButtonHandle {
  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.className = 'ytp-button';
  btn.setAttribute('aria-label', 'Toggle YouLoop panel');
  btn.title = 'Toggle YouLoop panel';
  btn.style.cssText = [
    // Match YouTube's own control buttons: white glyph, opacity-driven hover,
    // no background so it blends into the controls bar.
    'display: inline-flex',
    'align-items: center',
    'justify-content: center',
    'height: 100%',
    'width: 48px',
    'padding: 0',
    'background: transparent',
    'border: 0',
    'color: white',
    'font: 500 11px/1 "Roboto","Arial",sans-serif',
    'cursor: pointer',
    'opacity: 0.9',
    'vertical-align: top',
    'gap: 2px',
  ].join(';');

  // Circular loop icon: two curved arrows chasing each other around a ring.
  // Reads more clearly as "loop" than the angular repeat glyph.
  btn.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="white" aria-hidden="true">
      <path d="M12 5V2L7.5 6.5 12 11V7.5a4.5 4.5 0 0 1 4.5 4.5 4.5 4.5 0 0 1-.44 1.94l1.55 1.55A6.98 6.98 0 0 0 19 12 7 7 0 0 0 12 5Z"/>
      <path d="M12 19v3l4.5-4.5L12 13v3.5A4.5 4.5 0 0 1 7.5 12c0-.68.15-1.32.44-1.9L6.4 8.55A6.98 6.98 0 0 0 5 12a7 7 0 0 0 7 7Z"/>
    </svg>
  `;

  // Tiny loop-count badge in the top-right of the button, styled to match
  // YouTube's own "HD" badge next to the settings gear.
  const count = document.createElement('span');
  count.style.cssText = [
    'position: absolute',
    'top: 4px',
    'right: 2px',
    'min-width: 10px',
    'height: 9px',
    'padding: 0 2px',
    'background: #f00',
    'color: #fff',
    'font: 700 7px/9px "Roboto","Arial",sans-serif',
    'border-radius: 2px',
    'text-align: center',
    'letter-spacing: 0.2px',
    'display: none',
  ].join(';');
  btn.style.position = 'relative';
  btn.appendChild(count);

  btn.addEventListener('pointerenter', () => (btn.style.opacity = '1'));
  btn.addEventListener('pointerleave', () => (btn.style.opacity = '0.9'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
  });

  let collapsed = true;
  let loopCount = 0;
  let mounted = false;

  const setActiveVisual = () => {
    // Slight underline while the panel is expanded, to feel like an active
    // toggle without changing the icon color. Matches YouTube's monochrome
    // control aesthetic.
    btn.style.textDecoration = collapsed ? 'none' : 'underline';
    btn.style.textUnderlineOffset = '-6px';
    btn.style.textDecorationColor = '#f1f1f1';
    btn.style.textDecorationThickness = '2px';
  };

  const setCountVisual = () => {
    if (loopCount > 0) {
      count.textContent = String(loopCount);
      count.style.display = 'inline';
    } else {
      count.style.display = 'none';
    }
  };

  const mount = () => {
    if (mounted && btn.isConnected) return;
    // Anchor next to the fullscreen button so we live in the same visual
    // group. YouTube nests fullscreen inside `.ytp-right-controls-right`,
    // so insertBefore must run against the fullscreen button's actual
    // parent, not the outer `.ytp-right-controls`.
    const fs = document.querySelector<HTMLElement>('.ytp-fullscreen-button');
    if (fs?.parentElement) {
      fs.parentElement.insertBefore(btn, fs);
      mounted = true;
      setActiveVisual();
      setCountVisual();
      return;
    }
    // Fallback: append to the outer right-controls if the fullscreen button
    // isn't there (e.g. YouTube's chrome hasn't fully rendered yet).
    const host = document.querySelector<HTMLElement>('.ytp-right-controls');
    if (host) {
      host.appendChild(btn);
      mounted = true;
      setActiveVisual();
      setCountVisual();
    }
  };

  // Re-mount when YouTube swaps out the controls subtree, and keep trying if
  // the anchor didn't exist yet at construction (the player controls often
  // render after #below, which is where the panel already mounted).
  const observer = new MutationObserver(() => {
    if (!mounted || !btn.isConnected) {
      mounted = false;
      mount();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const retryUntilMounted = (tries = 0) => {
    mount();
    if (!mounted && tries < 20) {
      setTimeout(() => retryUntilMounted(tries + 1), 500);
    }
  };
  retryUntilMounted();

  return {
    setCollapsed(next: boolean) {
      collapsed = next;
      setActiveVisual();
    },
    setLoopCount(n: number) {
      loopCount = n;
      setCountVisual();
    },
    destroy() {
      observer.disconnect();
      btn.remove();
    },
  };
}
