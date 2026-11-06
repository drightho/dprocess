import { Link } from "react-router-dom";
import { WARN_LOC, type Story } from "../lib/board";
import StateBadge from "./StateBadge";

interface Props {
  story: Story;
  /** When given, the card names the epic and links to it. */
  epic?: { id: number; name: string };
  /** Show the story's state on the card (the board's columns already say it). */
  showState?: boolean;
}

export default function StoryCard({ story, epic, showState = false }: Props) {
  return (
    <li className="card">
      <span className="card-head">
        <strong>{story.name}</strong>
        {showState && <StateBadge state={story.state} />}
      </span>
      <span className="meta">
        #{story.id}
        {epic && (
          <>
            {" · "}
            <Link to={`/epics/${epic.id}`}>{epic.name}</Link>
          </>
        )}
        {" · "}
        {story.assignee || "unassigned"}
        {story.estimate_loc !== null && ` · ${story.estimate_loc} LOC`}
      </span>
      {story.warnings.includes(WARN_LOC) && (
        <span className="warning">Estimate is over 400 lines; consider splitting the story</span>
      )}
      {story.tags.length > 0 && (
        <span className="chips">
          {story.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </span>
      )}
    </li>
  );
}
