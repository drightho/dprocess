import { useState } from "react";
import {
  capLane,
  groupByState,
  LANE_LIMIT,
  nonEmptyStates,
  sortByRecentUpdate,
  type Epic,
  type Story,
  type StoryState,
} from "../lib/board";
import StateBadge from "./StateBadge";
import StoryCard from "./StoryCard";

interface Props {
  stories: readonly Story[];
  epics: readonly Epic[];
}

/**
 * One column per story state that has stories; each shows how many of the given
 * stories are in it. A lane lists its most recently updated stories first and
 * shows at most LANE_LIMIT of them until it is expanded. Which lanes are expanded
 * is local state: it is stored nowhere and every lane starts capped.
 */
export default function StoryBoard({ stories, epics }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<StoryState>>(() => new Set());
  const epicNames = new Map(epics.map((e) => [e.id, e.name]));
  const groups = groupByState(stories);
  const toggle = (state: StoryState) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  return (
    <div className="board">
      {nonEmptyStates(stories).map((state) => {
        const lane = sortByRecentUpdate(groups[state]);
        const isExpanded = expanded.has(state);
        return (
          <section key={state} className="column" aria-label={`${state} stories`}>
            <h3>
              <StateBadge state={state} />
              <span className="count" aria-label={`${lane.length} ${lane.length === 1 ? "story" : "stories"}`}>
                {lane.length}
              </span>
            </h3>
            <ul className="cards">
              {capLane(lane, isExpanded).map((s) => (
                <StoryCard key={s.id} story={s} epic={{ id: s.epic_id, name: epicNames.get(s.epic_id) ?? "?" }} />
              ))}
            </ul>
            {lane.length > LANE_LIMIT && (
              <button type="button" className="lane-toggle" onClick={() => toggle(state)}>
                {isExpanded ? "Show fewer" : `Show all ${lane.length}`}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
