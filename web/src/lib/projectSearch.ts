/**
 * Projects whose name equals the query, ignoring case and surrounding spaces.
 * Project names are not unique, so there can be several; when some of them
 * match the query's exact letter case, only those are returned.
 */
export function findProjectsByName<T extends { name: string }>(projects: readonly T[], query: string): T[] {
  const wanted = query.trim();
  if (wanted === "") return [];
  const sameCase = projects.filter((p) => p.name === wanted);
  if (sameCase.length > 0) return sameCase;
  const lower = wanted.toLowerCase();
  return projects.filter((p) => p.name.toLowerCase() === lower);
}
