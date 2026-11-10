import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { isTerminal } from "../lib/board";
import { githubLabel } from "../lib/github";
import RemoteStatusBadge from "./RemoteStatusBadge";
import RepoWarningBadge from "./RepoWarningBadge";

type StoryDetail = Schemas["StoryDetail"];

/**
 * The GitHub pull requests linked to a story. They are part of the story, so
 * finished and cancelled stories show them read-only. Only canonical
 * github.com pull request URLs are accepted, and only the server checks that:
 * its message is shown inside the form when it refuses one.
 */
export default function PullRequestSection({ story }: { story: StoryDetail }) {
  const queryClient = useQueryClient();
  const frozen = isTerminal(story);
  const [url, setUrl] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["story", story.id] });

  const add = useMutation({
    mutationFn: () => unwrap(api.POST("/stories/{id}/pull-requests", { params: { path: { id: story.id } }, body: { github_url: url } })),
    onSuccess: async () => {
      setUrl("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (prId: number) => unwrap(api.DELETE("/stories/{id}/pull-requests/{prId}", { params: { path: { id: story.id, prId } } })),
    onMutate: () => add.reset(),
    onSuccess: refresh,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  return (
    <section aria-label="Pull requests">
      {story.pull_requests.length === 0 ? (
        <p className="empty">No pull requests linked.</p>
      ) : (
        <ul className="refs">
          {story.pull_requests.map((pr) => (
            <li key={pr.id}>
              <a href={pr.github_url} target="_blank" rel="noopener noreferrer">
                {githubLabel(pr)}
              </a>{" "}
              <RemoteStatusBadge status={pr.remote_status} />
              <RepoWarningBadge warnings={pr.warnings} />
              {!frozen && (
                <>
                  {" "}
                  <button type="button" aria-label={`Remove pull request ${githubLabel(pr)}`} disabled={remove.isPending} onClick={() => remove.mutate(pr.id)}>
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.isError && (
        <p role="alert" className="error">
          {remove.error.message}
        </p>
      )}
      {frozen ? (
        <p className="empty">The pull request links of a {story.state} story can no longer be changed.</p>
      ) : (
        // Typing dismisses the server's last complaint: it was about what was submitted, not what is typed now.
        <form className="inline wide" onSubmit={submit} onChange={() => add.isError && add.reset()} aria-label="Link pull request">
          <label>
            GitHub pull request URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123" />
          </label>
          <button type="submit" disabled={url.trim() === "" || add.isPending}>
            Link pull request
          </button>
          {add.isError && (
            <p role="alert" className="error" style={{ flexBasis: "100%" }}>
              {add.error.message}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
