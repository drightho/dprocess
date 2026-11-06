import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { isTerminal } from "../lib/board";
import { dependencyCandidates } from "../lib/dependencies";
import StateBadge from "./StateBadge";

type StoryRef = Schemas["StoryRef"];
type StoryDetail = Schemas["StoryDetail"];

interface RefsProps {
  items: readonly StoryRef[];
  none: string;
  /** When given, each item gets a Remove button. */
  onRemove?: (r: StoryRef) => void;
  busy?: boolean;
  /** Point out dependencies that are cancelled (they keep a story from finishing). */
  flagCancelled?: boolean;
}

function Refs({ items, none, onRemove, busy, flagCancelled }: RefsProps) {
  if (items.length === 0) return <p className="empty">{none}</p>;
  return (
    <ul className="refs">
      {items.map((r) => (
        <li key={r.id}>
          <Link to={`/stories/${r.id}`}>
            #{r.id} {r.name}
          </Link>{" "}
          <StateBadge state={r.state} />
          {onRemove && (
            <>
              {" "}
              <button type="button" aria-label={`Remove dependency on #${r.id} ${r.name}`} disabled={busy} onClick={() => onRemove(r)}>
                Remove
              </button>
            </>
          )}
          {flagCancelled && r.state === "cancelled" && (
            <p className="warning">Cancelled: this story cannot finish while it depends on a cancelled story. Remove the dependency.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A story's dependencies in both directions. Dependencies can be added from a
 * picker limited to the story's own project and removed one by one (a cancelled
 * dependency included, which is how a story gets free of it). The server
 * decides what is allowed (cycles, finished or cancelled stories); its message
 * is shown as is. Finished and cancelled stories are read-only.
 */
export default function DependencySection({ story }: { story: StoryDetail }) {
  const queryClient = useQueryClient();
  const frozen = isTerminal(story);
  const [choice, setChoice] = useState("");

  // Both ends of the relation change, so refresh every story page that may be cached.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["story"] });

  const add = useMutation({
    mutationFn: (dependsOnId: number) =>
      unwrap(api.PUT("/stories/{id}/dependencies/{depId}", { params: { path: { id: story.id, depId: dependsOnId } } })),
    onSuccess: async () => {
      setChoice("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (dependsOnId: number) =>
      unwrap(api.DELETE("/stories/{id}/dependencies/{depId}", { params: { path: { id: story.id, depId: dependsOnId } } })),
    onMutate: () => add.reset(),
    onSuccess: refresh,
  });

  const projectStories = useQuery({
    queryKey: ["project", story.project_id, "stories"],
    enabled: !frozen,
    queryFn: () => unwrap(api.GET("/projects/{id}/stories", { params: { path: { id: story.project_id } } })),
  });
  const projectEpics = useQuery({
    queryKey: ["project", story.project_id, "epics"],
    enabled: !frozen,
    queryFn: () => unwrap(api.GET("/projects/{id}/epics", { params: { path: { id: story.project_id } } })),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (choice !== "") add.mutate(Number(choice));
  }

  const groups = projectStories.data && projectEpics.data ? dependencyCandidates(story, projectStories.data, projectEpics.data) : [];
  const loadError = projectStories.error ?? projectEpics.error;

  return (
    <>
      <h2>Dependencies</h2>
      <h3 className="sub">Depends on</h3>
      <Refs
        items={story.depends_on}
        none="This story depends on no other story."
        onRemove={frozen ? undefined : (r) => remove.mutate(r.id)}
        busy={remove.isPending}
        flagCancelled={!frozen}
      />
      {remove.isError && (
        <p role="alert" className="error">
          {remove.error.message}
        </p>
      )}
      <h3 className="sub">Required by</h3>
      <Refs items={story.dependents} none="No story depends on this one." />

      {frozen ? (
        <p className="empty">The dependencies of a {story.state} story can no longer be changed.</p>
      ) : loadError ? (
        <p role="alert" className="error">
          Could not load the project's stories: {loadError.message}
        </p>
      ) : (
        projectStories.data &&
        projectEpics.data &&
        (groups.length === 0 ? (
          <p className="empty">There is no other story this one could depend on.</p>
        ) : (
          <>
            <h3 className="sub">Add a dependency</h3>
            <form onSubmit={submit} aria-label="Add dependency">
              <label>
                Story to depend on
                <select
                  value={choice}
                  onChange={(e) => {
                    setChoice(e.target.value);
                    add.reset();
                  }}
                >
                  <option value="">Choose a story...</option>
                  {groups.map((g) => (
                    <optgroup key={g.epicId} label={g.epicName}>
                      {g.stories.map((s) => (
                        <option key={s.id} value={s.id}>
                          #{s.id} {s.name} ({s.state})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {add.isError && (
                <p role="alert" className="error">
                  {add.error.message}
                </p>
              )}
              <div className="actions">
                <button type="submit" disabled={choice === "" || add.isPending}>
                  Add dependency
                </button>
              </div>
            </form>
          </>
        ))
      )}
    </>
  );
}
