import type { Epic, Story } from "./board";

export interface CandidateGroup {
  epicId: number;
  epicName: string;
  stories: Story[];
}

/**
 * The stories a story may be made to depend on, grouped by epic.
 *
 * Only stories of the same project are offered (the server requires it), and
 * not the story itself, the ones it already depends on, or the ones that
 * already depend on it (adding one of those would obviously create a cycle).
 * Longer cycles are left to the server, which explains them. Epics keep their
 * order and empty groups are dropped; stories are ordered by id.
 */
export function dependencyCandidates(
  story: { id: number; project_id: number; depends_on: readonly { id: number }[]; dependents: readonly { id: number }[] },
  projectStories: readonly Story[],
  epics: readonly Epic[],
): CandidateGroup[] {
  const excluded = new Set<number>([story.id, ...story.depends_on.map((d) => d.id), ...story.dependents.map((d) => d.id)]);
  const eligible = projectStories.filter((s) => s.project_id === story.project_id && !excluded.has(s.id));

  const groups: CandidateGroup[] = [];
  const byEpic = new Map<number, Story[]>();
  for (const s of eligible) byEpic.set(s.epic_id, [...(byEpic.get(s.epic_id) ?? []), s]);
  for (const e of epics) {
    const list = byEpic.get(e.id);
    if (list) groups.push({ epicId: e.id, epicName: e.name, stories: [...list].sort((a, b) => a.id - b.id) });
    byEpic.delete(e.id);
  }
  // Stories whose epic is not in the list (should not happen) are still offered.
  for (const [epicId, list] of byEpic) groups.push({ epicId, epicName: `Epic #${epicId}`, stories: [...list].sort((a, b) => a.id - b.id) });
  return groups;
}
