import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, unwrap, type Schemas } from "../api/client";
import IssueForm from "../components/IssueForm";
import IssueStoryForm from "../components/IssueStoryForm";
import NotFoundNotice from "../components/NotFoundNotice";
import { openEpics } from "../lib/board";
import { formatTime } from "../lib/format";
import { githubLabel } from "../lib/github";
import RemoteStatusBadge from "../components/RemoteStatusBadge";
import RepoWarningBadge from "../components/RepoWarningBadge";

type Issue = Schemas["Issue"];

/** The story filter lives in the URL: "?story=ID" shows one story's issues, "?story=none" the unlinked ones. */
function readStoryFilter(raw: string | null, storyIds: ReadonlySet<number>): string {
  if (raw === "none") return "none";
  return raw !== null && /^[1-9]\d*$/.test(raw) && storyIds.has(Number(raw)) ? raw : "";
}

/** A project's references to GitHub issues, optionally linked to its stories. */
export default function IssuesPage() {
  const { projectId } = useParams();
  const id = /^[1-9]\d*$/.test(projectId ?? "") ? Number(projectId) : null;
  const enabled = id !== null;
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  // At most one card has a form open, and it is either the Edit form or the Create story form.
  const [open, setOpen] = useState<{ issueId: number; form: "edit" | "create" } | null>(null);
  // Stories created from an issue whose link then failed, by issue: the story was kept.
  const [linkFailures, setLinkFailures] = useState<Record<number, { storyId: number; message: string }>>({});

  const project = useQuery({ queryKey: ["project", id], enabled, queryFn: () => unwrap(api.GET("/projects/{id}", { params: { path: { id: id! } } })) });
  const issues = useQuery({ queryKey: ["project", id, "issues"], enabled, queryFn: () => unwrap(api.GET("/projects/{id}/issues", { params: { path: { id: id! } } })) });
  const stories = useQuery({ queryKey: ["project", id, "stories"], enabled, queryFn: () => unwrap(api.GET("/projects/{id}/stories", { params: { path: { id: id! } } })) });
  // Only for creating a story from an issue; the page does not wait for it.
  const epics = useQuery({ queryKey: ["project", id, "epics"], enabled, queryFn: () => unwrap(api.GET("/projects/{id}/epics", { params: { path: { id: id! } } })) });

  const remove = useMutation({
    mutationFn: (issueId: number) => unwrap(api.DELETE("/issues/{id}", { params: { path: { id: issueId } } })),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", id] }),
        queryClient.invalidateQueries({ queryKey: ["story"] }),
      ]),
  });

  if (id === null) return <NotFoundNotice what="Project" />;
  const error = project.error ?? issues.error ?? stories.error;
  if (error instanceof ApiError && error.status === 404) return <NotFoundNotice what="Project" />;
  if (error) {
    return (
      <section className="narrow">
        <p role="alert" className="error">
          Could not load the issues: {error.message}
        </p>
        <button
          type="button"
          onClick={() => {
            void project.refetch();
            void issues.refetch();
            void stories.refetch();
          }}
        >
          Try again
        </button>
      </section>
    );
  }
  if (!project.data || !issues.data || !stories.data) return <p>Loading...</p>;

  const storyById = new Map(stories.data.map((s) => [s.id, s]));
  const pickable = epics.data ? openEpics(epics.data) : null;
  const openForm = (issueId: number, form: "edit" | "create") => {
    setLinkFailures(({ [issueId]: _dropped, ...rest }) => rest);
    setOpen({ issueId, form });
  };
  const filter = readStoryFilter(params.get("story"), new Set(storyById.keys()));
  const shown: Issue[] = issues.data
    .filter((i) => (filter === "" ? true : filter === "none" ? i.story_id === null : i.story_id === Number(filter)))
    .sort((a, b) => b.id - a.id); // newest first

  return (
    <div className="medium">
      <p>
        <Link to={`/projects/${id}`}>&larr; {project.data.name}</Link>
      </p>
      <h1>Issues</h1>
      <p className="meta">References to GitHub issues. DProcess stores the link; it contacts GitHub (status badges, issue import) only when the server's optional sync is on, and its only write there is assigning imported issues to the token owner.</p>

      {adding ? (
        <IssueForm projectId={id} stories={stories.data} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : (
        <p>
          <button type="button" onClick={() => setAdding(true)}>
            Add issue
          </button>
        </p>
      )}

      {issues.data.length > 0 && (
        <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Issue filter">
          <label>
            Story
            <select
              value={filter}
              onChange={(e) => setParams(e.target.value === "" ? {} : { story: e.target.value }, { replace: true })}
            >
              <option value="">All issues</option>
              <option value="none">Not linked to a story</option>
              {stories.data.map((s) => (
                <option key={s.id} value={s.id}>
                  #{s.id} {s.name}
                </option>
              ))}
            </select>
          </label>
        </form>
      )}

      {remove.isError && (
        <p role="alert" className="error">
          {remove.error.message}
        </p>
      )}
      {issues.data.length === 0 ? (
        <p className="empty">This project has no issues yet.</p>
      ) : shown.length === 0 ? (
        <p className="empty">
          No issues match the filter.{" "}
          <button type="button" onClick={() => setParams({}, { replace: true })}>
            Show all issues
          </button>
        </p>
      ) : (
        <ul className="cards">
          {shown.map((i) =>
            open?.issueId === i.id && open.form === "edit" ? (
              <li key={i.id} className="card">
                <IssueForm projectId={id} stories={stories.data} issue={i} onDone={() => setOpen(null)} onCancel={() => setOpen(null)} />
              </li>
            ) : (
              <li key={i.id} className="card">
                <span className="card-head">
                  <strong>
                    <a href={i.github_url} target="_blank" rel="noopener noreferrer">
                      {githubLabel(i)}
                    </a>{" "}
                    <RemoteStatusBadge status={i.remote_status} />
                    <RepoWarningBadge warnings={i.warnings} />
                    {i.title && <> {i.title}</>}
                  </strong>
                  {i.kind && <span className="chip">{i.kind}</span>}
                </span>
                <span className="meta">
                  {i.story_id !== null && storyById.has(i.story_id) ? (
                    <>
                      Story: <Link to={`/stories/${i.story_id}`}>#{i.story_id} {storyById.get(i.story_id)!.name}</Link>
                    </>
                  ) : (
                    "Not linked to a story"
                  )}
                  {" · added "}
                  {formatTime(i.created_at)}
                </span>
                {linkFailures[i.id] && (
                  <span className="meta">
                    <span role="alert" className="error">
                      {linkFailures[i.id].message}
                    </span>{" "}
                    <Link to={`/stories/${linkFailures[i.id].storyId}`}>Story #{linkFailures[i.id].storyId}</Link> was created but not linked to this issue.
                  </span>
                )}
                {open?.issueId === i.id && open.form === "create" ? (
                  <IssueStoryForm
                    projectId={id}
                    issue={i}
                    epics={pickable ?? []}
                    onCancel={() => setOpen(null)}
                    onLinkFailed={(story, message) => {
                      setOpen(null);
                      setLinkFailures((f) => ({ ...f, [i.id]: { storyId: story.id, message } }));
                    }}
                  />
                ) : (
                  <span className="actions">
                    <button type="button" aria-label={`Edit issue ${githubLabel(i)}`} onClick={() => openForm(i.id, "edit")}>
                      Edit
                    </button>
                    {i.story_id === null && (
                      <button
                        type="button"
                        aria-label={`Create story from issue ${githubLabel(i)}`}
                        disabled={pickable === null || pickable.length === 0}
                        onClick={() => openForm(i.id, "create")}
                      >
                        Create story
                      </button>
                    )}
                    <button type="button" className="danger" aria-label={`Remove issue ${githubLabel(i)}`} disabled={remove.isPending} onClick={() => remove.mutate(i.id)}>
                      Remove
                    </button>
                    {i.story_id === null && pickable !== null && pickable.length === 0 && <span className="meta">no open epic; create one first</span>}
                    {i.story_id === null && epics.isError && <span className="meta">{epics.error.message}</span>}
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
