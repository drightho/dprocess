import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { repoLabel } from "../lib/github";

/**
 * The project's optional GitHub repository link. The text is sent as typed;
 * the server validates and normalizes it and its message is shown when it
 * refuses. An empty or whitespace-only value clears the link.
 */
export default function ProjectRepoForm({ project }: { project: Schemas["Project"] }) {
  const queryClient = useQueryClient();
  const saved = project.github_repo_url;
  const [text, setText] = useState(saved);
  const [done, setDone] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH("/projects/{id}", { params: { path: { id: project.id } }, body: { github_repo_url: text.trim() === "" ? "" : text } })),
    onSuccess: async (updated) => {
      setText(updated.github_repo_url);
      setDone(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["story"] }),
      ]);
    },
  });

  function edit(value: string) {
    setText(value);
    setDone(false);
    if (save.isError) save.reset();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() !== saved && !save.isPending) save.mutate();
  }

  return (
    <form className="inline wide" onSubmit={submit} aria-label="GitHub repository">
      <label>
        GitHub repository
        <input value={text} onChange={(e) => edit(e.target.value)} placeholder="https://github.com/owner/repo" />
      </label>
      <button type="submit" disabled={text.trim() === saved || save.isPending}>
        Save
      </button>
      {saved !== "" && (
        <a href={saved} target="_blank" rel="noopener noreferrer">
          {repoLabel(saved)}
        </a>
      )}
      {done && <span className="meta">Saved</span>}
      {save.isError && (
        <p role="alert" className="error" style={{ flexBasis: "100%" }}>
          {save.error.message}
        </p>
      )}
    </form>
  );
}
