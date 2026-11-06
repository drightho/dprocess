import { epic, story } from "../test/fixtures";
import { dependencyCandidates } from "./dependencies";

const epics = [epic({ id: 1, name: "Auth" }), epic({ id: 2, name: "Billing" }), epic({ id: 3, name: "Empty" })];
const me = { id: 1, project_id: 1, depends_on: [{ id: 2 }], dependents: [{ id: 3 }] };
const all = [
  story({ id: 1, epic_id: 1, project_id: 1, name: "Me" }),
  story({ id: 2, epic_id: 1, project_id: 1, name: "Already a dependency" }),
  story({ id: 3, epic_id: 1, project_id: 1, name: "Depends on me" }),
  story({ id: 4, epic_id: 1, project_id: 1, name: "Free in Auth" }),
  story({ id: 6, epic_id: 2, project_id: 1, name: "Free in Billing, later id" }),
  story({ id: 5, epic_id: 2, project_id: 1, name: "Free in Billing" }),
  story({ id: 7, epic_id: 9, project_id: 2, name: "Other project" }),
];
const names = (g: ReturnType<typeof dependencyCandidates>) => g.map((x) => [x.epicName, x.stories.map((s) => s.id)]);

describe("dependencyCandidates", () => {
  it("offers the free stories of the project grouped by epic, ordered by id", () => {
    expect(names(dependencyCandidates(me, all, epics))).toEqual([["Auth", [4]], ["Billing", [5, 6]]]);
  });

  it("leaves out the story itself, its dependencies and its direct dependents", () => {
    const offered = dependencyCandidates(me, all, epics).flatMap((g) => g.stories.map((s) => s.id));
    for (const excluded of [1, 2, 3]) expect(offered).not.toContain(excluded);
  });

  it("never offers a story of another project", () => {
    const offered = dependencyCandidates(me, all, epics).flatMap((g) => g.stories.map((s) => s.id));
    expect(offered).not.toContain(7);
  });

  it("keeps finished and cancelled stories: the server decides whether that is sensible", () => {
    const stories = [...all, story({ id: 8, epic_id: 1, project_id: 1, name: "Done", state: "finished" }), story({ id: 9, epic_id: 1, project_id: 1, name: "Dropped", state: "cancelled" })];
    expect(names(dependencyCandidates(me, stories, epics))[0]).toEqual(["Auth", [4, 8, 9]]);
  });

  it("drops epics without candidates and keeps the epics' order", () => {
    const reversed = [epics[1], epics[0], epics[2]];
    expect(names(dependencyCandidates(me, all, reversed)).map((g) => g[0])).toEqual(["Billing", "Auth"]);
  });

  it("still offers stories whose epic is not in the list", () => {
    const orphan = story({ id: 10, epic_id: 42, project_id: 1, name: "Orphan" });
    expect(names(dependencyCandidates(me, [orphan], epics))).toEqual([["Epic #42", [10]]]);
  });

  it("offers nothing when there is no other story", () => {
    expect(dependencyCandidates(me, [all[0]], epics)).toEqual([]);
    expect(dependencyCandidates(me, [], epics)).toEqual([]);
  });
});
