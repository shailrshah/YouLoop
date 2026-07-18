# YouLoop — Design Spec (v1)

> Clean-room build from concept + browser APIs (the referenced repo is unlicensed;
> this is not a fork). Name: **YouLoop**.

A YouTube practice-looping extension: define named, nestable loop segments on a
video, control per-loop speed (and later pitch), repeat a loop a fixed number of
times, jump to loop start with one key, and review every loop across all videos
on one dashboard.

Stack: **WXT + Svelte 5 (runes) + TypeScript**, Shadow-DOM-isolated UI themed to
match current YouTube. Local persistence via `chrome.storage.local` (v1); no cloud
sync in v1.

---

## 1. v1 Feature Scope

| # | Feature | Decision |
|---|---------|----------|
| 1 | In-player panel below the video: loop + speed controls | Speed in **0.05** steps; pitch preserved on speed change |
| 2 | Loop list with sub-loops nested by time containment | Tightest-parent nesting (reimplemented) |
| 3 | Clip key `0`: seek to **active loop** start, keep playing | Only while a loop is active |
| 4 | Per-loop +/- nudge on start/end | **1s** increments |
| 5 | Repeat a loop N times, then **exit loop** | Rep counter shown ("rep 3 of 5") |
| 6 | Cross-video dashboard of all loops/sub-loops | With search + deep-links + play counts |
| + | Loop names | Default `Loop #{n}`, inline-editable |
| + | Per-loop speed **and** pitch stored | pitch applied in Phase 2 |
| + | Full keyboard shortcuts | see §5 |
| + | A/B quick-set to capture a loop | one key sets A, next sets B |
| + | Deep-link dashboard → `youtube.com/watch?v=ID&t=Ns` + auto-activate loop | |
| + | Play count per loop | shown in panel and dashboard |

**Phase 2 (deferred):** independent pitch-shift (Web Audio + WASM), count-in / gap
between reps, cloud sync, waveform markers on the scrubber, auto-import chapters,
practice-time stats.

---

## 2. Data Model

```ts
// A single loop segment.
interface Loop {
  id: string;              // nanoid
  videoId: string;         // youtube video id, e.g. "EDRRbuWuUbQ"
  label: string;           // default "Loop #{n}"
  startTime: number;       // seconds
  endTime: number;         // seconds
  speed: number;           // playback rate, default 1.0, step 0.05
  pitch: number;           // semitones, default 0 (applied in Phase 2)
  repeatCount: number | null; // null = infinite loop; N = play N times then exit
  playCount: number;       // total times this loop has played through
  createdAt: number;
  updatedAt: number;
}

// Per-video metadata (title/channel for the dashboard).
interface Video {
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl?: string;
  lastPlayedAt?: number;
}
```

Notes:
- **Nesting is derived at render time**, never stored. A loop nests under another
  when `parent.startTime <= child.startTime` and `child.endTime <= parent.endTime`.
  This keeps edits simple (change a time, the tree recomputes).
- `playCount` increments each time a loop completes a full pass (start→end).
- Storage shape in `chrome.storage.local`: `{ loops: Record<id, Loop>, videos: Record<videoId, Video> }`. Swap to IndexedDB only if volume demands it.

---

## 3. Architecture (WXT entrypoints)

```
src/
  entrypoints/
    youtube.content.ts     # injected on *://*.youtube.com/watch*; mounts the panel
    dashboard/             # full-page cross-video dashboard (extension page)
    background.ts          # storage access, message routing, deep-link handling
  lib/
    player/                # YouTube video-element access + SPA nav handling
      video.ts             # find <video>, currentTime, rate, preservesPitch
      navigation.ts        # detect SPA video changes, re-bind panel
    loops/
      model.ts             # types above
      nesting.ts           # tightest-parent tree builder (see §7)
      engine.ts            # active-loop monitor: wrap, repeat-count, clip, playCount
    storage/
      store.ts             # chrome.storage.local wrapper -> Svelte stores
    components/            # Svelte UI (Panel, LoopList, LoopRow, SpeedControl, ...)
    theme/                 # YouTube design tokens (see §6)
```

**Reactivity:** a thin `chrome.storage` → Svelte store adapter (same idea as the
reference repo's TinyBase bridge, our own implementation): read initial value,
subscribe to `chrome.storage.onChanged`, expose `subscribe`/`set`. Mutations write
back to storage; the change event re-pushes to all surfaces (panel + dashboard stay
in sync automatically).

---

## 4. Playback Engine (`lib/loops/engine.ts`)

A single `requestAnimationFrame` / `timeupdate` monitor drives loop behavior:

- **Active loop wrap:** when `currentTime >= endTime`, if `repeatCount` is null →
  seek to `startTime` and keep playing; if a count is set → increment rep, and on
  the last rep **exit the loop** (deactivate, let playback continue past `endTime`).
- **Rep counter:** expose `currentRep` / `repeatCount` to the UI ("rep 3 of 5").
- **playCount:** increment on each completed pass, persist (debounced).
- **Clip key `0`:** only when a loop is active → `video.currentTime = loop.startTime`,
  ensure `video.play()`. No-op when no loop active.
- **Speed:** `video.playbackRate = loop.speed`; `video.preservesPitch = true`.
- **Pitch (Phase 2):** Web Audio graph `MediaElementSource → pitchShift → destination`.

Edge cases to handle: user scrubs outside the loop (auto-exit or snap back? →
**auto-exit** on manual seek outside range), video ends, ad breaks (YouTube swaps
the media element — re-acquire it), speed persisting across YouTube's own rate UI.

---

## 5. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `0` | Seek to active loop start (keep playing) — the clip feature |
| `a` | A/B quick-set: set loop **start** at current time |
| `b` | A/B quick-set: set loop **end** at current time + create loop |
| `[` / `]` | Previous / next loop in the list |
| `\` | Exit / deactivate current loop |
| `-` / `=` | Speed down / up by 0.05 |
| `,` / `.` | Nudge active loop start / end by 1s (frame-ish precise) |
| `l` | Toggle the loop panel |

All shortcuts scoped to the watch page and suppressed while an input/textarea
(label editing, YouTube search) is focused.

---

## 6. Styling — match current YouTube (2025/26 dark theme)

The panel mounts **below the player**, inserted as the first child of
`ytd-watch-flexy #below` (fallbacks: after `#player`, then `#primary-inner`). Wrapped
in a **Shadow DOM** so YouTube's CSS can't leak in and ours can't leak out — but
themed with YouTube's own tokens so it looks native:

| Token | Value |
|-------|-------|
| Page bg | `#0f0f0f` |
| Surface / card | `#272727` |
| Surface hover | `#3f3f3f` |
| Text primary | `#f1f1f1` |
| Text secondary | `#aaaaaa` |
| Link / interactive blue | `#3ea6ff` |
| Accent (active loop) | `#ff0033` (used sparingly) |
| Font | `"Roboto","Arial",sans-serif` |
| Pill buttons | fully rounded, `#272727` → hover `#3f3f3f` |
| Card radius | `12px` |

Layout: a full-width card matching the video column width, title row + speed
control on the right, scrollable nested loop list below, an A/B capture control and
"Open Dashboard" link in a footer row. Active loop row highlighted with the accent.

---

## 7. Nesting Algorithm (reimplemented, tightest-parent)

Own implementation (do **not** copy the reference `iterateBreak`):

1. Sort loops by `startTime` asc, then `endTime` **desc** (widest first on ties).
2. Build a forest by inserting each loop under the **deepest existing node that
   fully contains it** (`p.start <= c.start && c.end <= p.end`); if none contains
   it, it's a root.
3. Handle crossing intervals explicitly (a loop that starts inside one loop but ends
   past it) by attaching to the nearest fully-containing ancestor, or as a root if
   none — documented behavior, unlike the reference's greedy scan.

Render recursively; indentation = depth.

---

## 8. YouTube SPA Navigation (must-have, not optional)

YouTube swaps videos without a page reload. The content script must:
- Listen for `yt-navigate-finish` (YouTube's own event) and/or a `MutationObserver`
  / URL poll fallback.
- On video change: tear down the old panel binding, re-acquire the new `<video>`,
  reload loops for the new `videoId`, reset the engine.

Skipping this is the #1 cause of "works once then breaks."

---

## 9. Resolved Decisions

- **Name:** YouLoop.
- **Manual seek outside an active loop:** auto-exit the loop (deactivate; playback
  continues wherever the user seeks).
- **Per-loop speed vs YouTube's speed UI:** does **not** override YouTube's global
  speed. On loop activation, capture the current ambient `playbackRate`, apply
  `loop.speed` for the duration of the loop, and **restore the ambient rate on
  loop exit**. YouLoop never rewrites YouTube's native speed menu.
- **Dashboard:** grouped by video, each video row **collapsible** to reveal its
  loop tree.
