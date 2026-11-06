import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "../api/client";
import DependencySection from "../components/DependencySection";
import HistoryList from "../components/HistoryList";
import NotFoundNotice from "../components/NotFoundNotice";
import StateBadge from "../components/StateBadge";
import StoryForm from "../components/StoryForm";
import StoryTransitionPanel from "../components/StoryTransitionPanel";
import { isTerminal, WARN_LOC } from "../lib/board";


/** One story: its fields, how to move it between states, its dependencies and its history. */
export default function StoryPage() {
  const { storyId } = useParams();
  const id = /^[1-9]\d*$/.test(storyId ?? "") ? Number(storyId) : null;
  const enabled = id !== null;
  const [editing, setEditing] = useState(false);

  // Both share the ["story", id] prefix so one invalidation refreshes them.
  const story = useQuery({
    queryKey: ["story", id],
    enabled,
    queryFn: () => unwrap(api.GET("/stories/{id}", { params: { path: { id: id! } } })),
  });
  const history = useQuery({
    queryKey: ["story", id, "history"],
    enabled,
    queryFn: () => unwrap(api.GET("/stories/{id}/history", { params: { path: { id: id! } } })),
  });
  const epicId = story.data?.epic_id;
  const epic = useQuery({
    queryKey: ["epic", epicId],
    enabled: epicId !== undefined,
    queryFn: () => unwrap(api.GET("/epics/{id}", { params: { path: { id: epicId! } } })),
  });

  if (id === null) return <NotFoundNotice what="Story" />;
  if (story.error instanceof ApiError && story.error.status === 404) return <NotFoundNotice what="Story" />;
  if (story.error) {
    return (
      <section className="narrow">
        <p role="alert" className="error">
          Could not load the story: {story.error.message}
        </p>
        <button
          type="button"
          onClick={() => {
            void story.refetch();
            void history.refetch();
          }}
        >
          Try again
        </button>
      </section>
    );
  }
  if (!story.data) return <p>Loading...</p>;

  const s = story.data;
  const frozen = isTerminal(s);

  return (
    <div className="medium">
      <p>
        <Link to={`/epics/${s.epic_id}`}>&larr; {epic.data?.name ?? "Epic"}</Link>
      </p>

      {editing && !frozen ? (
        <StoryForm story={s} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <div className="title">
            <h1>{s.name}</h1>
            <StateBadge state={s.state} />
            {frozen ? (
              <span className="chip" title="Finished and cancelled stories cannot be edited">
                read-only
              </span>
            ) : (
              <button type="button" onClick={() => setEditing(true)}>
                Edit story
              </button>
            )}
          </div>
          <p className="meta">Story #{s.id}</p>
          <dl className="fields">
            <dt>Description</dt>
            <dd>{s.description || <span className="empty">No description.</span>}</dd>
            <dt>Acceptance criteria</dt>
            <dd>{s.acceptance_criteria || <span className="empty">None recorded.</span>}</dd>
            <dt>Assignee</dt>
            <dd>{s.assignee || <span className="empty">unassigned</span>}</dd>
            <dt>Estimate</dt>
            <dd>
              {s.estimate_loc === null ? <span className="empty">No estimate</span> : `${s.estimate_loc} lines of code`}
              {s.warnings.map((w) => (
                <span key={w} className="warning" role="note">
                  {" "}
                  {w === WARN_LOC ? "Estimate is over 400 lines; consider splitting the story" : w}
                </span>
              ))}
            </dd>
            {s.tags.length > 0 && (
              <>
                <dt>Tags</dt>
                <dd className="chips">
                  {s.tags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </>
      )}

      <StoryTransitionPanel story={s} />

      <DependencySection story={s} />

      <h2>History</h2>
      {history.isError ? (
        <p role="alert" className="error">
          Could not load the history: {history.error.message}
        </p>
      ) : history.data ? (
        <HistoryList entries={history.data} createdAt={s.created_at} />
      ) : (
        <p>Loading...</p>
      )}
    </div>
  );
}
