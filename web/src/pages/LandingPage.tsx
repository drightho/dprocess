import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, unwrap } from "../api/client";
import NewProjectForm from "../components/NewProjectForm";
import ProjectSearch from "../components/ProjectSearch";
import { pruneRecent, readRecent } from "../lib/recent";

/** Home page: find a project by name, jump back to recently visited ones, or create a project. */
export default function LandingPage() {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => unwrap(api.GET("/projects")),
  });
  // The list is read once when the page opens; a visit is recorded by the project page.
  const [visited] = useState(() => readRecent());

  // Once the server's list is known, forget visited projects that were deleted meanwhile.
  useEffect(() => {
    if (projects.data) pruneRecent(new Set(projects.data.map((p) => p.id)));
  }, [projects.data]);

  // Show the server's current name and description, and skip deleted projects.
  const byId = new Map((projects.data ?? []).map((p) => [p.id, p]));
  const recent = visited.flatMap((v) => byId.get(v.id) ?? []);

  return (
    <section className="narrow">
      <h1>Projects</h1>

      <ProjectSearch
        loadProjects={async () => {
          const result = await projects.refetch();
          if (result.error) throw result.error;
          return result.data ?? [];
        }}
      />

      <h2>Recently visited</h2>
      {projects.isError ? (
        <p role="alert" className="error">
          Could not load projects: {projects.error.message}
        </p>
      ) : projects.isPending ? (
        <p>Loading...</p>
      ) : recent.length === 0 ? (
        <p className="empty">No recently visited projects yet. Search for a project above or create one below.</p>
      ) : (
        <ul className="cards" aria-label="Recently visited projects">
          {recent.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}>
                <strong>{p.name}</strong>
              </Link>
              {p.description && <p>{p.description}</p>}
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link to="/projects">Browse all projects</Link>
      </p>

      <h2>New project</h2>
      <NewProjectForm />
    </section>
  );
}
