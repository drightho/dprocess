import type { Schemas } from "../api/client";

export type Story = Schemas["Story"];
export type Epic = Schemas["Epic"];
export type StoryState = Schemas["StoryState"];

/** Board columns in workflow order. */
export const STORY_STATES: readonly StoryState[] = [
  "draft",
  "review",
  "design",
  "implementation",
  "ready_for_testing",
  "testing",
  "pr_review",
  "finished",
  "cancelled",
];

/** Finished and cancelled stories are frozen: the server refuses to modify them. */
export const isTerminal = (s: { state: string }): boolean => s.state === "finished" || s.state === "cancelled";

/** The epics that can still get stories (not finished or cancelled), in the order given. A convenience: the server decides. */
export function openEpics<T extends { state: string }>(epics: readonly T[]): T[] {
  return epics.filter((e) => !isTerminal(e));
}

/** Warning the server attaches to stories estimated above 400 lines. */
export const WARN_LOC = "estimate_exceeds_400_loc";

/** Board filters. An empty string / null means "any". */
export interface Filters {
  epic: number | null;
  assignee: string;
  tag: string;
}

export const NO_FILTERS: Filters = { epic: null, assignee: "", tag: "" };

export function hasFilters(f: Filters): boolean {
  return f.epic !== null || f.assignee !== "" || f.tag !== "";
}

/** The assignees and tags that occur in a project's stories, sorted. */
export function filterOptions(stories: readonly Story[]): { assignees: string[]; tags: string[] } {
  const assignees = new Set<string>();
  const tags = new Set<string>();
  for (const s of stories) {
    if (s.assignee) assignees.add(s.assignee);
    for (const t of s.tags) tags.add(t);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  return { assignees: [...assignees].sort(byName), tags: [...tags].sort(byName) };
}

/**
 * Reads the filters from the URL's query string. Values that do not match
 * anything in the project (a deleted epic, a tag nobody uses any more) are
 * ignored instead of producing an empty board that cannot be explained.
 */
export function readFilters(
  params: URLSearchParams,
  epics: readonly Epic[],
  stories: readonly Story[],
): Filters {
  const rawEpic = params.get("epic") ?? "";
  const epicId = /^[1-9]\d*$/.test(rawEpic) ? Number(rawEpic) : null;
  const { assignees, tags } = filterOptions(stories);
  const assignee = params.get("assignee") ?? "";
  const tag = params.get("tag") ?? "";
  return {
    epic: epicId !== null && epics.some((e) => e.id === epicId) ? epicId : null,
    assignee: assignees.includes(assignee) ? assignee : "",
    tag: tags.includes(tag) ? tag : "",
  };
}

/** Serialises filters to a query string, leaving out the unset ones. */
export function writeFilters(f: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.epic !== null) params.set("epic", String(f.epic));
  if (f.assignee) params.set("assignee", f.assignee);
  if (f.tag) params.set("tag", f.tag);
  return params;
}

/** Keeps the stories that satisfy every set filter. */
export function applyFilters(stories: readonly Story[], f: Filters): Story[] {
  return stories.filter(
    (s) =>
      (f.epic === null || s.epic_id === f.epic) &&
      (f.assignee === "" || s.assignee === f.assignee) &&
      (f.tag === "" || s.tags.includes(f.tag)),
  );
}

/** Groups stories by state, preserving their order. Every state has an entry. */
export function groupByState(stories: readonly Story[]): Record<StoryState, Story[]> {
  const groups = Object.fromEntries(STORY_STATES.map((s) => [s, [] as Story[]])) as Record<
    StoryState,
    Story[]
  >;
  for (const s of stories) groups[s.state].push(s);
  return groups;
}

/** The states that have at least one of the given stories, in workflow order (a fresh array). */
export function nonEmptyStates(stories: readonly Story[]): StoryState[] {
  const used = new Set(stories.map((s) => s.state));
  return STORY_STATES.filter((state) => used.has(state));
}

/** How many of an epic's stories exist and how many are finished or cancelled. */
export function epicProgress(
  epicId: number,
  stories: readonly Story[],
): { total: number; finished: number; cancelled: number } {
  let total = 0;
  let finished = 0;
  let cancelled = 0;
  for (const s of stories) {
    if (s.epic_id !== epicId) continue;
    total++;
    if (s.state === "finished") finished++;
    if (s.state === "cancelled") cancelled++;
  }
  return { total, finished, cancelled };
}

/** The most story cards a board lane shows until it is expanded. */
export const LANE_LIMIT = 5;

/**
 * A lane's stories, most recently updated first (a higher id first when
 * updated_at is equal). Returns a fresh array; the input is not changed.
 */
// TODO story 94
export function sortByRecentUpdate<T extends { id: number; updated_at: string }>(_stories: readonly T[]): T[] {
  throw new Error("not implemented");
}

/**
 * The cards a lane shows: its first LANE_LIMIT stories while capped, all of
 * them when expanded. Expects the stories already sorted; returns a fresh array.
 */
// TODO story 94
export function capLane<T>(_stories: readonly T[], _expanded: boolean): T[] {
  throw new Error("not implemented");
}
