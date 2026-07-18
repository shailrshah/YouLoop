# YouLoop

A browser extension for **practice-looping** on YouTube: define named, nestable
loop segments on a video, control per-loop speed, repeat a loop a fixed number of
times, jump to a loop's start with one key, and review every loop across all
videos on a single dashboard.

Built with **WXT + Svelte 5 + TypeScript**. Runs on Chrome and Firefox from one
codebase.

## Features

- In-player panel below the video with speed control (0.05 steps, pitch preserved)
- Loops and **sub-loops**, nested automatically by time containment
- Per-loop **speed** and (planned) pitch, remembered and applied on activation
- Active loop **highlighted on YouTube's progress bar**; click outside the
  band to exit the loop
- Clip key `0`: jump to the active loop's start and keep playing
- `+/-` 1-second nudges on each loop's start/end
- Repeat a loop **N times**, then exit, with a live "rep X of N" counter
  shown on the loop's row
- A/B quick-set (`a` then `b`) to capture a loop while watching
- Play-count tracking per loop
- Cross-video **dashboard**: grouped by video, collapsible, searchable, with
  deep-links back into the video at the loop start
- Popup with your most recent looped videos

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `0` | Seek to active loop start (keep playing) |
| `a` / `b` | Set loop start / set end + create loop |
| `[` / `]` | Previous / next loop |
| `\` | Exit the active loop |
| `,` / `.` | Nudge active loop start / end by 1s |

## Develop

Requires Node 18+ and npm.

```bash
npm install
npm run dev          # Chrome, hot-reload
npm run dev:firefox  # Firefox, hot-reload
```

## Build

```bash
npm run build          # -> .output/chrome-mv3
npm run build:firefox  # -> .output/firefox-mv2
```

Load unpacked:
- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`
- **Firefox**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `.output/firefox-mv2/manifest.json`

## Status

v1 in progress. Independent pitch shifting (change pitch without changing speed)
is planned for a later phase via the Web Audio API.

See [DESIGN.md](./DESIGN.md) for the full design.

## License

[MIT](./LICENSE) © Shail R. Shah
