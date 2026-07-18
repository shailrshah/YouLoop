import { mount, unmount } from 'svelte';
import Panel from '@/lib/components/Panel.svelte';
import { onVideoChange } from '@/lib/player/navigation';
import { findVideo } from '@/lib/player/video';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  // 'ui' bundles the component CSS and injects it INTO the shadow root created
  // by createShadowRootUi (page-injected CSS can't cross the shadow boundary).
  cssInjectionMode: 'ui',
  async main(ctx) {
    let ui: Awaited<ReturnType<typeof createShadowRootUi>> | null = null;
    let app: Record<string, any> | null = null;
    let currentVideoId: string | null = null;
    let anchorObserver: MutationObserver | null = null;

    const remove = () => {
      if (app) {
        unmount(app);
        app = null;
      }
      ui?.remove();
      ui = null;
      anchorObserver?.disconnect();
      anchorObserver = null;
    };

    // If YouTube replaces the #below subtree (ad break exit, layout switch),
    // the shadow root gets orphaned. Watch and remount when that happens.
    const watchAnchor = (host: Element, videoId: string) => {
      anchorObserver?.disconnect();
      anchorObserver = new MutationObserver(() => {
        if (!host.isConnected) {
          remove();
          if (location.pathname === '/watch') void retry(videoId);
        }
      });
      const parent = host.parentNode as Node | null;
      if (parent) anchorObserver.observe(parent, { childList: true });
    };

    const create = async (videoId: string): Promise<boolean> => {
      const video = findVideo();
      const anchor = document.querySelector('#below');
      if (!video || !anchor) return false;

      ui = await createShadowRootUi(ctx, {
        name: 'youloop-root',
        position: 'inline',
        anchor: '#below',
        append: 'first',
        onMount: (container) => {
          app = mount(Panel, { target: container, props: { videoId, video } });
        },
        onRemove: () => {
          if (app) {
            unmount(app);
            app = null;
          }
        },
      });
      ui.mount();
      // ui.shadowHost isn't part of WXT's public typings; fall back to the
      // first-child assumption if it's not exposed.
      const host = (ui as unknown as { shadowHost?: Element }).shadowHost
        ?? (anchor.firstElementChild as Element | null);
      if (host) watchAnchor(host, videoId);
      return true;
    };

    const retry = async (videoId: string, tries = 0) => {
      if (currentVideoId !== videoId) return; // navigated away mid-retry
      if (await create(videoId)) return;
      if (tries < 20) setTimeout(() => void retry(videoId, tries + 1), 500);
    };

    onVideoChange((videoId) => {
      currentVideoId = videoId;
      remove();
      if (videoId && location.pathname === '/watch') void retry(videoId);
    });
  },
});
