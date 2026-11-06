import type { Schemas } from "../api/client";
import { formatTime } from "../lib/format";
import StateBadge from "./StateBadge";

type HistoryEntry = Schemas["HistoryEntry"];

interface Props {
  entries: readonly HistoryEntry[];
  /** When the record was created; shown as the oldest line (creation is not a state change). */
  createdAt: string;
}

/** State changes, newest first, ending with the creation of the record. */
export default function HistoryList({ entries, createdAt }: Props) {
  const newestFirst = [...entries].sort((a, b) => b.id - a.id);
  return (
    <ol className="history" aria-label="State history">
      {newestFirst.map((h) => (
        <li key={h.id}>
          <span className="meta">{formatTime(h.at)}</span> <StateBadge state={h.from_state} /> &rarr;{" "}
          <StateBadge state={h.to_state} />
          {h.actor && <span className="meta"> by {h.actor}</span>}
          {h.reason && <p>{h.reason}</p>}
        </li>
      ))}
      <li>
        <span className="meta">{formatTime(createdAt)}</span> Created
      </li>
    </ol>
  );
}
