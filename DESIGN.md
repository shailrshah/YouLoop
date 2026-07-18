# YouLoop — Design

A YouTube practice-looping browser extension: define named, nestable loop
segments on a video, control per-loop speed (pitch preservation for now,
independent pitch-shift later), repeat a loop a fixed number of times, jump
to loop start with one key, and review every loop across all videos on one
dashboard.

Stack: **WXT + Svelte 5 (runes) + TypeScript**, one codebase → Chrome MV3
and Firefox MV2. Panel injected as a Shadow-DOM-isolated UI below the video
and themed to match current YouTube. Local persistence via
`chrome.storage.local`; no cloud sync in v1.

---

## 1. v1 Feature Scope

| # | Feature | Notes |
|---|---------|-------|
| 1 | In-player panel below the video, with header speed + per-loop rows | Speed nudges in 0.05 steps; pitch preserved |
| 2 | Loops and sub-loops nested by time containment | Tightest-parent, derived at render, never stored |
| 3 | Active loop highlighted on YouTube's progress bar | Yellow band; clicking outside exits the loop |
| 4 | Clip key `0`: seek to active loop start, keep playing | Only while a loop is active |
| 5 | Per-loop nudge on start / end / speed | 1s for times; 0.05 for speed; `−`/`+` buttons |
| 6 | Repeat a loop N times, then exit | Two-mode reps: `∞` toggle vs finite stepper |
| 7 | Live "rep X of N" indicator on the active loop's row | Colocated with the loop it describes |
| 8 | Cross-video dashboard | Grouped by video, collapsible, searchable, deep-linkable |
| 9 | Popup with most-recently-looped videos | Compact list; opens the dashboard |
| + | Loop names | Default `Loop #{n}`; inline-editable, Enter to commit, Esc to revert |
| + | Per-loop speed **and** pitch stored | Pitch applied in Phase 2 |
| + | Full keyboard shortcuts | See §5 |
| + | A/B quick-set to capture a loop | One key sets A, next sets B |
| + | Deep-link `?v=ID&t=Ns#youloop=LOOPID` | Auto-activates on arrival |
| + | Play count per loop | Shown on panel row and dashboard |

**Phase 2 (deferred):** independent pitch-shift via Web Audio, count-in / gap
between reps, cloud sync, waveform markers on the scrubber, auto-import
chapters, practice-time stats.

---

## 2. Data Model

```ts
interface Loop {
  id: string;               // nanoid
  videoId: string;          // e.g. "EDRRbuWuUbQ"
  label: string;            // default "Loop #{n}", inline-editable
  startTime: number;        // seconds
  endTime: number;          // seconds (enforced end - start >= 0.1s)
  speed: number;            // playback rate; default 1.0, step 0.05, clamped [0.05, 4]
  pitch: number;            // semitones; default 0 (applied in Phase 2)
  repeatCount: number | null; // null = infinite; N = play N times then exit
  playCount: number;        // total completed passes
  createdAt: number;
  updatedAt: number;
}

interface Video {
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl?: string;
  lastPlayedAt?: number;
}

interface DB { loops: Record<string, Loop>; videos: Record<string, Video>; }
```

Notes:
- **Nesting is derived at render time**, never stored. A loop nests under
  another when `parent.startTime <= child.startTime && child.endTime <=
  parent.endTime`. Editing a time re-derives the tree; no children pointers
  to keep in sync.
- **`Video` is upserted on loop creation**, not on panel mount, so a video
  with no loops never leaves dead metadata in storage.
- Storage shape: `{ [KEY]: DB }` where `KEY = 'youloop'`. Swap to IndexedDB
  only if volume demands.

---

## 3. Architecture (WXT entrypoints)

```
src/
  entrypoints/
    youtube.content.ts    # injected on *.youtube.com/*; mounts the panel below #below
    dashboard/            # full-page cross-video dashboard (extension page)
    popup/                # toolbar popup with recent videos
  lib/
    player/
      video.ts            # find <video>, currentVideoId, scrapeVideoInfo
      navigation.ts       # SPA nav detection (yt-navigate-finish + URL poll)
      loopMarkers.ts      # yellow band on .ytp-progress-bar-container
    loops/
      model.ts            # Loop/Video/DB types
      nesting.ts          # tightest-parent forest builder (stack-based)
      engine.ts           # rAF-driven playback engine (wrap, reps, clip, exit)
    storage/
      store.ts            # chrome.storage.local <-> Svelte store + serialized CRUD
    components/
      Panel.svelte        # in-player UI
```

**No background script.** All CRUD hits `chrome.storage.local` directly from
surfaces. The `onChanged` listener re-broadcasts to every open Svelte store
so the panel, dashboard, and popup stay in sync without message passing.

**Storage layer (`store.ts`)** — three notable pieces:

1. **Serialized mutations.** Every write goes through a single-flight
   `mutate(fn)` promise chain. `chrome.storage` has no CAS, and multiple
   overlapping read-modify-writes (e.g. the wrap firing an `incrementPlayCount`
   while the user is nudging) would otherwise clobber each other.
2. **Batched play-counts.** `incrementPlayCount` coalesces into a `Map` and
   flushes every 1s (or on tab hide). A short loop that wraps every 2s would
   otherwise trigger a re-render of every `{#each}` row cross-tab on every lap.
3. **Live `Readable` store.** `createDbStore()` reads once, subscribes to
   `chrome.storage.onChanged`, and pushes updates. All CRUD helpers are
   plain async functions; the store re-hydrates from the change event.

---

## 4. Playback Engine (`lib/loops/engine.ts`)

A single `requestAnimationFrame` monitor plus a `seeking` listener drives
loop behavior on the `<video>`. All time comparisons are in seconds; there's
a 0.05s tolerance on the loop's boundaries to absorb frame-time noise.

### Wrap loop
On each tick:
- If `endTime <= startTime`, idle (degenerate-range guard).
- Re-assert `preservesPitch = true` (YouTube ads / quality switches can flip
  it off, giving chipmunk audio).
- If `currentTime` jumped by more than 1s since the last tick, it was a user
  seek that beat the `seeking` event to us — deactivate if outside range,
  don't wrap if inside.
- If `wrapArmed && currentTime >= endTime`, fire `onPlayCount`, increment
  `currentRep` (for finite loops), and either deactivate (last rep) or
  seek back to `startTime`. `wrapArmed` re-arms once we observe
  `currentTime < endTime - 0.05` again, so a laggy seek can't multi-fire
  per lap.

### Self-seek disambiguation
Every seek the engine initiates increments `pendingSelfSeeks`; `onSeeking`
decrements it and does nothing. **But**: `onSeeking` also checks the
destination — if the user seeks *outside* `[startTime - 0.05, endTime +
0.05]`, the engine deactivates unconditionally. Our own wraps always target
`startTime` (inside the range), so the destination check is a reliable
disambiguator when the counter can't be trusted.

### Ambient rate
- On `activate`, snapshot `video.playbackRate` into `ambientRate` and set
  `loop.speed`.
- If the user changes the header speed while a loop is active, the panel
  calls `engine.setAmbientRate(newRate)` — so exiting the loop restores the
  user's latest choice, not the pre-activation rate.
- `deactivate(restoreRate=true)` writes `ambientRate` back to
  `video.playbackRate`.

### Clip key `0`
Only when a loop is active: `pendingSelfSeeks++`; seek to `startTime`;
`video.play()`. No-op otherwise.

### `syncActive(id, patch)`
Merges a partial update into the engine's active-loop copy. Callers pass
only the fields they changed, so a stale full-loop copy from the caller's
closure can't overwrite the engine's view. Restarts the rAF loop in case
the tick had exited early on a prior degenerate range.

### Cross-browser `preservesPitch`
`preservesPitch` is standard on Chrome and Firefox 104+; older Firefox
used `mozPreservesPitch`. Both are feature-detected without touching an
undeclared property.

---

## 5. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `0` | Seek to active loop start (keep playing) |
| `a` | A/B quick-set: set loop **start** at current time |
| `b` | A/B quick-set: set loop **end** at current time + create loop |
| `[` / `]` | Previous / next loop in the list |
| `\` | Exit / deactivate current loop |
| `,` / `.` | Nudge active loop start / end by 1s |

Handled on `document` in capture phase.

### Not swallowing YouTube
- Modifier keys (`Alt`/`Ctrl`/`Meta`) always fall through.
- `composedPath()` is used to detect true origin — inputs inside our Shadow
  DOM are correctly identified (retargeting would otherwise make them look
  like the shadow host).
- A key is only `preventDefault`'d + `stopPropagation`'d when meaningful
  right now. `0` / `,` / `.` fall through when no loop is active, so
  YouTube's own bindings still work.

### Not swallowing YouLoop
- Key events originating inside our panel are stopped in bubble phase at
  the panel container so they never reach YouTube's document-level
  shortcut listeners. Without this, typing letters in a label input would
  also trigger YouTube's shortcuts (c=captions, f=fullscreen, k=play/pause,
  space, etc.).

### Label editing
The label `<input>` uses a `syncedInput` action: external DB writes are
mirrored into the field only when it isn't the shadow root's focused
element, so play-count writes during playback don't drop keystrokes or
reset the caret. Enter commits and blurs; Escape reverts and blurs.

---

## 6. Styling — YouTube-native dark theme

The panel mounts as the first child of `ytd-watch-flexy #below`, wrapped
in a Shadow DOM (`youloop-root`) so YouTube's CSS can't leak in and ours
can't leak out. Themed with YouTube's own tokens:

| Token | Value |
|-------|-------|
| Page bg | `#0f0f0f` |
| Surface / card | `#272727` |
| Surface hover | `#3f3f3f` |
| Text primary | `#f1f1f1` |
| Text secondary | `#aaaaaa` |
| Link / interactive blue | `#3ea6ff` |
| Accent (active loop) | `rgba(255, 0, 51, 0.18)` |
| Progress-bar band | `#ffe14a` (yellow — reads on both red and grey) |
| Font | `"Roboto","Arial",sans-serif` |
| Pill buttons | fully rounded, `#272727` → hover `#3f3f3f` |
| Card radius | `12px` |

### Row layout
Each loop is a two-line row:

- **Primary line (always visible):** play/stop button, label input, time
  range, secondary chips (speed if it differs from header speed; reps chip
  if finite; play count), delete.
- **Secondary strip (revealed on active or hover):** labeled `START` /
  `END` / `SPEED` / `REPS` clusters, each in its own rounded container so
  the `−`/`+` buttons unambiguously belong to their label. Stepper buttons
  are transparent with muted glyphs — the *value* between them reads first.

The active row uses the red accent as its background. The play/stop button
has no fill on the active row so it doesn't fight the red band; play and
stop icons are SVG so they occupy identical geometry.

### Progress-bar band
`lib/player/loopMarkers.ts` appends a `pointer-events: none` overlay to
`.ytp-progress-bar-container` — a translucent yellow fill with sharper
edges spanning `[startPct, endPct]` of `video.duration`. YouTube's scrubber
stays fully clickable; clicking outside the band seeks outside the loop
range, and the engine's manual-seek path auto-deactivates.

A `MutationObserver` on `document.body` re-parents the overlay if YouTube
swaps out the progress-bar subtree (fullscreen toggle, quality switch).

---

## 7. Nesting Algorithm (`lib/loops/nesting.ts`)

Own implementation, stack-based:

1. Sort loops by `startTime` asc, then `endTime` **desc** (widest first on
   ties). This way a wider loop precedes narrower ones it contains and
   becomes their parent.
2. Walk the sorted list with a stack of currently-open ancestors. For each
   loop, pop ancestors that don't fully contain it. The top of the stack
   after popping is the tightest parent; if empty, the loop is a root.
3. Crossing intervals (a loop that starts inside one but ends past it)
   attach to the nearest fully-containing ancestor, or become a root —
   documented deterministic behavior.

Render recursively; indentation = depth.

---

## 8. YouTube SPA Navigation (`lib/player/navigation.ts`)

YouTube swaps videos without a page reload. `onVideoChange` fires on
initial load and on every `yt-navigate-finish` event, plus a 1s URL poll
as a fallback. On video change:

- Tear down the old panel binding, disconnect the anchor observer,
  destroy the engine and progress-bar overlay.
- Re-acquire the new `<video>` and `#below` anchor, remount the panel.
- Reload loops for the new `videoId` (via the reactive store).

### Anchor loss
YouTube sometimes re-renders `#below` in place without firing
`yt-navigate-finish` (ad break exit, layout toggle). A `MutationObserver`
on the shadow host's parent detects when our host is disconnected and
retries `create()` for the current videoId.

### Deep links
Arriving with `#youloop=LOOPID` (from the dashboard) queues the id in
`pendingHashId`. When the store hydrates and the loop appears, the panel
activates it and strips the hash via `history.replaceState`. Retries up
to 5 store updates before giving up so a stale hash (loop deleted, wrong
video) doesn't linger.

---

## 9. Resolved Decisions

- **Name:** YouLoop.
- **Manual seek outside an active loop:** auto-exit (deactivate; playback
  continues wherever the user seeks). Same behavior when the user clicks
  outside the progress-bar band.
- **Per-loop speed vs YouTube's speed UI:** does **not** override YouTube's
  global speed persistently. On loop activation, capture the current
  ambient `playbackRate`, apply `loop.speed`, and restore the ambient rate
  on exit. YouLoop never rewrites YouTube's native speed menu.
- **Dashboard:** grouped by video, each video row collapsible.
- **Concurrent writes:** serialized in the storage layer, not the callers'
  problem.
- **`Loop #N` naming:** kept as the default (user feedback preferred over
  auto-derived labels).

---

## 10. Development

```bash
npm install
npm run dev           # Chrome, hot-reload
npm run dev:firefox   # Firefox, hot-reload
npm run check         # svelte-check + tsc
npm run build         # -> .output/chrome-mv3
npm run build:firefox # -> .output/firefox-mv2
```

Load unpacked:
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked →
  `.output/chrome-mv3`
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary
  Add-on → `.output/firefox-mv2/manifest.json`

After code changes with `npm run dev`, WXT recompiles automatically, but
the content script only rebinds on next YouTube SPA nav; **refresh the
tab** (or navigate to another video) to pick up UI changes cleanly.
