import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import type { Epic } from "../lib/board";

interface Props {
  /** Create an epic in this project... */
  projectId?: number;
  /** ...or edit this epic (name and description; its state changes through the state panel). */
  epic?: Epic;
  onDone: (saved: Schemas["Epic"]) => void;
  onCancel: () => void;
}

/** Creates or edits an epic. The server validates; its message is shown inside the form. */
export default function EpicForm({ projectId, epic, onDone, onCancel }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(epic?.name ?? "");
  const [description, setDescription] = useState(epic?.description ?? "");

  const save = useMutation({
    mutationFn: () =>
      epic
        ? unwrap(api.PATCH("/epics/{id}", { params: { path: { id: epic.id } }, body: { name, description } }))
        : unwrap(api.POST("/projects/{id}/epics", { params: { path: { id: projectId! } }, body: { name, description } })),
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["epic", saved.id] }),
        queryClient.invalidateQueries({ queryKey: ["project", saved.project_id] }),
      ]);
      onDone(saved);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  // Editing any field dismisses the server's last complaint: it is about what was submitted, not what is typed now.
  return (
    <form onSubmit={submit} onChange={() => save.isError && save.reset()} aria-label={epic ? "Edit epic" : "New epic"}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {save.isError && (
        <p role="alert" className="error">
          {save.error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={save.isPending}>
          {epic ? "Save epic" : "Create epic"}
        </button>
        <button type="button" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
