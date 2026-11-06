import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, unwrap } from "../api/client";

export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => unwrap(api.GET("/projects")),
  });

  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/projects", { body: { name, description } })),
    onSuccess: async () => {
      setName("");
      setDescription("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <section className="narrow">
      <h1>Projects</h1>

      {projects.isPending && <p>Loading...</p>}
      {projects.isError && (
        <p role="alert" className="error">
          Could not load projects: {projects.error.message}
        </p>
      )}
      {projects.data?.length === 0 && <p>No projects yet.</p>}
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

      <h2>New project</h2>
      <form onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {create.isError && (
          <p role="alert" className="error">
            {create.error.message}
          </p>
        )}
        <button type="submit" disabled={create.isPending}>
          Create project
        </button>
      </form>
    </section>
  );
}
