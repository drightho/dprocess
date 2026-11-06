import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import type { Story } from "../lib/board";

type Issue = Schemas["Issue"];

interface Props {
  projectId: number;
  /** The project's stories, for the optional link. */
  stories: readonly Story[];
  /** Edit this issue (its GitHub URL cannot change)... */
  issue?: Issue;
  /** ...or reference a new one. */
  onDone: (saved: Issue) => void;
  onCancel: () => void;
}

/**
 * Adds or edits an issue reference, optionally linked to a story of the
 * project. Only canonical github.com issue URLs are accepted, duplicates are
 * refused, and only the server checks either: its message is shown inside the
 * form.
 */
export default function IssueForm({ projectId, stories, issue, onDone, onCancel }: Props) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState(issue?.title ?? "");
  const [kind, setKind] = useState(issue?.kind ?? "");
  const [storyId, setStoryId] = useState(issue?.story_id?.toString() ?? "");

  const save = useMutation({
    mutationFn: () => {
      const story_id = storyId === "" ? null : Number(storyId);
      return issue
        ? unwrap(api.PATCH("/issues/{id}", { params: { path: { id: issue.id } }, body: { title, kind, story_id } }))
        : unwrap(api.POST("/projects/{id}/issues", { params: { path: { id: projectId } }, body: { github_url: url, title, kind, story_id } }));
    },
    onSuccess: async (saved) => {
      // The project's issue list, and any story page that lists its issues.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["story"] }),
      ]);
      onDone(saved);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  // Typing dismisses the server's last complaint: it was about what was submitted, not what is typed now.
  return (
    <form onSubmit={submit} onChange={() => save.isError && save.reset()} aria-label={issue ? "Edit issue" : "Add issue"}>
      {!issue && (
        <label>
          GitHub issue URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/issues/123" />
        </label>
      )}
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Kind
        <input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="bug, defect, task..." />
      </label>
      <label>
        Linked story
        <select value={storyId} onChange={(e) => setStoryId(e.target.value)}>
          <option value="">Not linked to a story</option>
          {stories.map((s) => (
            <option key={s.id} value={s.id}>
              #{s.id} {s.name} ({s.state})
            </option>
          ))}
        </select>
      </label>
      {save.isError && (
        <p role="alert" className="error">
          {save.error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={save.isPending}>
          {issue ? "Save issue" : "Add issue"}
        </button>
        <button type="button" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
