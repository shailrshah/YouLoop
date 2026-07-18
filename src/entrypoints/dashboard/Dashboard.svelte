<script lang="ts">
  import { browser } from 'wxt/browser';
  import { createDbStore, deleteLoop } from '@/lib/storage/store';
  import { buildLoopTree, type LoopNode } from '@/lib/loops/nesting';
  import type { DB, Loop, Video } from '@/lib/loops/model';

  const db = createDbStore();

  let q = $state('');
  let collapsed = $state<Record<string, boolean>>({});

  interface Group {
    video: Video;
    flat: { node: LoopNode; depth: number }[];
    loopCount: number;
    totalPlays: number;
  }

  function flatten(nodes: LoopNode[], depth = 0) {
    const out: { node: LoopNode; depth: number }[] = [];
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.children.length) out.push(...flatten(n.children, depth + 1));
    }
    return out;
  }

  function buildGroups(data: DB, query: string): Group[] {
    const term = query.trim().toLowerCase();
    const byVideo = new Map<string, Loop[]>();
    for (const loop of Object.values(data.loops)) {
      (byVideo.get(loop.videoId) ?? byVideo.set(loop.videoId, []).get(loop.videoId)!).push(loop);
    }

    const groups: Group[] = [];
    for (const [videoId, loops] of byVideo) {
      const video: Video =
        data.videos[videoId] ?? { videoId, title: videoId, channel: '' };
      const matchVideo =
        !term ||
        video.title.toLowerCase().includes(term) ||
        video.channel.toLowerCase().includes(term);
      const shown = term && !matchVideo
        ? loops.filter((l) => l.label.toLowerCase().includes(term))
        : loops;
      if (!shown.length) continue;
      groups.push({
        video,
        flat: flatten(buildLoopTree(shown)),
        loopCount: loops.length,
        totalPlays: loops.reduce((s, l) => s + (l.playCount ?? 0), 0),
      });
    }
    return groups.sort(
      (a, b) => (b.video.lastPlayedAt ?? 0) - (a.video.lastPlayedAt ?? 0),
    );
  }

  let groups = $derived(buildGroups($db, q));
  let totalLoops = $derived(Object.keys($db.loops).length);

  function fmt(t: number): string {
    const s = Math.max(0, Math.floor(t));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function openLoop(loop: Loop) {
    const url = `https://www.youtube.com/watch?v=${loop.videoId}&t=${Math.floor(
      loop.startTime,
    )}s#youloop=${loop.id}`;
    if (browser.tabs?.create) void browser.tabs.create({ url });
    else window.open(url, '_blank');
  }

  function toggle(videoId: string) {
    collapsed = { ...collapsed, [videoId]: !collapsed[videoId] };
  }
</script>

<main>
  <header class="top">
    <h1>YouLoop</h1>
    <span class="sub">{totalLoops} loops across {groups.length} videos</span>
    <div class="spacer"></div>
    <input class="search" placeholder="Search videos or loops…" bind:value={q} />
  </header>

  {#each groups as g (g.video.videoId)}
    <section class="group">
      <button class="ghead" onclick={() => toggle(g.video.videoId)}>
        <span class="caret">{collapsed[g.video.videoId] ? '▸' : '▾'}</span>
        <span class="title">{g.video.title}</span>
        {#if g.video.channel}<span class="channel">{g.video.channel}</span>{/if}
        <span class="badges">{g.loopCount} loops · ▷ {g.totalPlays}</span>
      </button>

      {#if !collapsed[g.video.videoId]}
        <div class="rows">
          {#each g.flat as { node, depth } (node.id)}
            <div class="row" style:padding-left={`${12 + depth * 16}px`}>
              <button class="open" onclick={() => openLoop(node)} title="Open in YouTube at loop start">▶</button>
              <span class="label">{node.label}</span>
              <span class="time">{fmt(node.startTime)} – {fmt(node.endTime)}</span>
              <span class="chip">{node.speed.toFixed(2)}×</span>
              <span class="chip">{node.repeatCount == null ? '∞' : `×${node.repeatCount}`}</span>
              <span class="plays">▷ {node.playCount}</span>
              <div class="spacer"></div>
              <button class="del" onclick={() => deleteLoop(node.id)} aria-label="Delete">✕</button>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/each}

  {#if !groups.length}
    <div class="empty">
      {q ? 'No loops match your search.' : 'No loops yet. Create some on any YouTube video.'}
    </div>
  {/if}
</main>

<style>
  :global(body) { margin: 0; background: #0f0f0f; color: #f1f1f1; font-family: 'Roboto', 'Arial', sans-serif; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 16px 64px; }
  * { box-sizing: border-box; }
  .top { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: #aaa; font-size: 13px; }
  .spacer { flex: 1; }
  .search {
    background: #272727; border: 1px solid #3f3f3f; color: #f1f1f1;
    border-radius: 999px; padding: 8px 14px; width: 280px; font: inherit;
  }
  .search:focus { outline: none; border-color: #3ea6ff; }
  .group { border: 1px solid #272727; border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
  .ghead {
    display: flex; align-items: center; gap: 10px; width: 100%;
    background: #181818; color: #f1f1f1; border: none; cursor: pointer;
    padding: 12px 14px; font: inherit; text-align: left;
  }
  .ghead:hover { background: #202020; }
  .caret { width: 14px; color: #aaa; }
  .title { font-weight: 600; }
  .channel { color: #aaa; font-size: 12px; }
  .badges { margin-left: auto; color: #aaa; font-size: 12px; }
  .rows { padding: 6px 0; }
  .row { display: flex; align-items: center; gap: 10px; padding: 6px 14px; }
  .row:hover { background: #1c1c1c; }
  .label { font-size: 13px; }
  .time { color: #aaa; font-size: 12px; }
  .chip { background: #272727; border-radius: 999px; padding: 2px 8px; font-size: 12px; color: #ddd; }
  .plays { color: #aaa; font-size: 12px; }
  button {
    background: #272727; color: #f1f1f1; border: none; border-radius: 999px;
    padding: 4px 10px; cursor: pointer; font: inherit;
  }
  button:hover { background: #3f3f3f; }
  .empty { color: #aaa; padding: 40px 8px; text-align: center; }
</style>
