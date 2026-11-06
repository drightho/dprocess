import { Link } from "react-router-dom";
import { epicProgress, type Epic, type Story } from "../lib/board";
import StateBadge from "./StateBadge";

interface Props {
  epics: readonly Epic[];
  stories: readonly Story[];
  selectedEpic: number | null;
  /** Called with the epic to filter the board by, or null to clear the filter. */
  onSelect: (epicId: number | null) => void;
}

export default function EpicList({ epics, stories, selectedEpic, onSelect }: Props) {
  if (epics.length === 0) {
    return <p className="empty">This project has no epics yet.</p>;
  }
  return (
    <ul className="epics">
      {epics.map((epic) => {
        const { total, finished, cancelled } = epicProgress(epic.id, stories);
        const selected = epic.id === selectedEpic;
        return (
          <li key={epic.id}>
            <button
              type="button"
              className={`epic ${selected ? "selected" : ""}`}
              aria-pressed={selected}
              title={selected ? "Show stories of all epics" : "Show only this epic's stories"}
              onClick={() => onSelect(selected ? null : epic.id)}
            >
              <span className="epic-head">
                <strong>{epic.name}</strong>
                <StateBadge state={epic.state} />
              </span>
              <span className="meta">
                {total === 0
                  ? "No stories"
                  : `${finished} of ${total} ${total === 1 ? "story" : "stories"} finished` +
                    (cancelled > 0 ? `, ${cancelled} cancelled` : "")}
              </span>
              {epic.tags.length > 0 && (
                <span className="chips">
                  {epic.tags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </span>
              )}
            </button>
            <Link className="open-epic" to={`/epics/${epic.id}`}>
              Open epic &rarr;
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
