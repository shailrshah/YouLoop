export function findVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
}

export function currentVideoId(): string | null {
  const m =
    location.href.match(/[?&]v=([^&]+)/) ||
    location.pathname.match(/\/embed\/([^/?]+)/);
  return m ? m[1] : null;
}

export function scrapeVideoInfo(): { title: string; channel: string } {
  const title =
    (document.querySelector('#title h1, h1.ytd-watch-metadata') as HTMLElement)
      ?.innerText?.trim() || document.title.replace(/ - YouTube$/, '');
  const channel =
    (document.querySelector('#owner #channel-name a, ytd-channel-name a') as HTMLElement)
      ?.innerText?.trim() || '';
  return { title, channel };
}
