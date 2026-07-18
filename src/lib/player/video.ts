export function findVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
}

export function currentVideoId(): string | null {
  const m =
    location.href.match(/[?&]v=([^&]+)/) ||
    location.pathname.match(/\/embed\/([^/?]+)/);
  return m ? m[1] : null;
}

/**
 * Scrape title/channel for the video currently identified in the URL. Returns
 * empty strings if the DOM still shows a stale/placeholder title (e.g. right
 * after a SPA navigation), so the caller can retry or skip persisting.
 */
export function scrapeVideoInfo(expectedVideoId?: string): { title: string; channel: string } {
  if (expectedVideoId && currentVideoId() !== expectedVideoId) {
    return { title: '', channel: '' };
  }
  const title =
    (document.querySelector('#title h1, h1.ytd-watch-metadata') as HTMLElement)
      ?.innerText?.trim() || document.title.replace(/ - YouTube$/, '').trim();
  const channel =
    (document.querySelector('#owner #channel-name a, ytd-channel-name a') as HTMLElement)
      ?.innerText?.trim() || '';
  // Guard against YouTube's own placeholders.
  if (!title || title === 'YouTube' || /^loading/i.test(title)) {
    return { title: '', channel };
  }
  return { title, channel };
}
