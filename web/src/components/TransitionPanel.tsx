import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { isTerminal, type Epic, type Story } from "../lib/board";
import StatePanel from "./StatePanel";
import StateBadge from "./StateBadge";

interface Props {
  epic: Epic;
  stories: readonly Story[];
}

/** Moves an epic to another state. Cancelling cascades to its unfinished stories, so the confirmation lists them. */
export default function TransitionPanel({ epic, stories }: Props) {
  const queryClient = useQueryClient();
  const unfinished = stories.filter((s) => !isTerminal(s));

  return (
    <StatePanel
      noun="epic"
      state={epic.state}
      allowed={epic.allowed_transitions}
      send={(to, reason) =>
        unwrap(
          api.POST("/epics/{id}/transition", {
            params: { path: { id: epic.id } },
            body: { to: to as Schemas["EpicState"], reason },
          }),
        )
      }
      // The epic, its stories and its history changed (cancelling changes stories too),
      // and so did the project page's epic list and board.
      refresh={() =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: ["epic", epic.id] }),
          queryClient.invalidateQueries({ queryKey: ["project", epic.project_id] }),
        ])
      }
      cancelPreview={
        <>
          {unfinished.length > 0 ? (
            <>
              <p>
                {unfinished.length === 1 ? "Its unfinished story" : `Its ${unfinished.length} unfinished stories`} will be
                cancelled too:
              </p>
              <ul>
                {unfinished.map((s) => (
                  <li key={s.id}>
                    #{s.id} {s.name} <StateBadge state={s.state} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No stories will change.</p>
          )}
          <p className="meta">Finished stories stay finished.</p>
        </>
      }
    />
  );
}
