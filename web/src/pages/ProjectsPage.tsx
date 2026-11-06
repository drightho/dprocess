import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, unwrap } from "../api/client";

/** Every project, for browsing. Creating one and searching live on the landing page. */
export default function ProjectsPage() {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => unwrap(api.GET("/projects")),
  });

  return (
    <section className="narrow">
      <p>
        <Link to="/">&larr; Home</Link>
      </p>
      <h1>All projects</h1>

      {projects.isPending && <p>Loading...</p>}
      {projects.isError && (
        <p role="alert" className="error">
          Could not load projects: {projects.error.message}
        </p>
      )}
      {projects.data?.length === 0 && <p className="empty">No projects yet. Create one from the home page.</p>}
      <ul className="cards">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`}>
              <strong>{p.name}</strong>
            </Link>
            {p.description && <p>{p.description}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
