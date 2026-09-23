import type { MixerProjectSnapshot } from "./producerMixer";
import { isTrackArrangement, type TrackArrangement } from "./arrangement";
import { isBassPattern, type BassPattern } from "./bass";
import {
  isDrumPatternChoice,
  normalizeDrumPattern,
  type DrumPattern,
  type DrumPatternChoice,
} from "./drums";

const DB_NAME = "trackstar-studio";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const AUTOSAVE_KEY = "autosave";

/** Drum-panel state: which dropdown entry is selected, plus the user's beat. */
export interface DrumProjectState {
  choice: DrumPatternChoice;
  custom: DrumPattern;
}

export interface CompositionProjectState {
  bassOn: boolean;
  bass: BassPattern;
  arrangement: TrackArrangement;
}

export interface TrackstarProject {
  version: 1;
  name: string;
  savedAt: string;
  bpm: number;
  bars: number;
  mixer: MixerProjectSnapshot;
  /** Optional: projects saved before the beat sequencer shipped have no drums. */
  drums?: DrumProjectState;
  /** Optional custom bassline and bar-by-bar layer arrangement. */
  composition?: CompositionProjectState;
}

export function cleanProjectName(value: string): string {
  const clean = value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
  return clean || "Untitled project";
}

export function isTrackstarProject(value: unknown): value is TrackstarProject {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<TrackstarProject>;
  return (
    v.version === 1 &&
    typeof v.name === "string" &&
    typeof v.savedAt === "string" &&
    typeof v.bpm === "number" &&
    Number.isFinite(v.bpm) &&
    typeof v.bars === "number" &&
    Number.isFinite(v.bars) &&
    !!v.mixer &&
    v.mixer.version === 1 &&
    Array.isArray(v.mixer.tracks)
  );
}

/**
 * Drum state from a restored project, or null if it is missing or damaged.
 * Deliberately separate from isTrackstarProject: a corrupt drum pattern should
 * cost the user their beat, not the recorded audio in the same project.
 */
export function sanitizeDrumState(value: unknown): DrumProjectState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<DrumProjectState>;
  const custom = normalizeDrumPattern(v.custom);
  if (!isDrumPatternChoice(v.choice) || !custom) return null;
  return { choice: v.choice, custom };
}

export function sanitizeCompositionState(value: unknown): CompositionProjectState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<CompositionProjectState>;
  if (typeof v.bassOn !== "boolean" || !isBassPattern(v.bass) || !isTrackArrangement(v.arrangement)) {
    return null;
  }
  return { bassOn: v.bassOn, bass: v.bass, arrangement: v.arrangement };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open project storage."));
  });
}

export async function saveAutosave(project: TrackstarProject): Promise<void> {
  if (!isTrackstarProject(project)) throw new Error("Invalid project data.");
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(project, AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save project."));
      tx.onabort = () => reject(tx.error ?? new Error("Project save was cancelled."));
    });
  } finally {
    db.close();
  }
}

export async function loadAutosave(): Promise<TrackstarProject | null> {
  const db = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(AUTOSAVE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not load project."));
    });
    return isTrackstarProject(value) ? value : null;
  } finally {
    db.close();
  }
}

export async function clearAutosave(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear project."));
    });
  } finally {
    db.close();
  }
}
