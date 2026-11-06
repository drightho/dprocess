import { findProjectsByName } from "./projectSearch";

const projects = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Beta" },
  { id: 3, name: "alpha" },
  { id: 4, name: "Gamma Ray" },
  { id: 5, name: "Beta" },
];
const ids = (l: { id: number }[]) => l.map((p) => p.id);

describe("findProjectsByName", () => {
  it("finds an exact name", () => {
    expect(ids(findProjectsByName(projects, "Gamma Ray"))).toEqual([4]);
  });

  it("ignores letter case and surrounding spaces", () => {
    expect(ids(findProjectsByName(projects, "  gAMMA rAY "))).toEqual([4]);
  });

  it("is an exact match, not a substring or prefix match", () => {
    expect(findProjectsByName(projects, "Gamma")).toEqual([]);
    expect(findProjectsByName(projects, "amma Ray")).toEqual([]);
    expect(findProjectsByName(projects, "Gamma  Ray")).toEqual([]);
  });

  it("returns every project sharing the name", () => {
    expect(ids(findProjectsByName(projects, "Beta"))).toEqual([2, 5]);
  });

  it("prefers the exact letter case when several names differ only in case", () => {
    expect(ids(findProjectsByName(projects, "alpha"))).toEqual([3]);
    expect(ids(findProjectsByName(projects, "Alpha"))).toEqual([1]);
    expect(ids(findProjectsByName(projects, "ALPHA"))).toEqual([1, 3]);
  });

  it("finds nothing for an empty query or an empty list", () => {
    expect(findProjectsByName(projects, "")).toEqual([]);
    expect(findProjectsByName(projects, "   ")).toEqual([]);
    expect(findProjectsByName([], "Alpha")).toEqual([]);
  });
});
