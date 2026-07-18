// Core domain types for YouLoop.

/** A single loop segment on a video. Nesting is derived, never stored. */
export interface Loop {
  id: string; // nanoid
  videoId: string; // youtube video id, e.g. "EDRRbuWuUbQ"
  label: string; // default "Loop #{n}", inline-editable
  startTime: number; // seconds
  endTime: number; // seconds
  speed: number; // playback rate, default 1.0, step 0.05
  pitch: number; // semitones, default 0 (applied in Phase 2)
  repeatCount: number | null; // null = infinite; N = play N times then exit
  playCount: number; // total completed passes
  createdAt: number;
  updatedAt: number;
}

/** Per-video metadata for the dashboard. */
export interface Video {
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl?: string;
  lastPlayedAt?: number;
}

export interface DB {
  loops: Record<string, Loop>;
  videos: Record<string, Video>;
}

export const EMPTY_DB: DB = { loops: {}, videos: {} };
