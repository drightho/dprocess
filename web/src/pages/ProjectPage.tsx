import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "../api/client";
import EpicList from "../components/EpicList";
import FilterBar from "../components/FilterBar";
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

function NotFound() {
  return (
    <section className="narrow">
      <h1>Project not found</h1>
      <p>
        <Link to="/">Back to projects</Link>
      </p>
    </section>
  );
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

  if (id === null) return <NotFound />;

  const error = project.error ?? epics.error ?? stories.error;
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
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
        <Link to="/">&larr; All projects</Link>
      </p>
      <h1>{project.data.name}</h1>
      {project.data.description && <p className="meta">{project.data.description}</p>}

      <h2>Epics</h2>
      <EpicList
        epics={epics.data}
        stories={stories.data}
        selectedEpic={filters.epic}
        onSelect={(epic) => setFilters({ ...filters, epic })}
      />

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
