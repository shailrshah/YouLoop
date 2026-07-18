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
  import { attachLoopMarkers, type LoopMarkers } from '@/lib/player/loopMarkers';
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
  let markers: LoopMarkers | null = null;
  let activeId = $state<string | null>(null);
  let rep = $state(0);
  let repTotal = $state<number | null>(null);
  let speed = $state(1); // header speed (ambient playback rate)
  let pendingStart = $state<number | null>(null); // A/B quick-set
  const dashboardUrl = (browser.runtime.getURL as (p: string) => string)('/dashboard.html');
  let pendingHashId: string | null = null;
  let deepLinkAttempts = 0;

  onMount(() => {
    engine = new LoopEngine(video, {
      onPlayCount: (id) => void incrementPlayCount(id),
      onRepChange: (c, t) => {
        rep = c;
        repTotal = t;
      },
      onExit: () => {
        activeId = null;
        markers?.setActive(null);
      },
    });
    markers = attachLoopMarkers(video, {
      onDrag: (id, kind, time) => {
        // Live update: only feed the engine so playback follows immediately.
        // Persistence waits for pointerup — otherwise we'd write once per
        // pixel of mouse motion.
        engine.syncActive(id, { [kind]: time });
      },
      onCommit: (id, kind, time) => {
        void updateLoop(id, { [kind]: time });
        engine.syncActive(id, { [kind]: time });
      },
    });
    speed = video.playbackRate;

    document.addEventListener('keydown', onKey, true);

    const m = location.hash.match(/youloop=([^&]+)/);
    if (m) pendingHashId = m[1];
  });

  // Auto-activate a loop when arriving via a dashboard deep-link (#youloop=ID).
  // Give up after a few store updates so a stale hash (loop deleted, or from a
  // different videoId) doesn't linger; also clear it so reloading the page
  // doesn't silently re-activate a loop the user has since exited.
  $effect(() => {
    if (!engine || !pendingHashId) return;
    const target = loops.find((x) => x.id === pendingHashId);
    if (target) {
      activate(target);
      pendingHashId = null;
      clearHash();
      return;
    }
    if (++deepLinkAttempts >= 5) {
      pendingHashId = null;
      clearHash();
    }
  });

  function clearHash() {
    if (location.hash.includes('youloop=')) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  onDestroy(() => {
    engine?.destroy();
    markers?.destroy();
    markers = null;
    document.removeEventListener('keydown', onKey, true);
  });

  // Keep the progress-bar overlay in sync with the active loop and any edits
  // (nudge, cycleReps doesn't affect geometry but times can move underneath us
  // via storage changes from another tab).
  $effect(() => {
    if (!markers) return;
    const current = activeId ? loops.find((l) => l.id === activeId) ?? null : null;
    markers.setActive(current);
  });

  // Mirror the pending A-mark to the progress bar so the user sees where
  // they've dropped it before pressing B.
  $effect(() => {
    markers?.setPending(pendingStart);
  });

  // Sync the input's value from storage only when the user isn't editing, so
  // external writes (play-count increments, cross-tab edits) never clobber
  // a caret mid-type or drop keystrokes.
  function syncedInput<T extends string | number>(
    node: HTMLInputElement,
    params: { value: T; commit: (raw: string) => void; format?: (v: T) => string },
  ) {
    const fmt = () => (params.format ? params.format(params.value) : String(params.value));
    node.value = fmt();
    let commit = params.commit;
    const onChange = () => commit(node.value);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        commit(node.value);
        node.blur();
      } else if (e.key === 'Escape') {
        // Revert to the last-committed value and drop focus.
        node.value = fmt();
        node.blur();
      }
    };
    node.addEventListener('change', onChange);
    node.addEventListener('keydown', onKey);
    return {
      update(next: { value: T; commit: (raw: string) => void; format?: (v: T) => string }) {
        commit = next.commit;
        params = next;
        const rendered = next.format ? next.format(next.value) : String(next.value);
        // document.activeElement retargets to the shadow host from outside the
        // shadow tree, so it never equals `node` even when the user is typing
        // in it. Walk up shadow roots to find the true focused element.
        const root = node.getRootNode() as ShadowRoot | Document;
        const focused = (root as ShadowRoot).activeElement ?? document.activeElement;
        if (focused !== node && node.value !== rendered) {
          node.value = rendered;
        }
      },
      destroy() {
        node.removeEventListener('change', onChange);
        node.removeEventListener('keydown', onKey);
      },
    };
  }

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

  const MIN_LOOP = 0.1; // seconds; keep start < end so the engine never wraps every tick.

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
    if (end - start < MIN_LOOP) return;
    const info = scrapeVideoInfo(videoId);
    if (info.title) {
      void upsertVideo({ videoId, ...info, lastPlayedAt: Date.now() });
    }
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
  async function nudge(loop: Loop, field: 'startTime' | 'endTime', delta: number) {
    const raw = (loop[field] as number) + delta;
    const next =
      field === 'startTime'
        ? Math.min(loop.endTime - MIN_LOOP, Math.max(0, raw))
        : Math.max(loop.startTime + MIN_LOOP, raw);
    if (next === loop[field]) return;
    await updateLoop(loop.id, { [field]: next });
    if (activeId === loop.id) engine.syncActive(loop.id, { [field]: next });
  }
  async function setLoopSpeed(loop: Loop, s: number) {
    const clamped = Math.min(4, Math.max(0.05, +s.toFixed(2)));
    if (clamped === loop.speed) return;
    await updateLoop(loop.id, { speed: clamped });
    if (activeId === loop.id) engine.syncActive(loop.id, { speed: clamped });
  }
  function nudgeLoopSpeed(loop: Loop, delta: number) {
    void setLoopSpeed(loop, loop.speed + delta);
  }
  function setHeaderSpeed(s: number) {
    speed = Math.min(4, Math.max(0.05, +s.toFixed(2)));
    // If a loop is active, the loop is currently driving playbackRate; just
    // update the ambient rate so exiting restores the user's choice. Otherwise
    // apply directly.
    if (activeId) engine.setAmbientRate(speed);
    else video.playbackRate = speed;
  }
  const DEFAULT_FINITE_REPS = 5;
  function setReps(loop: Loop, next: number | null) {
    if (next === loop.repeatCount) return;
    void updateLoop(loop.id, { repeatCount: next });
    if (activeId === loop.id) {
      engine.syncActive(loop.id, { repeatCount: next });
      // Restart the rep counter and refresh the header display; changing the
      // count mid-play should reset progress, not keep an out-of-band value.
      engine.resetRep();
      rep = 0;
      repTotal = next;
    }
  }
  function toFinite(loop: Loop) {
    setReps(loop, DEFAULT_FINITE_REPS);
  }
  function toInfinite(loop: Loop) {
    setReps(loop, null);
  }
  function nudgeReps(loop: Loop, delta: number) {
    if (loop.repeatCount == null) return;
    const next = Math.max(1, loop.repeatCount + delta);
    setReps(loop, next);
  }
  function activeIndex(): number {
    return flat.findIndex((f) => f.node.id === activeId);
  }
  function step(dir: 1 | -1) {
    if (!flat.length) return;
    const i = activeIndex();
    // From idle: forward -> first, backward -> last. Otherwise wrap normally.
    const nextIndex =
      i < 0 ? (dir === 1 ? 0 : flat.length - 1) : (i + dir + flat.length) % flat.length;
    activate(flat[nextIndex].node);
  }

  // Stop key events originating in our panel from bubbling up to YouTube's
  // document/window listeners — otherwise typing in a label field fires
  // YouTube's own shortcuts (c=captions, f=fullscreen, k=play/pause, etc.).
  function panelKeyGuard(e: KeyboardEvent) {
    e.stopPropagation();
  }

  function onKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Our inputs live inside a Shadow DOM, so `e.target` is retargeted to the
    // shadow host at document level. Use composedPath to find the real origin.
    const path = e.composedPath();
    const originEl = (path[0] as HTMLElement) ?? (e.target as HTMLElement);
    if (
      originEl &&
      (originEl.tagName === 'INPUT' ||
        originEl.tagName === 'TEXTAREA' ||
        originEl.isContentEditable)
    ) {
      return;
    }
    const active = engine?.activeLoop ?? null;
    // Only handle a key when the action is meaningful right now — otherwise
    // let YouTube (or the browser) see it. Keys that overlap YouTube's own
    // bindings (`0`, `,`, `.`) fall through when no loop is active.
    switch (e.key) {
      case '0':
        if (!active) return;
        engine.clipToStart();
        break;
      case 'a': pendingStart = video.currentTime; break;
      case 'b': quickSet(); break;
      case '[':
        if (!flat.length) return;
        step(-1);
        break;
      case ']':
        if (!flat.length) return;
        step(1);
        break;
      case '\\':
        if (!active) return;
        exitLoop();
        break;
      case '-': setHeaderSpeed(speed - 0.05); break;
      case '=': setHeaderSpeed(speed + 0.05); break;
      case ',':
        if (!active) return;
        void nudge(active, 'startTime', -1);
        break;
      case '.':
        if (!active) return;
        void nudge(active, 'endTime', 1);
        break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="yl"
  role="group"
  aria-label="YouLoop panel"
  onkeydown={panelKeyGuard}
  onkeyup={panelKeyGuard}
  onkeypress={panelKeyGuard}
>
  <header>
    <span class="brand">YouLoop</span>
    <div class="spacer"></div>
    <div class="speed">
      <button onclick={() => setHeaderSpeed(speed - 0.05)} aria-label="Slower">−</button>
      <span>{speed.toFixed(2)}×</span>
      <button onclick={() => setHeaderSpeed(speed + 0.05)} aria-label="Faster">+</button>
    </div>
    <a class="dash-link" href={dashboardUrl} target="_blank" rel="noopener">Dashboard →</a>
  </header>

  <div class="capture">
    <button onclick={quickSet}>
      {pendingStart == null ? 'Set loop start (A)' : `Press B to set loop end (start ${fmt(pendingStart)})`}
    </button>
    {#if activeId}<button class="ghost" onclick={exitLoop}>Exit loop (\)</button>{/if}
  </div>

  <div class="loops">
    {#each flat as { node, depth } (node.id)}
      <div class="row" class:active={activeId === node.id} style:padding-left={`${depth * 14}px`}>
        <div class="primary">
          <button
            class="play"
            onclick={() => (activeId === node.id ? exitLoop() : activate(node))}
            aria-label={activeId === node.id ? 'Stop loop' : 'Play loop'}
          >
            {#if activeId === node.id}
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" />
              </svg>
            {:else}
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 2 L10 6 L3 10 Z" fill="currentColor" />
              </svg>
            {/if}
          </button>
          {#if activeId === node.id && repTotal != null}
            <span class="rep-live" title="Current rep of total">
              {rep + 1}<span class="rep-sep">/</span>{repTotal}
            </span>
          {/if}
          <input
            class="label"
            use:syncedInput={{ value: node.label, commit: (v) => updateLoop(node.id, { label: v }) }}
          />
          <span class="range">{fmt(node.startTime)}–{fmt(node.endTime)}</span>
          <span class="meta">
            {#if node.speed !== speed}<span class="chip">{node.speed.toFixed(2)}×</span>{/if}
            {#if node.repeatCount != null && activeId !== node.id}
              <span class="chip">+{node.repeatCount}</span>
            {/if}
            <span class="plays" title="Times played">▷ {node.playCount}</span>
          </span>
          <button class="del" onclick={() => removeLoop(node.id)} aria-label="Delete">✕</button>
        </div>
        <div class="secondary">
          <div class="ctl">
            <span class="ctl-label">Start</span>
            <button onclick={() => nudge(node, 'startTime', -1)} aria-label="Earlier start">−</button>
            <span class="ctl-val">{fmt(node.startTime)}</span>
            <button onclick={() => nudge(node, 'startTime', 1)} aria-label="Later start">+</button>
          </div>
          <div class="ctl">
            <span class="ctl-label">End</span>
            <button onclick={() => nudge(node, 'endTime', -1)} aria-label="Earlier end">−</button>
            <span class="ctl-val">{fmt(node.endTime)}</span>
            <button onclick={() => nudge(node, 'endTime', 1)} aria-label="Later end">+</button>
          </div>
          <div class="ctl">
            <span class="ctl-label">Speed</span>
            <button onclick={() => nudgeLoopSpeed(node, -0.05)} aria-label="Slower">−</button>
            <span class="ctl-val">{node.speed.toFixed(2)}×</span>
            <button onclick={() => nudgeLoopSpeed(node, 0.05)} aria-label="Faster">+</button>
          </div>
          <div class="ctl">
            <span class="ctl-label">Reps</span>
            {#if node.repeatCount == null}
              <button onclick={() => toFinite(node)} title="Set a repeat count">∞</button>
            {:else}
              <button onclick={() => nudgeReps(node, -1)} aria-label="One fewer rep">−</button>
              <span class="ctl-val">+{node.repeatCount}</span>
              <button onclick={() => nudgeReps(node, 1)} aria-label="One more rep">+</button>
              <button
                class="rep-inf"
                onclick={() => toInfinite(node)}
                title="Loop forever"
                aria-label="Loop forever"
              >∞</button>
            {/if}
          </div>
        </div>
      </div>
    {/each}
    {#if !flat.length}
      <div class="empty">No loops yet. Press <b>A</b> at the start, then <b>B</b> at the end.</div>
    {/if}
  </div>
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
  .spacer { flex: 1; }
  .speed { display: flex; align-items: center; gap: 6px; }
  .speed span { min-width: 42px; text-align: center; }
  .capture { display: flex; gap: 8px; margin-bottom: 8px; }
  .loops { max-height: 320px; overflow-y: auto; }
  .row {
    padding: 4px 12px; border-radius: 8px;
  }
  .row.active { background: rgba(255, 0, 51, 0.18); }
  .row:hover { background: #272727; }
  .row.active:hover { background: rgba(255, 0, 51, 0.24); }
  .primary { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .label {
    flex: 1; min-width: 60px;
    background: transparent; border: none; color: #f1f1f1;
    font: inherit; padding: 2px 4px; border-radius: 4px;
  }
  .label:focus { background: #272727; outline: none; }
  .range { color: #aaa; font-size: 12px; font-variant-numeric: tabular-nums; }
  .meta { display: flex; align-items: center; gap: 6px; color: #aaa; font-size: 12px; }
  .chip {
    background: #272727; border-radius: 999px; padding: 1px 6px;
    color: #ddd; font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .plays { font-size: 12px; }
  /* Live rep counter sits right after the play button, so it reads as loop
     state rather than a floating notification chip. */
  .rep-live {
    color: #3ea6ff; font-size: 12px; font-variant-numeric: tabular-nums;
    letter-spacing: 0.2px; min-width: 38px;
  }
  .rep-live .rep-sep { color: rgba(62, 166, 255, 0.55); margin: 0 1px; }
  /* Secondary strip: hidden by default, revealed when the row is active or
     hovered. Rendered below the primary line — one column of quick controls. */
  .secondary {
    display: none;
    align-items: center; flex-wrap: wrap; gap: 6px;
    padding: 4px 0 6px 40px; /* align under label, past the play button */
    color: #aaa;
  }
  .row.active .secondary,
  .row:hover .secondary,
  .row:focus-within .secondary { display: flex; }
  /* Each control cluster gets its own boxed background so START/END/SPEED/REPS
     are unambiguous — the `+` on the far right of one cluster can't be
     confused with the next cluster's label. */
  .ctl {
    display: inline-flex; align-items: center; gap: 4px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 999px;
    padding: 2px 6px 2px 10px;
  }
  .row.active .ctl {
    background: rgba(0, 0, 0, 0.18);
    border-color: rgba(255, 255, 255, 0.08);
  }
  .ctl-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px;
    color: #888; margin-right: 4px;
  }
  .ctl-val {
    min-width: 40px; text-align: center; font-variant-numeric: tabular-nums;
    color: #ddd;
  }
  .rep-inf { color: #aaa; margin-left: 2px; }
  button {
    background: #272727; color: #f1f1f1; border: none;
    border-radius: 999px; padding: 4px 10px; cursor: pointer; font: inherit;
  }
  button:hover { background: #3f3f3f; }
  button.ghost { background: transparent; }
  .play {
    width: 26px; height: 26px;
    padding: 0; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .play svg { width: 14px; height: 14px; display: block; }
  /* On the active (red) row, the button's own grey fill fights the red band.
     Drop the fill so the icon sits directly on red; keep hover feedback. */
  .row.active .play { background: transparent; }
  .row.active .play:hover { background: rgba(255, 255, 255, 0.1); }
  .del { padding: 2px 8px; border-radius: 999px; }
  /* Cluster steppers are structural, not primary — recede them so the value
     between them reads first. */
  .ctl button {
    padding: 1px 7px; border-radius: 999px;
    background: transparent; color: #999; font-size: 12px;
  }
  .ctl button:hover { background: rgba(255, 255, 255, 0.08); color: #f1f1f1; }
  .empty { color: #aaa; padding: 12px 4px; }
  .dash-link {
    color: #3ea6ff; text-decoration: none; font-size: 12px;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid rgba(62, 166, 255, 0.35);
  }
  .dash-link:hover { background: rgba(62, 166, 255, 0.12); }
</style>
