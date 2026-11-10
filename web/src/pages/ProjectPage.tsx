import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "../api/client";
import EpicForm from "../components/EpicForm";
import EpicList from "../components/EpicList";
import FilterBar from "../components/FilterBar";
import ProjectRepoForm from "../components/ProjectRepoForm";
import NotFoundNotice from "../components/NotFoundNotice";
import StoryBoard from "../components/StoryBoard";
import {
  applyFilters,
  filterOptions,
  hasFilters,
  NO_FILTERS,
  readFilters,
  writeFilters,
  type Filters,
} from "../lib/board";
import { recordVisit } from "../lib/recent";

/** A button that opens the new-epic form; a created epic is opened on its own page. */
function NewEpic({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!open) {
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          New epic
        </button>
      </p>
    );
  }
  return <EpicForm projectId={projectId} onDone={(epic) => navigate(`/epics/${epic.id}`)} onCancel={() => setOpen(false)} />;
}

/** Project overview: its epics and a board of its stories grouped by state. */
export default function ProjectPage() {
  const { projectId } = useParams();
  const id = /^[1-9]\d*$/.test(projectId ?? "") ? Number(projectId) : null;
  const [params, setParams] = useSearchParams();

  // Everything is loaded once and filtered in the browser, so changing a
  // filter is instant. The filters themselves live in the URL (?epic=&assignee=&tag=),
  // which keeps a filtered view reloadable and shareable.
  const enabled = id !== null;
  const project = useQuery({
    queryKey: ["project", id],
    enabled,
    queryFn: () => unwrap(api.GET("/projects/{id}", { params: { path: { id: id! } } })),
  });
  const epics = useQuery({
    queryKey: ["project", id, "epics"],
    enabled,
    queryFn: () => unwrap(api.GET("/projects/{id}/epics", { params: { path: { id: id! } } })),
  });
  const stories = useQuery({
    queryKey: ["project", id, "stories"],
    enabled,
    queryFn: () => unwrap(api.GET("/projects/{id}/stories", { params: { path: { id: id! } } })),
  });

  // Opening a project counts as a visit (it feeds the landing page's recent list).
  // Only a project that loaded is recorded, never an unknown or malformed id.
  const visitedId = project.data?.id;
  const visitedName = project.data?.name;
  useEffect(() => {
    if (visitedId !== undefined && visitedName !== undefined) {
      recordVisit({ id: visitedId, name: visitedName });
    }
  }, [visitedId, visitedName]);

  if (id === null) return <NotFoundNotice what="Project" />;

  const error = project.error ?? epics.error ?? stories.error;
  if (error instanceof ApiError && error.status === 404) return <NotFoundNotice what="Project" />;
  if (error) {
    return (
      <section className="narrow">
        <p role="alert" className="error">
          Could not load the project: {error.message}
        </p>
        <button
          type="button"
          onClick={() => {
            void project.refetch();
            void epics.refetch();
            void stories.refetch();
          }}
        >
          Try again
        </button>
      </section>
    );
  }
  if (!project.data || !epics.data || !stories.data) return <p>Loading...</p>;

  const filters = readFilters(params, epics.data, stories.data);
  const setFilters = (next: Filters) => setParams(writeFilters(next), { replace: true });
  const { assignees, tags } = filterOptions(stories.data);
  const visible = applyFilters(stories.data, filters);

  return (
    <>
      <p>
        <Link to="/projects">&larr; All projects</Link>
      </p>
      <h1>{project.data.name}</h1>
      {project.data.description && <p className="meta">{project.data.description}</p>}
      <ProjectRepoForm project={project.data} />
      <p>
        <Link to={`/projects/${project.data.id}/issues`}>Issues</Link>
      </p>

      <h2>Epics</h2>
      <EpicList
        epics={epics.data}
        stories={stories.data}
        selectedEpic={filters.epic}
        onSelect={(epic) => setFilters({ ...filters, epic })}
      />
      <NewEpic projectId={project.data.id} />

      <h2>Stories</h2>
      {stories.data.length === 0 ? (
        <p className="empty">This project has no stories yet.</p>
      ) : (
        <>
          <FilterBar
            filters={filters}
            epics={epics.data}
            assignees={assignees}
            tags={tags}
            onChange={setFilters}
          />
          {visible.length === 0 && hasFilters(filters) ? (
            <p className="empty">
              No stories match the filters.{" "}
              <button type="button" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </button>
            </p>
          ) : (
            <StoryBoard stories={visible} epics={epics.data} />
          )}
        </>
      )}
    </>
  );
}
