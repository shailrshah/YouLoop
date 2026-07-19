import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: 'YouLoop',
    description:
      'Practice-looping for YouTube: nested loops, per-loop speed, repeat counts, and a cross-video dashboard.',
    permissions: ['storage'],
    icons: {
      16: 'icon/icon-16.png',
      48: 'icon/icon-48.png',
      128: 'icon/icon-128.png',
    },
    web_accessible_resources: [
      { resources: ['dashboard.html'], matches: ['*://*.youtube.com/*'] },
    ],
  },
});
