import { epic, story } from "../test/fixtures";
import {
  applyFilters,
  capLane,
  epicProgress,
  filterOptions,
  groupByState,
  hasFilters,
  LANE_LIMIT,
  NO_FILTERS,
  nonEmptyStates,
  openEpics,
  readFilters,
  sortByRecentUpdate,
  STORY_STATES,
  writeFilters,
} from "./board";

const epics = [epic({ id: 1, name: "Auth" }), epic({ id: 2, name: "Billing" })];
const stories = [
  story({ id: 1, epic_id: 1, state: "finished", assignee: "ann", tags: ["api", "backend"] }),
  story({ id: 2, epic_id: 1, state: "implementation", assignee: "ann", tags: ["backend"] }),
  story({ id: 3, epic_id: 2, state: "draft", assignee: "bob", tags: ["frontend"] }),
  story({ id: 4, epic_id: 2, state: "cancelled", assignee: "", tags: [] }),
];
const ids = (ss: { id: number }[]) => ss.map((s) => s.id);

describe("filterOptions", () => {
  it("lists distinct assignees and tags, sorted, without blanks", () => {
    expect(filterOptions(stories)).toEqual({
      assignees: ["ann", "bob"],
      tags: ["api", "backend", "frontend"],
    });
    expect(filterOptions([])).toEqual({ assignees: [], tags: [] });
  });
});

describe("readFilters / writeFilters", () => {
  const read = (qs: string) => readFilters(new URLSearchParams(qs), epics, stories);

  it("reads valid values", () => {
    expect(read("epic=2&assignee=bob&tag=frontend")).toEqual({ epic: 2, assignee: "bob", tag: "frontend" });
  });

  it("defaults to no filters", () => {
    expect(read("")).toEqual(NO_FILTERS);
  });

  it("ignores values that match nothing in the project", () => {
    expect(read("epic=99&assignee=zed&tag=nope")).toEqual(NO_FILTERS);
    // Only the bad part is dropped.
    expect(read("epic=1&tag=nope")).toEqual({ epic: 1, assignee: "", tag: "" });
  });

  it("rejects malformed epic ids", () => {
    for (const bad of ["abc", "1abc", "0", "-1", "1.5", " 1", ""]) {
      expect(read(`epic=${encodeURIComponent(bad)}`).epic).toBeNull();
    }
  });

  it("round-trips and leaves unset filters out of the URL", () => {
    const f = { epic: 1, assignee: "ann", tag: "api" };
    expect(readFilters(writeFilters(f), epics, stories)).toEqual(f);
    expect(writeFilters(NO_FILTERS).toString()).toBe("");
    expect(writeFilters({ epic: null, assignee: "", tag: "api" }).toString()).toBe("tag=api");
  });

  it("detects whether any filter is set", () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, tag: "api" })).toBe(true);
    expect(hasFilters({ ...NO_FILTERS, epic: 1 })).toBe(true);
  });
});

describe("applyFilters", () => {
  it("returns everything without filters", () => {
    expect(ids(applyFilters(stories, NO_FILTERS))).toEqual([1, 2, 3, 4]);
  });

  it("filters by each field", () => {
    expect(ids(applyFilters(stories, { ...NO_FILTERS, epic: 2 }))).toEqual([3, 4]);
    expect(ids(applyFilters(stories, { ...NO_FILTERS, assignee: "ann" }))).toEqual([1, 2]);
    expect(ids(applyFilters(stories, { ...NO_FILTERS, tag: "backend" }))).toEqual([1, 2]);
  });

  it("combines filters with AND", () => {
    expect(ids(applyFilters(stories, { epic: 1, assignee: "ann", tag: "api" }))).toEqual([1]);
    expect(ids(applyFilters(stories, { epic: 2, assignee: "ann", tag: "" }))).toEqual([]);
  });
});

describe("groupByState", () => {
  it("has a group for every state, even when empty, in workflow order", () => {
    const g = groupByState([]);
    expect(Object.keys(g)).toEqual([...STORY_STATES]);
    expect(Object.values(g).every((l) => l.length === 0)).toBe(true);
  });

  it("places stories by state and keeps their order", () => {
    const g = groupByState([...stories, story({ id: 5, state: "draft" })]);
    expect(ids(g.draft)).toEqual([3, 5]);
    expect(ids(g.finished)).toEqual([1]);
    expect(ids(g.implementation)).toEqual([2]);
    expect(ids(g.cancelled)).toEqual([4]);
  });
});

describe("nonEmptyStates", () => {
  it("is empty when there are no stories", () => {
    expect(nonEmptyStates([])).toEqual([]);
  });

  it("lists only the states that have stories", () => {
    expect(nonEmptyStates(stories)).toEqual(["draft", "implementation", "finished", "cancelled"]);
  });

  it("keeps workflow order whatever the order of the stories", () => {
    const shuffled = [
      story({ id: 1, state: "cancelled" }),
      story({ id: 2, state: "testing" }),
      story({ id: 3, state: "draft" }),
      story({ id: 4, state: "finished" }),
      story({ id: 5, state: "draft" }),
    ];
    expect(nonEmptyStates(shuffled)).toEqual(["draft", "testing", "finished", "cancelled"]);
  });

  it("treats finished and cancelled like any other state", () => {
    expect(nonEmptyStates([story({ id: 1, state: "finished" })])).toEqual(["finished"]);
    expect(nonEmptyStates([story({ id: 1, state: "cancelled" })])).toEqual(["cancelled"]);
    expect(nonEmptyStates([story({ id: 1, state: "draft" })])).toEqual(["draft"]);
  });

  it("returns every state when every state has a story", () => {
    const all = STORY_STATES.map((state, i) => story({ id: i + 1, state }));
    expect(nonEmptyStates(all)).toEqual([...STORY_STATES]);
  });

  it("returns a fresh array and leaves STORY_STATES alone", () => {
    const all = STORY_STATES.map((state, i) => story({ id: i + 1, state }));
    const before = [...STORY_STATES];
    const out = nonEmptyStates(all);
    expect(out).not.toBe(STORY_STATES);
    out.reverse();
    expect([...STORY_STATES]).toEqual(before);
  });
});

describe("epicProgress", () => {
  it("counts total, finished and cancelled stories of one epic", () => {
    expect(epicProgress(1, stories)).toEqual({ total: 2, finished: 1, cancelled: 0 });
    expect(epicProgress(2, stories)).toEqual({ total: 2, finished: 0, cancelled: 1 });
    expect(epicProgress(3, stories)).toEqual({ total: 0, finished: 0, cancelled: 0 });
  });
});

describe("ready_for_testing", () => {
  it("sits between implementation and testing", () => {
    const i = STORY_STATES.indexOf("implementation");
    expect([...STORY_STATES].slice(i, i + 3)).toEqual(["implementation", "ready_for_testing", "testing"]);
  });
});

describe("openEpics", () => {
  it("keeps the epics that are not finished or cancelled, in the given order", () => {
    const all = [
      epic({ id: 3, state: "ready" }),
      epic({ id: 1, state: "finished" }),
      epic({ id: 2, state: "draft" }),
      epic({ id: 4, state: "cancelled" }),
      epic({ id: 5, state: "review" }),
    ];
    expect(openEpics(all).map((e) => e.id)).toEqual([3, 2, 5]);
  });

  it("returns nothing when every epic is closed, or there are none", () => {
    expect(openEpics([epic({ state: "finished" }), epic({ state: "cancelled" })])).toEqual([]);
    expect(openEpics([])).toEqual([]);
  });
});

describe("LANE_LIMIT", () => {
  it("is 5", () => {
    expect(LANE_LIMIT).toBe(5);
  });
});

describe("sortByRecentUpdate", () => {
  const at = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;

  it("orders by updated_at, most recent first, whatever the input order", () => {
    const input = [
      story({ id: 1, updated_at: at(3) }),
      story({ id: 2, updated_at: at(9) }),
      story({ id: 3, updated_at: at(1) }),
      story({ id: 4, updated_at: at(7) }),
    ];
    expect(ids(sortByRecentUpdate(input))).toEqual([2, 4, 1, 3]);
    expect(ids(sortByRecentUpdate([...input].reverse()))).toEqual([2, 4, 1, 3]);
  });

  it("puts the higher id first when updated_at is equal", () => {
    const input = [
      story({ id: 4, updated_at: at(5) }),
      story({ id: 9, updated_at: at(5) }),
      story({ id: 1, updated_at: at(8) }),
      story({ id: 6, updated_at: at(5) }),
    ];
    expect(ids(sortByRecentUpdate(input))).toEqual([1, 9, 6, 4]);
    expect(ids(sortByRecentUpdate([...input].reverse()))).toEqual([1, 9, 6, 4]);
    // All identical: by id, descending.
    expect(ids(sortByRecentUpdate([3, 1, 5, 2, 4].map((id) => story({ id }))))).toEqual([5, 4, 3, 2, 1]);
  });

  it("compares timestamps as instants, not as text", () => {
    // Text order would put "…00Z" after "…00.500Z"; as instants .500 is later.
    const later = [
      story({ id: 1, updated_at: "2026-01-02T00:00:00Z" }),
      story({ id: 2, updated_at: "2026-01-02T00:00:00.500Z" }),
    ];
    // The same instant written two ways is a tie, so the higher id comes first.
    const same = [
      story({ id: 3, updated_at: "2026-01-02T00:00:00Z" }),
      story({ id: 4, updated_at: "2026-01-02T00:00:00.000Z" }),
    ];
    for (const input of [later, [...later].reverse()]) expect(ids(sortByRecentUpdate(input))).toEqual([2, 1]);
    for (const input of [same, [...same].reverse()]) expect(ids(sortByRecentUpdate(input))).toEqual([4, 3]);
  });

  it("returns a fresh array and leaves its input alone", () => {
    const input = [story({ id: 1, updated_at: at(1) }), story({ id: 2, updated_at: at(2) })];
    const out = sortByRecentUpdate(input);
    expect(out).not.toBe(input);
    out.reverse();
    expect(ids(input)).toEqual([1, 2]);
    // Also for empty and one-story input.
    const empty: ReturnType<typeof story>[] = [];
    expect(sortByRecentUpdate(empty)).toEqual([]);
    expect(sortByRecentUpdate(empty)).not.toBe(empty);
    const one = [story({ id: 7 })];
    expect(ids(sortByRecentUpdate(one))).toEqual([7]);
    expect(sortByRecentUpdate(one)).not.toBe(one);
  });
});

describe("capLane", () => {
  const lane = (n: number) => Array.from({ length: n }, (_, i) => story({ id: n - i }));

  it("keeps the first LANE_LIMIT stories of a longer lane while capped", () => {
    const seven = lane(LANE_LIMIT + 2);
    expect(ids(capLane(seven, false))).toEqual(ids(seven).slice(0, LANE_LIMIT));
    expect(capLane(seven, false)).toHaveLength(LANE_LIMIT);
  });

  it("keeps every story, in the same order, when expanded", () => {
    const seven = lane(LANE_LIMIT + 2);
    expect(ids(capLane(seven, true))).toEqual(ids(seven));
  });

  it("keeps a lane of LANE_LIMIT or fewer whole, expanded or not", () => {
    for (const n of [0, 1, LANE_LIMIT - 1, LANE_LIMIT]) {
      const l = lane(n);
      expect(ids(capLane(l, false))).toEqual(ids(l));
      expect(ids(capLane(l, true))).toEqual(ids(l));
    }
  });

  it("caps a lane of exactly LANE_LIMIT + 1", () => {
    const six = lane(LANE_LIMIT + 1);
    expect(ids(capLane(six, false))).toEqual(ids(six).slice(0, LANE_LIMIT));
  });

  it("does not reorder: it keeps the order it is given", () => {
    const shuffled = [3, 8, 1, 6, 2, 7, 5].map((id) => story({ id }));
    expect(ids(capLane(shuffled, false))).toEqual([3, 8, 1, 6, 2]);
    expect(ids(capLane(shuffled, true))).toEqual([3, 8, 1, 6, 2, 7, 5]);
  });

  it("returns a fresh array and leaves its input alone", () => {
    for (const n of [3, LANE_LIMIT + 2]) {
      for (const expanded of [false, true]) {
        const l = lane(n);
        const before = ids(l);
        const out = capLane(l, expanded);
        expect(out).not.toBe(l);
        out.reverse();
        expect(ids(l)).toEqual(before);
      }
    }
  });
});
