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

    const remove = () => {
      if (app) {
        unmount(app);
        app = null;
      }
      ui?.remove();
      ui = null;
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
      return true;
    };

    const retry = async (videoId: string, tries = 0) => {
      if (await create(videoId)) return;
      if (tries < 20) setTimeout(() => void retry(videoId, tries + 1), 500);
    };

    onVideoChange((videoId) => {
      remove();
      if (videoId && location.pathname === '/watch') void retry(videoId);
    });
  },
});
