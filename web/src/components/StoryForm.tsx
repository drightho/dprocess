import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import type { Story } from "../lib/board";
import { MAX_STORY_LOC, overLimit, parseEstimate } from "../lib/forms";

interface Props {
  /** Create a story in this epic... */
  epicId?: number;
  /** ...or edit this story (its state changes through the transition control). */
  story?: Story;
  onDone: (saved: Schemas["Story"]) => void;
  onCancel: () => void;
}

/**
 * Creates or edits a story. The size estimate warns while typing when it is
 * over the recommended limit, but never blocks saving. The server validates;
 * its message is shown inside the form.
 */
export default function StoryForm({ epicId, story, onDone, onCancel }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(story?.name ?? "");
  const [description, setDescription] = useState(story?.description ?? "");
  const [criteria, setCriteria] = useState(story?.acceptance_criteria ?? "");
  const [assignee, setAssignee] = useState(story?.assignee ?? "");
  const [estimate, setEstimate] = useState(story?.estimate_loc?.toString() ?? "");
  const [estimateError, setEstimateError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (estimate_loc: number | null) => {
      const body = { name, description, acceptance_criteria: criteria, assignee, estimate_loc };
      return story
        ? unwrap(api.PATCH("/stories/{id}", { params: { path: { id: story.id } }, body }))
        : unwrap(api.POST("/epics/{id}/stories", { params: { path: { id: epicId! } }, body }));
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["story", saved.id] }),
        queryClient.invalidateQueries({ queryKey: ["epic", saved.epic_id] }),
        queryClient.invalidateQueries({ queryKey: ["project", saved.project_id] }),
      ]);
      onDone(saved);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseEstimate(estimate);
    if (!parsed.ok) {
      setEstimateError(parsed.message);
      return;
    }
    setEstimateError(null);
    save.mutate(parsed.value);
  }

  // Editing any field dismisses the server's last complaint: it is about what was submitted, not what is typed now.
  return (
    <form onSubmit={submit} onChange={() => save.isError && save.reset()} aria-label={story ? "Edit story" : "New story"}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Acceptance criteria
        <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </label>
      <label>
        Assignee
        <input value={assignee} onChange={(e) => setAssignee(e.target.value)} />
      </label>
      <label>
        Estimate (lines of code)
        <input
          type="number"
          inputMode="numeric"
          step={1}
          value={estimate}
          onChange={(e) => {
            setEstimate(e.target.value);
            setEstimateError(null);
          }}
        />
      </label>
      {estimateError && (
        <p role="alert" className="error">
          {estimateError}
        </p>
      )}
      {overLimit(estimate) && (
        <p role="status" className="warning">
          Estimate is over {MAX_STORY_LOC} lines; consider splitting the story.
        </p>
      )}
      {save.isError && (
        <p role="alert" className="error">
          {save.error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={save.isPending}>
          {story ? "Save story" : "Create story"}
        </button>
        <button type="button" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
