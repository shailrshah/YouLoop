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
    // The extension can be reloaded (dev cycle) while our code still holds
    // browser.* handles or in-flight WXT internals. Any resulting throw would
    // surface as "Extension context invalidated" in the tab's console until
    // the user refreshes. Swallow those quietly at the window level so dev
    // reloads don't spam an error the user can't act on.
    const onUnhandled = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '');
      if (/context invalidated/i.test(msg)) e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    ctx.onInvalidated(() => window.removeEventListener('unhandledrejection', onUnhandled));

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

    const isContextInvalidated = (err: unknown): boolean =>
      err instanceof Error && /context invalidated/i.test(err.message);

    const create = async (videoId: string): Promise<boolean> => {
      const video = findVideo();
      const anchor = document.querySelector('#below');
      if (!video || !anchor) return false;

      try {
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
      } catch (err) {
        // The extension can be reloaded (dev cycle or uninstall) while a
        // retry() is mid-await. Swallow context-invalidated errors so we
        // don't emit an unhandled rejection to the console.
        if (isContextInvalidated(err)) return true;
        throw err;
      }
      // ui.shadowHost isn't part of WXT's public typings; fall back to the
      // first-child assumption if it's not exposed.
      const host = (ui as unknown as { shadowHost?: Element }).shadowHost
        ?? (anchor.firstElementChild as Element | null);
      if (host) watchAnchor(host, videoId);
      return true;
    };

    const retry = async (videoId: string, tries = 0) => {
      if (currentVideoId !== videoId) return; // navigated away mid-retry
      try {
        if (await create(videoId)) return;
      } catch (err) {
        if (isContextInvalidated(err)) return; // extension reloaded; stop.
        throw err;
      }
      if (tries < 20) setTimeout(() => void retry(videoId, tries + 1), 500);
    };

    onVideoChange((videoId) => {
      currentVideoId = videoId;
      remove();
      if (videoId && location.pathname === '/watch') void retry(videoId);
    });
  },
});
