import { currentVideoId } from './video';

type Handler = (videoId: string | null) => void;

/**
 * Fire cb on initial load and on every YouTube SPA navigation / video change.
 * YouTube swaps videos without a full reload, so we listen for its own
 * `yt-navigate-finish` event plus a URL poll fallback.
 */
export function onVideoChange(cb: Handler): () => void {
  let last: string | null | undefined;
  const fire = () => {
    const id = currentVideoId();
    if (id !== last) {
      last = id;
      cb(id);
    }
  };
  const onNav = () => setTimeout(fire, 300);
  window.addEventListener('yt-navigate-finish', onNav as EventListener);
  const iv = window.setInterval(fire, 1000);
  fire();
  return () => {
    window.removeEventListener('yt-navigate-finish', onNav as EventListener);
    clearInterval(iv);
  };
}
