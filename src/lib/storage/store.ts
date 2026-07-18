import { writable, type Readable } from 'svelte/store';
import { browser } from 'wxt/browser';
import { nanoid } from 'nanoid';
import { EMPTY_DB, type DB, type Loop, type Video } from '@/lib/loops/model';

const KEY = 'youloop';
const HINTS_KEY = 'youloop:hints';
const UI_KEY = 'youloop:ui';

async function read(): Promise<DB> {
  const res = await browser.storage.local.get(KEY);
  return { ...EMPTY_DB, ...(res[KEY] as DB | undefined) };
}

async function write(db: DB): Promise<void> {
  await browser.storage.local.set({ [KEY]: db });
}

// Serialize all mutations so two overlapping read-modify-writes can't clobber
// each other. chrome.storage has no CAS, and the wrap fires from rAF while the
// user may also be nudging or renaming.
let writeChain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (db: DB) => T | Promise<T>): Promise<T> {
  const next = writeChain.then(async () => {
    const db = await read();
    const result = await fn(db);
    await write(db);
    return result;
  });
  writeChain = next.catch(() => {});
  return next;
}

/** Live, cross-surface readable of the whole DB (panel + dashboard stay synced). */
export function createDbStore(): Readable<DB> & { reload: () => void } {
  const { subscribe, set } = writable<DB>(EMPTY_DB, () => {
    let cancelled = false;
    read().then((db) => !cancelled && set(db));
    const listener = (changes: Record<string, any>, area: string) => {
      if (area === 'local' && changes[KEY]) {
        set({ ...EMPTY_DB, ...(changes[KEY].newValue as DB) });
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(listener);
    };
  });
  return { subscribe, reload: () => void read().then(set) };
}

// ---- CRUD (mutate storage; the onChanged listener re-pushes to all stores) ----

export function upsertVideo(v: Video): Promise<void> {
  return mutate((db) => {
    db.videos[v.videoId] = { ...db.videos[v.videoId], ...v };
  });
}

export async function loopsForVideo(videoId: string): Promise<Loop[]> {
  const db = await read();
  return Object.values(db.loops).filter((l) => l.videoId === videoId);
}

export function addLoop(
  input: Omit<Loop, 'id' | 'createdAt' | 'updatedAt' | 'playCount'>,
): Promise<Loop> {
  return mutate((db) => {
    const now = Date.now();
    const loop: Loop = { id: nanoid(), playCount: 0, createdAt: now, updatedAt: now, ...input };
    db.loops[loop.id] = loop;
    return loop;
  });
}

export function updateLoop(id: string, patch: Partial<Loop>): Promise<void> {
  return mutate((db) => {
    const existing = db.loops[id];
    if (!existing) return;
    db.loops[id] = { ...existing, ...patch, updatedAt: Date.now() };
  });
}

// Batch play-count writes: the engine calls this on every lap of a short
// loop, and each write triggers a re-render of every {#each} row cross-tab.
// Flush every second, or on tab hide.
const pendingPlayCounts = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function flushPlayCounts(): Promise<void> {
  if (!pendingPlayCounts.size) return Promise.resolve();
  const batch = new Map(pendingPlayCounts);
  pendingPlayCounts.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return mutate((db) => {
    for (const [id, delta] of batch) {
      const l = db.loops[id];
      if (l) l.playCount = (l.playCount ?? 0) + delta;
    }
  });
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPlayCounts();
  });
}

export function incrementPlayCount(id: string): Promise<void> {
  pendingPlayCounts.set(id, (pendingPlayCounts.get(id) ?? 0) + 1);
  if (!flushTimer) flushTimer = setTimeout(() => void flushPlayCounts(), 1000);
  return Promise.resolve();
}

export function deleteLoop(id: string): Promise<void> {
  return mutate((db) => {
    delete db.loops[id];
  });
}

export function nextLoopName(existingCount: number): string {
  return `Loop #${existingCount + 1}`;
}

// ---- One-time hints (coach marks). Dismissed keys are persisted per install. ----

type DismissedHints = Record<string, true>;

export async function isHintDismissed(hint: string): Promise<boolean> {
  const res = await browser.storage.local.get(HINTS_KEY);
  const set = (res[HINTS_KEY] as DismissedHints | undefined) ?? {};
  return !!set[hint];
}

export async function dismissHint(hint: string): Promise<void> {
  const res = await browser.storage.local.get(HINTS_KEY);
  const set = { ...((res[HINTS_KEY] as DismissedHints | undefined) ?? {}), [hint]: true as const };
  await browser.storage.local.set({ [HINTS_KEY]: set });
}

// ---- Global UI preferences (collapsed panel, etc.) ----

interface UiPrefs { collapsed?: boolean }

export async function getUiPrefs(): Promise<UiPrefs> {
  const res = await browser.storage.local.get(UI_KEY);
  return (res[UI_KEY] as UiPrefs | undefined) ?? {};
}

export async function setUiPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): Promise<void> {
  const current = await getUiPrefs();
  await browser.storage.local.set({ [UI_KEY]: { ...current, [key]: value } });
}
