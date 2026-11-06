import { groupByState, STORY_STATES, WARN_LOC, type Epic, type Story } from "../lib/board";
import StateBadge from "./StateBadge";

interface Props {
  stories: readonly Story[];
  epics: readonly Epic[];
}

function StoryCard({ story, epicName }: { story: Story; epicName: string }) {
  return (
    <li className="card">
      <strong>{story.name}</strong>
      <span className="meta">
        #{story.id} · {epicName} · {story.assignee || "unassigned"}
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

/** One column per story state; each shows how many of the given stories are in it. */
export default function StoryBoard({ stories, epics }: Props) {
  const epicNames = new Map(epics.map((e) => [e.id, e.name]));
  const groups = groupByState(stories);
  return (
    <div className="board">
      {STORY_STATES.map((state) => (
        <section key={state} className="column" aria-label={`${state} stories`}>
          <h3>
            <StateBadge state={state} />
            <span
              className="count"
              aria-label={`${groups[state].length} ${groups[state].length === 1 ? "story" : "stories"}`}
            >
              {groups[state].length}
            </span>
          </h3>
          {groups[state].length === 0 ? (
            <p className="empty">None</p>
          ) : (
            <ul className="cards">
              {groups[state].map((s) => (
                <StoryCard key={s.id} story={s} epicName={epicNames.get(s.epic_id) ?? "?"} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
