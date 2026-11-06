import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

interface Props {
  noun: "epic" | "story";
  state: string;
  /** The moves the server lists as allowed from the current state. */
  allowed: readonly string[];
  /** Sends the move; resolves with the record as it is afterwards. */
  send: (to: string, reason: string | undefined) => Promise<{ state: string }>;
  /** Refreshes the page's data after a successful move. */
  refresh: () => Promise<unknown>;
  /** Says what cancelling will do; shown in the confirmation. */
  cancelPreview: ReactNode;
  /** Whether moving to `to` goes back to an earlier stage (labelled "Move back to ..."). */
  isBackward?: (to: string) => boolean;
}

/**
 * The state-change control shared by epics and stories. Only the moves the
 * server lists as allowed are offered. Whether a move is actually permitted
 * (finishing needs finished stories or dependencies, review and design need
 * the epic to be far enough along) is the server's decision: its message is
 * shown as is when it refuses. Cancelling is final, so it asks first.
 */
export default function StatePanel({ noun, state, allowed, send, refresh, cancelPreview, isBackward }: Props) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const Noun = noun === "epic" ? "Epic" : "Story";

  const move = useMutation({
    mutationFn: (to: string) => send(to, reason.trim() || undefined),
    onMutate: () => setDone(null),
    onSuccess: async (updated) => {
      setReason("");
      setConfirming(false);
      setDone(`${Noun} moved to ${updated.state}.`);
      await refresh();
    },
  });

  const status = done && <p role="status">{done}</p>;
  const failure = move.isError && (
    <p role="alert" className="error">
      {move.error.message}
    </p>
  );

  if (allowed.length === 0) {
    return (
      <section aria-label="Change state" className="panel">
        <h2>State</h2>
        <p className="empty">
          This {noun} is {state}; its state can no longer change.
        </p>
        {status}
      </section>
    );
  }

  return (
    <section aria-label="Change state" className="panel">
      <h2>State</h2>
      <label>
        Reason (optional)
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>

      {confirming ? (
        <div role="alertdialog" aria-label={`Confirm cancelling the ${noun}`} className="confirm">
          <p>
            <strong>Cancel this {noun}?</strong> A cancelled {noun} is final and cannot be reopened.
          </p>
          {cancelPreview}
          <div className="actions">
            <button type="button" className="danger" disabled={move.isPending} onClick={() => move.mutate("cancelled")}>
              Confirm cancel
            </button>
            <button type="button" disabled={move.isPending} onClick={() => setConfirming(false)}>
              Keep {noun}
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {allowed.map((to) =>
            to === "cancelled" ? (
              <button key={to} type="button" className="danger" disabled={move.isPending} onClick={() => setConfirming(true)}>
                Cancel {noun}
              </button>
            ) : (
              <button key={to} type="button" disabled={move.isPending} onClick={() => move.mutate(to)}>
                {isBackward?.(to) ? "Move back to" : "Move to"} {to}
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
