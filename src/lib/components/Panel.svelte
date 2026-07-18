<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { LoopEngine } from '@/lib/loops/engine';
  import { buildLoopTree, type LoopNode } from '@/lib/loops/nesting';
  import type { Loop } from '@/lib/loops/model';
  import {
    createDbStore,
    addLoop,
    updateLoop,
    deleteLoop,
    incrementPlayCount,
    upsertVideo,
    nextLoopName,
  } from '@/lib/storage/store';
  import { scrapeVideoInfo } from '@/lib/player/video';
  import { browser } from 'wxt/browser';

  let { videoId, video }: { videoId: string; video: HTMLVideoElement } = $props();

  const db = createDbStore();

  // Reactive loop list for this video.
  let loops = $derived(
    Object.values($db.loops).filter((l) => l.videoId === videoId),
  );
  let tree = $derived(buildLoopTree(loops));
  let flat = $derived(flatten(tree)); // [{node, depth}] in display order

  // Engine + active-state mirror (engine is imperative; mirror to reactive state).
  let engine: LoopEngine;
  let activeId = $state<string | null>(null);
  let rep = $state(0);
  let repTotal = $state<number | null>(null);
  let speed = $state(1); // header speed (ambient playback rate)
  let pendingStart = $state<number | null>(null); // A/B quick-set
  const dashboardUrl = (browser.runtime.getURL as (p: string) => string)('/dashboard.html');
  let pendingHashId: string | null = null;

  onMount(() => {
    engine = new LoopEngine(video, {
      onPlayCount: (id) => void incrementPlayCount(id),
      onRepChange: (c, t) => {
        rep = c;
        repTotal = t;
      },
      onExit: () => {
        activeId = null;
      },
    });
    speed = video.playbackRate;
    const info = scrapeVideoInfo();
    if (info.title) void upsertVideo({ videoId, ...info, lastPlayedAt: Date.now() });

    document.addEventListener('keydown', onKey, true);

    const m = location.hash.match(/youloop=([^&]+)/);
    if (m) pendingHashId = m[1];
  });

  // Auto-activate a loop when arriving via a dashboard deep-link (#youloop=ID).
  $effect(() => {
    if (engine && pendingHashId) {
      const target = loops.find((x) => x.id === pendingHashId);
      if (target) {
        activate(target);
        pendingHashId = null;
      }
    }
  });

  onDestroy(() => {
    engine?.destroy();
    document.removeEventListener('keydown', onKey, true);
  });

  function flatten(nodes: LoopNode[], depth = 0): { node: LoopNode; depth: number }[] {
    const out: { node: LoopNode; depth: number }[] = [];
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.children.length) out.push(...flatten(n.children, depth + 1));
    }
    return out;
  }

  function fmt(t: number): string {
    const s = Math.max(0, Math.floor(t));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---- actions ----
  function activate(loop: Loop) {
    engine.activate(loop);
    activeId = loop.id;
  }
  function exitLoop() {
    engine.deactivate();
    activeId = null;
  }
  async function removeLoop(id: string) {
    if (activeId === id) exitLoop();
    await deleteLoop(id);
  }
  async function createLoop(start: number, end: number) {
    if (end <= start) return;
    const loop = await addLoop({
      videoId,
      label: nextLoopName(loops.length),
      startTime: start,
      endTime: end,
      speed: 1,
      pitch: 0,
      repeatCount: null,
    });
    activate(loop);
  }
  function quickSet() {
    if (pendingStart == null) {
      pendingStart = video.currentTime;
    } else {
      void createLoop(pendingStart, video.currentTime);
      pendingStart = null;
    }
  }
  const MIN_LOOP = 0.1; // seconds; keep start < end so the engine never wraps every tick.
  async function nudge(loop: Loop, field: 'startTime' | 'endTime', delta: number) {
    const raw = (loop[field] as number) + delta;
    const next =
      field === 'startTime'
        ? Math.min(loop.endTime - MIN_LOOP, Math.max(0, raw))
        : Math.max(loop.startTime + MIN_LOOP, raw);
    if (next === loop[field]) return;
    await updateLoop(loop.id, { [field]: next });
    if (activeId === loop.id) engine.syncActive({ ...loop, [field]: next });
  }
  async function setLoopSpeed(loop: Loop, s: number) {
    const clamped = Math.min(4, Math.max(0.05, +s.toFixed(2)));
    await updateLoop(loop.id, { speed: clamped });
    if (activeId === loop.id) engine.syncActive({ ...loop, speed: clamped });
  }
  function setHeaderSpeed(s: number) {
    speed = Math.min(4, Math.max(0.05, +s.toFixed(2)));
    video.playbackRate = speed;
  }
  function cycleReps(loop: Loop) {
    // null -> 2 -> 3 -> 5 -> 10 -> null
    const order = [null, 2, 3, 5, 10];
    const i = order.findIndex((v) => v === loop.repeatCount);
    void updateLoop(loop.id, { repeatCount: order[(i + 1) % order.length] });
  }
  function activeIndex(): number {
    return flat.findIndex((f) => f.node.id === activeId);
  }
  function step(dir: 1 | -1) {
    if (!flat.length) return;
    const i = activeIndex();
    const next = flat[(i + dir + flat.length) % flat.length];
    if (next) activate(next.node);
  }

  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const active = engine?.activeLoop ?? null;
    switch (e.key) {
      case '0': engine?.clipToStart(); break;
      case 'a': pendingStart = video.currentTime; break;
      case 'b': quickSet(); break;
      case '[': step(-1); break;
      case ']': step(1); break;
      case '\\': exitLoop(); break;
      case '-': setHeaderSpeed(speed - 0.05); break;
      case '=': setHeaderSpeed(speed + 0.05); break;
      case ',': if (active) void nudge(active, 'startTime', -1); break;
      case '.': if (active) void nudge(active, 'endTime', 1); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div class="yl">
  <header>
    <span class="brand">YouLoop</span>
    {#if activeId && repTotal != null}
      <span class="rep">rep {rep} of {repTotal}</span>
    {/if}
    <div class="spacer"></div>
    <div class="speed">
      <button onclick={() => setHeaderSpeed(speed - 0.05)} aria-label="Slower">−</button>
      <span>{speed.toFixed(2)}×</span>
      <button onclick={() => setHeaderSpeed(speed + 0.05)} aria-label="Faster">+</button>
    </div>
  </header>

  <div class="capture">
    <button onclick={quickSet}>
      {pendingStart == null ? 'Set loop start (A)' : `End loop at cursor (start ${fmt(pendingStart)})`}
    </button>
    {#if activeId}<button class="ghost" onclick={exitLoop}>Exit loop (\)</button>{/if}
  </div>

  <div class="loops">
    {#each flat as { node, depth } (node.id)}
      <div class="row" class:active={activeId === node.id} style:padding-left={`${depth * 14}px`}>
        <button class="play" onclick={() => (activeId === node.id ? exitLoop() : activate(node))}>
          {activeId === node.id ? '■' : '▶'}
        </button>
        <input
          class="label"
          value={node.label}
          onchange={(e) => updateLoop(node.id, { label: (e.currentTarget as HTMLInputElement).value })}
        />
        <div class="time">
          <button onclick={() => nudge(node, 'startTime', -1)}>−</button>
          <span>{fmt(node.startTime)}</span>
          <button onclick={() => nudge(node, 'startTime', 1)}>+</button>
          <span class="sep">/</span>
          <button onclick={() => nudge(node, 'endTime', -1)}>−</button>
          <span>{fmt(node.endTime)}</span>
          <button onclick={() => nudge(node, 'endTime', 1)}>+</button>
        </div>
        <input
          class="lspeed"
          type="number" min="0.05" max="4" step="0.05"
          value={node.speed}
          onchange={(e) => setLoopSpeed(node, +(e.currentTarget as HTMLInputElement).value)}
          title="Loop speed"
        />
        <button class="reps" onclick={() => cycleReps(node)} title="Repeat count">
          {node.repeatCount == null ? '∞' : `×${node.repeatCount}`}
        </button>
        <span class="plays" title="Times played">▷ {node.playCount}</span>
        <button class="del" onclick={() => removeLoop(node.id)} aria-label="Delete">✕</button>
      </div>
    {/each}
    {#if !flat.length}
      <div class="empty">No loops yet. Press <b>A</b> at the start, then <b>B</b> at the end.</div>
    {/if}
  </div>
  <footer>
    <a href={dashboardUrl} target="_blank" rel="noopener">Open Dashboard →</a>
  </footer>
</div>

<style>
  /* Themed to match current YouTube dark UI. Isolated by the host Shadow DOM. */
  :global(:host) { display: block; width: 100%; }
  .yl {
    box-sizing: border-box;
    font-family: 'Roboto', 'Arial', sans-serif;
    background: #0f0f0f;
    color: #f1f1f1;
    border: 1px solid #272727;
    border-radius: 12px;
    padding: 10px 12px;
    margin: 12px 0;
    font-size: 13px;
  }
  * { box-sizing: border-box; }
  header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .brand { font-weight: 600; letter-spacing: 0.2px; }
  .rep { color: #3ea6ff; font-size: 12px; }
  .spacer { flex: 1; }
  .speed { display: flex; align-items: center; gap: 6px; }
  .speed span { min-width: 42px; text-align: center; }
  .capture { display: flex; gap: 8px; margin-bottom: 8px; }
  .loops { max-height: 320px; overflow-y: auto; }
  .row {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 0; border-radius: 8px;
  }
  .row.active { background: rgba(255, 0, 51, 0.18); }
  .row:hover { background: #272727; }
  .label {
    flex: 1; min-width: 60px;
    background: transparent; border: none; color: #f1f1f1;
    font: inherit; padding: 2px 4px; border-radius: 4px;
  }
  .label:focus { background: #272727; outline: none; }
  .time { display: flex; align-items: center; gap: 3px; color: #aaa; }
  .time span { min-width: 34px; text-align: center; }
  .time .sep { min-width: 8px; }
  .lspeed { width: 56px; background: #272727; color: #f1f1f1; border: none; border-radius: 6px; padding: 2px 4px; }
  .plays { color: #aaa; font-size: 12px; }
  button {
    background: #272727; color: #f1f1f1; border: none;
    border-radius: 999px; padding: 4px 10px; cursor: pointer; font: inherit;
  }
  button:hover { background: #3f3f3f; }
  button.ghost { background: transparent; }
  .play, .del, .reps, .time button { padding: 2px 8px; border-radius: 999px; }
  .empty { color: #aaa; padding: 12px 4px; }
  footer { margin-top: 8px; padding-top: 8px; border-top: 1px solid #272727; }
  footer a { color: #3ea6ff; text-decoration: none; font-size: 12px; }
  footer a:hover { text-decoration: underline; }
</style>
