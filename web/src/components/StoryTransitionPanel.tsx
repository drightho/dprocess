import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { isTerminal, STORY_STATES } from "../lib/board";
import StatePanel from "./StatePanel";
import StateBadge from "./StateBadge";

type StoryRef = Schemas["StoryRef"];
type StoryDetail = Schemas["StoryDetail"];

interface Props {
  story: StoryDetail;
}

const rank = (state: string) => (STORY_STATES as readonly string[]).indexOf(state);

/**
 * Moves a story to another state. The server decides what is allowed (its
 * explanation for a refused move, such as the epic not being far enough along
 * or dependencies not being finished, is shown as is). Cancelling is final,
 * and stories that depend on this one cannot finish until the dependency is
 * removed, so the confirmation lists them.
 */
export default function StoryTransitionPanel({ story }: Props) {
  const queryClient = useQueryClient();
  const waiting: StoryRef[] = story.dependents.filter((d) => !isTerminal(d));

  return (
    <StatePanel
      noun="story"
      state={story.state}
      allowed={story.allowed_transitions}
      isBackward={(to) => to !== "cancelled" && rank(to) < rank(story.state)}
      send={(to, reason) =>
        unwrap(
          api.POST("/stories/{id}/transition", {
            params: { path: { id: story.id } },
            body: { to: to as Schemas["StoryState"], reason },
          }),
        )
      }
      // The story and its history changed, and so did its epic's progress and the project's board.
      refresh={() =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: ["story", story.id] }),
          queryClient.invalidateQueries({ queryKey: ["epic", story.epic_id] }),
          queryClient.invalidateQueries({ queryKey: ["project", story.project_id] }),
        ])
      }
      cancelPreview={
        <>
          <p className="meta">A cancelled story can no longer be edited or moved.</p>
          {waiting.length > 0 && (
            <>
              <p>
                {waiting.length === 1 ? "This story is" : `These ${waiting.length} stories are`} waiting on it and cannot
                finish until the dependency is removed:
              </p>
              <ul>
                {waiting.map((d) => (
                  <li key={d.id}>
                    #{d.id} {d.name} <StateBadge state={d.state} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      }
    />
  );
}
