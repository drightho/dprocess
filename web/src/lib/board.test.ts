import { epic, story } from "../test/fixtures";
import {
  applyFilters,
  epicProgress,
  filterOptions,
  groupByState,
  hasFilters,
  NO_FILTERS,
  readFilters,
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
