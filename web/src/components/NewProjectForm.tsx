import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, unwrap } from "../api/client";

/** Creates a project, then opens it. */
export default function NewProjectForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/projects", { body: { name, description } })),
    onSuccess: async (project) => {
      setName("");
      setDescription("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/${project.id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={submit} aria-label="New project">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
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
  );
}
