import type { MixerProjectSnapshot } from "./producerMixer";

const DB_NAME = "trackstar-studio";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const AUTOSAVE_KEY = "autosave";

export interface TrackstarProject {
  version: 1;
  name: string;
  savedAt: string;
  bpm: number;
  bars: number;
  mixer: MixerProjectSnapshot;
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
