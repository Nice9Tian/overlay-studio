export interface CardPreset {
  id: string;
  name: string;
  description?: string;
  kind: string;
  params: Record<string, unknown>;
  createdAt: string;
  source: "ai" | "user";
}

const PRESETS_KEY = "overlayStudioPresets";
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) {
    cb();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PRESETS_KEY) {
      notify();
    }
  });
}

function loadPresets(): CardPreset[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(PRESETS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function savePresets(presets: CardPreset[]) {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  }
  notify();
}

export function listPresets(): CardPreset[] {
  return loadPresets();
}

export function addPreset(p: Omit<CardPreset, "id" | "createdAt">): CardPreset {
  const presets = loadPresets();
  const existingIdx = presets.findIndex((x) => x.name === p.name);
  
  const preset: CardPreset = {
    ...p,
    id: existingIdx >= 0 ? presets[existingIdx].id : crypto.randomUUID(),
    createdAt: existingIdx >= 0 ? presets[existingIdx].createdAt : new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    presets[existingIdx] = preset;
  } else {
    presets.push(preset);
  }

  savePresets(presets);
  return preset;
}

export function removePreset(id: string): void {
  const presets = loadPresets();
  const filtered = presets.filter((p) => p.id !== id);
  if (filtered.length !== presets.length) {
    savePresets(filtered);
  }
}

export function subscribePresets(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
