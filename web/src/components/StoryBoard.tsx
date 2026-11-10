import { groupByState, nonEmptyStates, type Epic, type Story } from "../lib/board";
import StateBadge from "./StateBadge";
import StoryCard from "./StoryCard";

interface Props {
  stories: readonly Story[];
  epics: readonly Epic[];
}

/** One column per story state that has stories; each shows how many of the given stories are in it. */
export default function StoryBoard({ stories, epics }: Props) {
  const epicNames = new Map(epics.map((e) => [e.id, e.name]));
  const groups = groupByState(stories);
  return (
    <div className="board">
      {nonEmptyStates(stories).map((state) => (
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
          <ul className="cards">
            {groups[state].map((s) => (
              <StoryCard key={s.id} story={s} epic={{ id: s.epic_id, name: epicNames.get(s.epic_id) ?? "?" }} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
