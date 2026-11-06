import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "../api/client";
import HistoryList from "../components/HistoryList";
import NotFoundNotice from "../components/NotFoundNotice";
import StateBadge from "../components/StateBadge";
import StoryCard from "../components/StoryCard";
import TransitionPanel from "../components/TransitionPanel";
import { epicProgress } from "../lib/board";

/** One epic: its state (and how to change it), its stories and its history. */
export default function EpicPage() {
  const { epicId } = useParams();
  const id = /^[1-9]\d*$/.test(epicId ?? "") ? Number(epicId) : null;
  const enabled = id !== null;

  // All three share the ["epic", id] prefix so one invalidation refreshes them.
  const epic = useQuery({
    queryKey: ["epic", id],
    enabled,
    queryFn: () => unwrap(api.GET("/epics/{id}", { params: { path: { id: id! } } })),
  });
  const stories = useQuery({
    queryKey: ["epic", id, "stories"],
    enabled,
    queryFn: () => unwrap(api.GET("/epics/{id}/stories", { params: { path: { id: id! } } })),
  });
  const history = useQuery({
    queryKey: ["epic", id, "history"],
    enabled,
    queryFn: () => unwrap(api.GET("/epics/{id}/history", { params: { path: { id: id! } } })),
  });
  const projectId = epic.data?.project_id;
  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: projectId !== undefined,
    queryFn: () => unwrap(api.GET("/projects/{id}", { params: { path: { id: projectId! } } })),
  });

  if (id === null) return <NotFoundNotice what="Epic" />;

  const error = epic.error ?? stories.error;
  if (error instanceof ApiError && error.status === 404) return <NotFoundNotice what="Epic" />;
  if (error) {
    return (
      <section className="narrow">
        <p role="alert" className="error">
          Could not load the epic: {error.message}
        </p>
        <button
          type="button"
          onClick={() => {
            void epic.refetch();
            void stories.refetch();
            void history.refetch();
          }}
        >
          Try again
        </button>
      </section>
    );
  }
  if (!epic.data || !stories.data) return <p>Loading...</p>;

  const e = epic.data;
  const { total, finished, cancelled } = epicProgress(e.id, stories.data);

  return (
    <div className="medium">
      <p>
        <Link to={`/projects/${e.project_id}`}>&larr; {project.data?.name ?? "Project"}</Link>
      </p>
      <div className="title">
        <h1>{e.name}</h1>
        <StateBadge state={e.state} />
      </div>
      {e.description && <p className="meta">{e.description}</p>}
      {e.tags.length > 0 && (
        <p className="chips">
          {e.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </p>
      )}

      <TransitionPanel epic={e} stories={stories.data} />

      <h2>Stories</h2>
      {total === 0 ? (
        <p className="empty">This epic has no stories yet.</p>
      ) : (
        <>
          <p className="meta">
            {finished} of {total} {total === 1 ? "story" : "stories"} finished
            {cancelled > 0 && `, ${cancelled} cancelled`}
          </p>
          <ul className="cards">
            {stories.data.map((s) => (
              <StoryCard key={s.id} story={s} showState />
            ))}
          </ul>
        </>
      )}

      <h2>History</h2>
      {history.isError ? (
        <p role="alert" className="error">
          Could not load the history: {history.error.message}
        </p>
      ) : history.data ? (
        <HistoryList entries={history.data} createdAt={e.created_at} />
      ) : (
        <p>Loading...</p>
      )}
    </div>
  );
}
