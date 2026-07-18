<script lang="ts">
  import { browser } from 'wxt/browser';
  import { createDbStore } from '@/lib/storage/store';
  import type { DB, Loop, Video } from '@/lib/loops/model';

  const db = createDbStore();

  function recent(data: DB): { video: Video; count: number }[] {
    const counts = new Map<string, number>();
    for (const l of Object.values(data.loops)) {
      counts.set(l.videoId, (counts.get(l.videoId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([videoId, count]) => ({
        video: data.videos[videoId] ?? { videoId, title: videoId, channel: '' },
        count,
      }))
      .sort((a, b) => (b.video.lastPlayedAt ?? 0) - (a.video.lastPlayedAt ?? 0))
      .slice(0, 4);
  }

  let items = $derived(recent($db));
  let total = $derived(Object.keys($db.loops).length);

  function openDashboard() {
    void browser.tabs.create({
      url: (browser.runtime.getURL as (p: string) => string)('/dashboard.html'),
    });
  }
  function openVideo(video: Video) {
    void browser.tabs.create({ url: `https://www.youtube.com/watch?v=${video.videoId}` });
  }
</script>

<div class="popup">
  <header>
    <span class="brand">YouLoop</span>
    <span class="sub">{total} loops</span>
  </header>

  {#if items.length}
    <div class="list">
      {#each items as { video, count } (video.videoId)}
        <button class="item" onclick={() => openVideo(video)}>
          <span class="t">{video.title}</span>
          <span class="c">{count}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="empty">No loops yet.</div>
  {/if}

  <button class="dash" onclick={openDashboard}>Open Dashboard</button>
</div>

<style>
  :global(body) { margin: 0; }
  .popup {
    width: 300px; background: #0f0f0f; color: #f1f1f1;
    font-family: 'Roboto', 'Arial', sans-serif; padding: 12px;
  }
  * { box-sizing: border-box; }
  header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .brand { font-weight: 600; }
  .sub { color: #aaa; font-size: 12px; }
  .list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .item {
    display: flex; align-items: center; gap: 8px; width: 100%;
    background: #181818; border: none; color: #f1f1f1; cursor: pointer;
    border-radius: 8px; padding: 8px 10px; font: inherit; text-align: left;
  }
  .item:hover { background: #272727; }
  .item .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .item .c { color: #aaa; font-size: 12px; }
  .empty { color: #aaa; padding: 16px 4px; font-size: 13px; }
  .dash {
    width: 100%; background: #272727; color: #f1f1f1; border: none;
    border-radius: 999px; padding: 8px; cursor: pointer; font: inherit;
  }
  .dash:hover { background: #3f3f3f; }
</style>
