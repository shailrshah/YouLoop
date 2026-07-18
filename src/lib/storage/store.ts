import { writable, type Readable } from 'svelte/store';
import { browser } from 'wxt/browser';
import { nanoid } from 'nanoid';
import { EMPTY_DB, type DB, type Loop, type Video } from '@/lib/loops/model';

const KEY = 'youloop';

async function read(): Promise<DB> {
  const res = await browser.storage.local.get(KEY);
  return { ...EMPTY_DB, ...(res[KEY] as DB | undefined) };
}

async function write(db: DB): Promise<void> {
  await browser.storage.local.set({ [KEY]: db });
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

export async function upsertVideo(v: Video): Promise<void> {
  const db = await read();
  db.videos[v.videoId] = { ...db.videos[v.videoId], ...v };
  await write(db);
}

export async function loopsForVideo(videoId: string): Promise<Loop[]> {
  const db = await read();
  return Object.values(db.loops).filter((l) => l.videoId === videoId);
}

export async function addLoop(
  input: Omit<Loop, 'id' | 'createdAt' | 'updatedAt' | 'playCount'>,
): Promise<Loop> {
  const db = await read();
  const now = Date.now();
  const loop: Loop = { id: nanoid(), playCount: 0, createdAt: now, updatedAt: now, ...input };
  db.loops[loop.id] = loop;
  await write(db);
  return loop;
}

export async function updateLoop(id: string, patch: Partial<Loop>): Promise<void> {
  const db = await read();
  const existing = db.loops[id];
  if (!existing) return;
  db.loops[id] = { ...existing, ...patch, updatedAt: Date.now() };
  await write(db);
}

export async function incrementPlayCount(id: string): Promise<void> {
  const db = await read();
  const l = db.loops[id];
  if (!l) return;
  l.playCount = (l.playCount ?? 0) + 1;
  await write(db);
}

export async function deleteLoop(id: string): Promise<void> {
  const db = await read();
  delete db.loops[id];
  await write(db);
}

export function nextLoopName(existingCount: number): string {
  return `Loop #${existingCount + 1}`;
}
