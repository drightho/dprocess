// The "recently visited projects" list lives in the browser's localStorage:
// it belongs to the browser profile, not to the server. Everything here must
// survive missing, blocked, full or corrupt storage, so no function throws.

export const RECENT_KEY = "dprocess.recentProjects";
export const MAX_RECENT = 10;

export interface RecentProject {
  id: number;
  name: string;
  /** ISO 8601 timestamp of the last visit. */
  visitedAt: string;
}

/** The part of the Storage API used here (handy to fake in tests). */
export type Store = Pick<Storage, "getItem" | "setItem">;

/** localStorage, or null when the browser blocks it (private window, site data disabled). */
export function browserStorage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecent(v: unknown): v is RecentProject {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "number" &&
    Number.isInteger(r.id) &&
    r.id > 0 &&
    typeof r.name === "string" &&
    r.name !== "" &&
    typeof r.visitedAt === "string" &&
    !Number.isNaN(Date.parse(r.visitedAt))
  );
}

/**
 * The visited projects, newest first, at most MAX_RECENT. Missing, unreadable
 * or corrupt data gives an empty list; invalid entries are skipped and a
 * project that appears twice keeps its newest visit.
 */
export function readRecent(store: Store | null = browserStorage()): RecentProject[] {
  if (!store) return [];
  let parsed: unknown;
  try {
    const raw = store.getItem(RECENT_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const newestFirst = (a: RecentProject, b: RecentProject) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt);
  const seen = new Set<number>();
  const result: RecentProject[] = [];
  for (const r of parsed.filter(isRecent).sort(newestFirst)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    result.push({ id: r.id, name: r.name, visitedAt: r.visitedAt });
  }
  return result.slice(0, MAX_RECENT);
}

function write(store: Store, items: RecentProject[]): void {
  try {
    store.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    // Quota exceeded or storage blocked: the list is a convenience, so give up quietly.
  }
}

/** Records a visit: the project moves to the top (no duplicates), the list stays capped. */
export function recordVisit(
  project: { id: number; name: string },
  now: Date = new Date(),
  store: Store | null = browserStorage(),
): RecentProject[] {
  const entry: RecentProject = { id: project.id, name: project.name, visitedAt: now.toISOString() };
  const items = [entry, ...readRecent(store).filter((r) => r.id !== project.id)].slice(0, MAX_RECENT);
  if (store) write(store, items);
  return items;
}

/** Forgets projects that no longer exist. Writes only when something was removed. */
export function pruneRecent(
  existingIds: ReadonlySet<number>,
  store: Store | null = browserStorage(),
): RecentProject[] {
  const current = readRecent(store);
  const kept = current.filter((r) => existingIds.has(r.id));
  if (store && kept.length !== current.length) write(store, kept);
  return kept;
}
