import { AUTHOR_KEY, readAuthor, saveAuthor } from "./author";
import type { Store } from "./recent";

function fakeStore(initial?: string): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(AUTHOR_KEY, initial);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("author name", () => {
  it("is remembered and read back", () => {
    const store = fakeStore();
    expect(readAuthor(store)).toBe("");
    saveAuthor("ann", store);
    expect(store.data.get(AUTHOR_KEY)).toBe("ann");
    expect(readAuthor(store)).toBe("ann");
  });

  it("uses browser storage by default", () => {
    saveAuthor("bob");
    expect(readAuthor()).toBe("bob");
    expect(window.localStorage.getItem(AUTHOR_KEY)).toBe("bob");
  });

  it("never throws when storage is missing, blocked or full", () => {
    expect(readAuthor(null)).toBe("");
    expect(() => saveAuthor("x", null)).not.toThrow();
    const blocked: Store = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } };
    expect(readAuthor(blocked)).toBe("");
    expect(() => saveAuthor("x", blocked)).not.toThrow();
  });
});
