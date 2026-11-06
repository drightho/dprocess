import { MAX_RECENT, pruneRecent, readRecent, recordVisit, RECENT_KEY, type Store } from "./recent";

/** An in-memory stand-in for localStorage. */
function fakeStore(initial?: string): Store & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(RECENT_KEY, initial);
  const store = {
    data,
    writes: 0,
    getItem: (k: string) => data.get(k) ?? null,
    setItem(k: string, v: string) {
      store.writes++;
      data.set(k, v);
    },
  };
  return store;
}

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
const entry = (id: number, minute: number, name = `P${id}`) => ({ id, name, visitedAt: at(minute) });
const ids = (list: { id: number }[]) => list.map((r) => r.id);

describe("readRecent", () => {
  it("is empty without storage, without data or when reading throws", () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent(fakeStore())).toEqual([]);
    expect(readRecent({ getItem: () => { throw new Error("denied"); }, setItem: () => {} })).toEqual([]);
  });

  it("is empty for corrupt data", () => {
    for (const raw of ["", "{not json", "null", "42", '"text"', '{"id":1}', "[1,2,3]"]) {
      expect(readRecent(fakeStore(raw))).toEqual([]);
    }
  });

  it("returns entries newest first whatever the stored order", () => {
    const store = fakeStore(JSON.stringify([entry(1, 5), entry(2, 30), entry(3, 10)]));
    expect(ids(readRecent(store))).toEqual([2, 3, 1]);
  });

  it("skips invalid entries and keeps the valid ones", () => {
    const store = fakeStore(JSON.stringify([
      entry(1, 1),
      { id: "2", name: "x", visitedAt: at(2) },       // id not a number
      { id: 0, name: "x", visitedAt: at(3) },         // id not positive
      { id: 1.5, name: "x", visitedAt: at(3) },       // id not an integer
      { id: 4, name: "", visitedAt: at(4) },          // empty name
      { id: 5, name: "x", visitedAt: "yesterday" },   // bad date
      { id: 6, name: "x" },                           // no date
      null,
      "junk",
      entry(7, 7),
    ]));
    expect(ids(readRecent(store))).toEqual([7, 1]);
  });

  it("keeps only the newest visit of a duplicated project", () => {
    const store = fakeStore(JSON.stringify([entry(1, 1, "old"), entry(2, 2), entry(1, 9, "new")]));
    const list = readRecent(store);
    expect(ids(list)).toEqual([1, 2]);
    expect(list[0].name).toBe("new");
  });

  it("caps the list at ten entries, dropping the oldest", () => {
    const many = Array.from({ length: 14 }, (_, i) => entry(i + 1, i));
    const list = readRecent(fakeStore(JSON.stringify(many)));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].id).toBe(14);
    expect(list[9].id).toBe(5);
  });

  it("drops unknown properties", () => {
    const store = fakeStore(JSON.stringify([{ ...entry(1, 1), secret: "x" }]));
    expect(Object.keys(readRecent(store)[0]).sort()).toEqual(["id", "name", "visitedAt"]);
  });
});

describe("recordVisit", () => {
  it("stores {id, name, visitedAt} under the documented key", () => {
    const store = fakeStore();
    const now = new Date("2026-03-04T05:06:07.000Z");
    expect(recordVisit({ id: 3, name: "Gamma" }, now, store)).toEqual([
      { id: 3, name: "Gamma", visitedAt: "2026-03-04T05:06:07.000Z" },
    ]);
    expect(JSON.parse(store.data.get(RECENT_KEY)!)).toEqual([
      { id: 3, name: "Gamma", visitedAt: "2026-03-04T05:06:07.000Z" },
    ]);
  });

  it("puts the newest visit first", () => {
    const store = fakeStore();
    recordVisit({ id: 1, name: "A" }, new Date(at(1)), store);
    recordVisit({ id: 2, name: "B" }, new Date(at(2)), store);
    recordVisit({ id: 3, name: "C" }, new Date(at(3)), store);
    expect(ids(readRecent(store))).toEqual([3, 2, 1]);
  });

  it("moves a revisited project to the top without duplicating it, and refreshes its name", () => {
    const store = fakeStore();
    recordVisit({ id: 1, name: "A" }, new Date(at(1)), store);
    recordVisit({ id: 2, name: "B" }, new Date(at(2)), store);
    const list = recordVisit({ id: 1, name: "A renamed" }, new Date(at(3)), store);
    expect(list.map((r) => [r.id, r.name])).toEqual([[1, "A renamed"], [2, "B"]]);
    expect(ids(readRecent(store))).toEqual([1, 2]);
  });

  it("never keeps more than ten, dropping the least recently visited", () => {
    const store = fakeStore();
    for (let i = 1; i <= 12; i++) recordVisit({ id: i, name: `P${i}` }, new Date(at(i)), store);
    const list = readRecent(store);
    expect(list).toHaveLength(10);
    expect(ids(list)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("starts over when the stored data is corrupt", () => {
    const store = fakeStore("{broken");
    expect(ids(recordVisit({ id: 1, name: "A" }, new Date(at(1)), store))).toEqual([1]);
    expect(ids(readRecent(store))).toEqual([1]);
  });

  it("does not throw when storage is missing, blocked or full", () => {
    expect(ids(recordVisit({ id: 1, name: "A" }, new Date(at(1)), null))).toEqual([1]);
    const full: Store = {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
    };
    expect(ids(recordVisit({ id: 1, name: "A" }, new Date(at(1)), full))).toEqual([1]);
  });
});

describe("pruneRecent", () => {
  it("removes projects that no longer exist and persists the result", () => {
    const store = fakeStore(JSON.stringify([entry(1, 3), entry(2, 2), entry(3, 1)]));
    expect(ids(pruneRecent(new Set([1, 3]), store))).toEqual([1, 3]);
    expect(ids(readRecent(store))).toEqual([1, 3]);
  });

  it("leaves storage alone when nothing is removed", () => {
    const store = fakeStore(JSON.stringify([entry(1, 1)]));
    pruneRecent(new Set([1, 2]), store);
    expect(store.writes).toBe(0);
  });

  it("copes with missing storage", () => {
    expect(pruneRecent(new Set([1]), null)).toEqual([]);
  });
});
