import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "../api/client";
import CommentThread from "../components/CommentThread";
import EpicForm from "../components/EpicForm";
import HistoryList from "../components/HistoryList";
import NotFoundNotice from "../components/NotFoundNotice";
import StateBadge from "../components/StateBadge";
import StoryCard from "../components/StoryCard";
import StoryForm from "../components/StoryForm";
import TagEditor from "../components/TagEditor";
import TransitionPanel from "../components/TransitionPanel";
import { epicProgress, isTerminal } from "../lib/board";

/** One epic: its state (and how to change it), its stories and its history. */
export default function EpicPage() {
  const { epicId } = useParams();
  const id = /^[1-9]\d*$/.test(epicId ?? "") ? Number(epicId) : null;
  const enabled = id !== null;
  const [editingEpic, setEditingEpic] = useState(false);
  const [creatingStory, setCreatingStory] = useState(false);
  const [editingStory, setEditingStory] = useState<number | null>(null);

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
  const closed = e.state === "finished" || e.state === "cancelled";

  return (
    <div className="medium">
      <p>
        <Link to={`/projects/${e.project_id}`}>&larr; {project.data?.name ?? "Project"}</Link>
      </p>
      {editingEpic ? (
        <EpicForm epic={e} onDone={() => setEditingEpic(false)} onCancel={() => setEditingEpic(false)} />
      ) : (
        <>
          <div className="title">
            <h1>{e.name}</h1>
            <StateBadge state={e.state} />
            <button type="button" onClick={() => setEditingEpic(true)}>
              Edit epic
            </button>
          </div>
          {e.description && <p className="meta">{e.description}</p>}
        </>
      )}

      <h2>Tags</h2>
      <TagEditor kind="epic" id={e.id} projectId={e.project_id} tags={e.tags} />

      <TransitionPanel epic={e} stories={stories.data} />

      <h2>Stories</h2>
      {closed ? (
        <p className="empty">This epic is {e.state} and accepts no new stories.</p>
      ) : creatingStory ? (
        <StoryForm epicId={e.id} onDone={() => setCreatingStory(false)} onCancel={() => setCreatingStory(false)} />
      ) : (
        <p>
          <button type="button" onClick={() => setCreatingStory(true)}>
            New story
          </button>
        </p>
      )}
      {total === 0 ? (
        <p className="empty">This epic has no stories yet.</p>
      ) : (
        <>
          <p className="meta">
            {finished} of {total} {total === 1 ? "story" : "stories"} finished
            {cancelled > 0 && `, ${cancelled} cancelled`}
          </p>
          <ul className="cards">
            {stories.data.map((s) =>
              editingStory === s.id ? (
                <li key={s.id} className="card">
                  <StoryForm story={s} onDone={() => setEditingStory(null)} onCancel={() => setEditingStory(null)} />
                </li>
              ) : (
                <StoryCard
                  key={s.id}
                  story={s}
                  showState
                  actions={
                    isTerminal(s) ? (
                      <span className="chip" title="Finished and cancelled stories cannot be edited">
                        read-only
                      </span>
                    ) : (
                      <button type="button" aria-label={`Edit ${s.name}`} onClick={() => setEditingStory(s.id)}>
                        Edit
                      </button>
                    )
                  }
                />
              ),
            )}
          </ul>
        </>
      )}

      <h2>Comments</h2>
      <CommentThread kind="epic" id={e.id} />

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
