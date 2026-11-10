import { repoWarningMessage } from "../lib/github";

/**
 * Small badge for the read-time warnings of an issue or pull request. Only
 * warning codes the UI knows get a badge (today repo_mismatch); the server
 * decides whether a warning applies, the UI never recomputes it.
 */
export default function RepoWarningBadge({ warnings }: { warnings: readonly string[] | undefined }) {
  const messages = (warnings ?? []).map(repoWarningMessage).filter((m): m is string => m !== null);
  if (messages.length === 0) return null;
  return (
    <>
      {[...new Set(messages)].map((m) => (
        <span key={m} className="badge warn" title={m} aria-label={m}>
          other repo
        </span>
      ))}
    </>
  );
}
