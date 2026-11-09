/** "owner/repo#42": how an issue or pull request is named in the UI. */
export const githubLabel = (x: { github_repo: string; number: number }): string => `${x.github_repo}#${x.number}`;

type Remote = { state: string; title: string; checked_at: string | null };
const KNOWN = ["open", "closed", "merged"];

/**
 * How cached GitHub status is shown. The server already reports "unknown" for
 * status that was never synced or is stale; anything else we do not recognise
 * is shown as unknown too, rather than guessed at.
 */
export function remoteDisplay(r: Remote | undefined, formatTime: (iso: string) => string): { state: string; hint: string } {
  if (!r || !KNOWN.includes(r.state)) {
    return { state: "unknown", hint: r?.checked_at ? `Status unavailable (last checked ${formatTime(r.checked_at)})` : "Status unavailable" };
  }
  const when = r.checked_at ? `checked ${formatTime(r.checked_at)}` : "";
  return { state: r.state, hint: [r.title, when].filter(Boolean).join(" - ") };
}

// Story 79 stubs (design phase): the implementation replaces these.
export const repoWarningMessage = (_code: string): string | null => null;
export const repoLabel = (_url: string): string => "";
