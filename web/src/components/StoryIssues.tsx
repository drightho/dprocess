import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { githubLabel } from "../lib/github";
import RemoteStatusBadge from "./RemoteStatusBadge";
import RepoWarningBadge from "./RepoWarningBadge";

type StoryDetail = Schemas["StoryDetail"];

/**
 * The GitHub issues linked to a story. Issue links are not part of the story
 * itself: they stay open on finished and cancelled stories, so an issue can
 * always be unlinked here. Adding and editing issues is done on the project's
 * issues page.
 */
export default function StoryIssues({ story }: { story: StoryDetail }) {
  const queryClient = useQueryClient();
  const unlink = useMutation({
    mutationFn: (issueId: number) => unwrap(api.PATCH("/issues/{id}", { params: { path: { id: issueId } }, body: { story_id: null } })),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["story"] }),
        queryClient.invalidateQueries({ queryKey: ["project", story.project_id] }),
      ]),
  });

  return (
    <section aria-label="Issues">
      {story.issues.length === 0 ? (
        <p className="empty">No issues linked.</p>
      ) : (
        <ul className="refs">
          {story.issues.map((i) => (
            <li key={i.id}>
              <a href={i.github_url} target="_blank" rel="noopener noreferrer">
                {githubLabel(i)}
              </a>{" "}
              <RemoteStatusBadge status={i.remote_status} />
              <RepoWarningBadge warnings={i.warnings} />
              {i.title && <> {i.title}</>}
              {i.kind && <> <span className="chip">{i.kind}</span></>}{" "}
              <button type="button" aria-label={`Unlink issue ${githubLabel(i)}`} disabled={unlink.isPending} onClick={() => unlink.mutate(i.id)}>
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      {unlink.isError && (
        <p role="alert" className="error">
          {unlink.error.message}
        </p>
      )}
      <p>
        <Link to={`/projects/${story.project_id}/issues?story=${story.id}`}>Manage this project's issues</Link>
      </p>
    </section>
  );
}
