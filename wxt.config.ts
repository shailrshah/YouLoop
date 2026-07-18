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
    web_accessible_resources: [
      { resources: ['dashboard.html'], matches: ['*://*.youtube.com/*'] },
    ],
  },
});
