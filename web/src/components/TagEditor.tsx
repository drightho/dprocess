import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";

interface Props {
  kind: "epic" | "story";
  id: number;
  projectId: number;
  /** For a story: its epic, whose page lists the story's tags too. */
  epicId?: number;
  tags: readonly string[];
}

/**
 * Tags of an epic or story: chips (each a link to the project board filtered
 * by that tag) with a remove button, and a field to add one. The server trims,
 * lower-cases and validates tags; its message is shown when it refuses one.
 * Tags can be changed in every state, finished and cancelled stories included.
 */
export default function TagEditor({ kind, id, projectId, epicId, tags }: Props) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");

  const refresh = () =>
    Promise.all(
      (kind === "epic"
        ? [["epic", id], ["project", projectId]]
        : [["story", id], ["epic", epicId], ["project", projectId]]
      ).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );

  const add = useMutation({
    mutationFn: async (tag: string) => {
      if (kind === "epic") await unwrap(api.PUT("/epics/{id}/tags/{tag}", { params: { path: { id, tag } } }));
      else await unwrap(api.PUT("/stories/{id}/tags/{tag}", { params: { path: { id, tag } } }));
    },
    onSuccess: async () => {
      setText("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async (tag: string) => {
      if (kind === "epic") await unwrap(api.DELETE("/epics/{id}/tags/{tag}", { params: { path: { id, tag } } }));
      else await unwrap(api.DELETE("/stories/{id}/tags/{tag}", { params: { path: { id, tag } } }));
    },
    onMutate: () => add.reset(),
    onSuccess: refresh,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const tag = text.trim();
    if (tag !== "") add.mutate(tag);
  }

  const error = add.error ?? remove.error;
  return (
    <section aria-label="Tags">
      {tags.length === 0 ? (
        <p className="empty">No tags yet.</p>
      ) : (
        <ul className="tag-list">
          {tags.map((t) => (
            <li key={t} className="chip">
              <Link to={`/projects/${projectId}?tag=${encodeURIComponent(t)}`} title="Show this project's stories with this tag">
                {t}
              </Link>
              <button type="button" className="chip-remove" aria-label={`Remove tag ${t}`} disabled={remove.isPending} onClick={() => remove.mutate(t)}>
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Typing dismisses the server's last complaint: it was about what was submitted, not what is typed now. */}
      <form className="inline" onSubmit={submit} onChange={() => add.isError && add.reset()} aria-label="Add tag">
        <label>
          New tag
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="submit" disabled={text.trim() === "" || add.isPending}>
          Add tag
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error.message}
        </p>
      )}
    </section>
  );
}
