import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import type { Epic, Story } from "../lib/board";

type Issue = Schemas["Issue"];

interface Props {
  projectId: number;
  issue: Issue;
  /** The epics offered in the picker (the project's open ones); the server still decides. */
  epics: readonly Epic[];
  /** The story was created but linking the issue to it failed: the story is kept. */
  onLinkFailed: (story: Story, message: string) => void;
  onCancel: () => void;
}

/**
 * Creates a story from an issue: POST the story to the chosen epic, then link
 * the issue to it. The two calls are not one transaction. If the story cannot
 * be created, the server's message is shown here and nothing is linked; if the
 * link fails, the new story stays and the caller reports it.
 */
export default function IssueStoryForm({ projectId, issue, epics, onLinkFailed, onCancel }: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [epicId, setEpicId] = useState("");
  const [name, setName] = useState(issue.title);
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: async (epic: number) => {
      const story = await unwrap(api.POST("/epics/{id}/stories", { params: { path: { id: epic } }, body: { name, description } }));
      try {
        await unwrap(api.PATCH("/issues/{id}", { params: { path: { id: issue.id } }, body: { story_id: story.id } }));
        return { story, linkError: null };
      } catch (err) {
        return { story, linkError: err instanceof Error ? err.message : String(err) };
      }
    },
    onSuccess: async ({ story, linkError }) => {
      if (linkError !== null) {
        // The story exists now, so it must show up in the project's lists.
        await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        onLinkFailed(story, linkError);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["epic", story.epic_id] }),
        queryClient.invalidateQueries({ queryKey: ["story", story.id] }),
      ]);
      navigate(`/stories/${story.id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (epicId === "") return;
    create.mutate(Number(epicId));
  }

  // Typing dismisses the server's last complaint: it was about what was submitted, not what is typed now.
  return (
    <form onSubmit={submit} onChange={() => create.isError && create.reset()} aria-label="Create story">
      <label>
        Epic
        <select value={epicId} onChange={(e) => setEpicId(e.target.value)}>
          <option value=""></option>
          {epics.map((e) => (
            <option key={e.id} value={e.id}>
              #{e.id} {e.name}
            </option>
          ))}
        </select>
      </label>
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
      <div className="actions">
        <button type="submit" disabled={epicId === "" || create.isPending}>
          Create story
        </button>
        <button type="button" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
