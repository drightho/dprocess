import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import type { Epic, Story } from "../lib/board";
import StateBadge from "./StateBadge";

type EpicState = Schemas["EpicState"];

const isFinal = (s: Story) => s.state === "finished" || s.state === "cancelled";

interface Props {
  epic: Epic;
  stories: readonly Story[];
}

/**
 * Moves an epic to another state. Only the moves the server lists as allowed
 * are offered. Whether a move is actually permitted (for instance finishing
 * needs finished stories) is the server's decision: its message is shown as
 * is when it refuses. Cancelling is final and cascades to the stories, so it
 * asks for confirmation first.
 */
export default function TransitionPanel({ epic, stories }: Props) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const move = useMutation({
    mutationFn: (to: EpicState) =>
      unwrap(
        api.POST("/epics/{id}/transition", {
          params: { path: { id: epic.id } },
          body: { to, reason: reason.trim() || undefined },
        }),
      ),
    onMutate: () => setDone(null),
    onSuccess: async (updated) => {
      setReason("");
      setConfirming(false);
      setDone(`Epic moved to ${updated.state}.`);
      // The epic, its stories and its history changed (cancelling changes stories too),
      // and so did the project page's epic list and board.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["epic", epic.id] }),
        queryClient.invalidateQueries({ queryKey: ["project", epic.project_id] }),
      ]);
    },
  });

  const status = done && <p role="status">{done}</p>;
  const failure = move.isError && (
    <p role="alert" className="error">
      {move.error.message}
    </p>
  );

  if (epic.allowed_transitions.length === 0) {
    return (
      <section aria-label="Change state" className="panel">
        <h2>State</h2>
        <p className="empty">This epic is {epic.state}; its state can no longer change.</p>
        {status}
      </section>
    );
  }

  const unfinished = stories.filter((s) => !isFinal(s));

  return (
    <section aria-label="Change state" className="panel">
      <h2>State</h2>
      <label>
        Reason (optional)
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>

      {confirming ? (
        <div role="alertdialog" aria-label="Confirm cancelling the epic" className="confirm">
          <p>
            <strong>Cancel this epic?</strong> A cancelled epic is final and cannot be reopened.
          </p>
          {unfinished.length > 0 ? (
            <>
              <p>
                {unfinished.length === 1 ? "Its unfinished story" : `Its ${unfinished.length} unfinished stories`} will
                be cancelled too:
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
          <div className="actions">
            <button type="button" className="danger" disabled={move.isPending} onClick={() => move.mutate("cancelled")}>
              Confirm cancel
            </button>
            <button type="button" disabled={move.isPending} onClick={() => setConfirming(false)}>
              Keep epic
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {epic.allowed_transitions.map((to) =>
            to === "cancelled" ? (
              <button key={to} type="button" className="danger" disabled={move.isPending} onClick={() => setConfirming(true)}>
                Cancel epic
              </button>
            ) : (
              <button key={to} type="button" disabled={move.isPending} onClick={() => move.mutate(to)}>
                Move to {to}
              </button>
            ),
          )}
        </div>
      )}
      {failure}
      {status}
    </section>
  );
}
