package service

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

// MaxStoryLOC is the recommended upper bound for a story's estimated size.
const MaxStoryLOC = 400

// WarnEstimateExceedsLOC is reported when a story's estimate is above MaxStoryLOC.
const WarnEstimateExceedsLOC = "estimate_exceeds_400_loc"

// StoryWarnings returns non-fatal advisories for a story. It never returns nil.
func StoryWarnings(st *store.Story) []string {
	w := []string{}
	if st.EstimateLOC != nil && *st.EstimateLOC > MaxStoryLOC {
		w = append(w, WarnEstimateExceedsLOC)
	}
	return w
}

// TransitionStory moves a story to a new state, enforcing the story rules
// (see StoryTransitionCheck) atomically with the change.
func (s *Service) TransitionStory(id int64, to, reason, actor string) (*store.Story, error) {
	policy := func(c store.StoryContext) error { return StoryTransitionCheck(to, c) }
	return s.Store.TransitionStory(id, to, reason, actor, policy)
}

// StoryTransitionCheck applies the story rules to a requested transition.
//
//   - c.From -> to must be allowed by workflow.Story.
//   - A story can move to review only while its epic is review or ready, and
//     to design (also back from implementation/testing) only while its epic
//     is ready. The same holds for implementation and testing, which a story
//     can only reach through design.
//   - A story can finish only when every story it depends on is finished
//     (a cancelled dependency does not count).
func StoryTransitionCheck(to string, c store.StoryContext) error {
	if err := workflow.Story.Check(c.From, to); err != nil {
		return err
	}
	switch to {
	case "review":
		if c.EpicState != "review" && c.EpicState != "ready" {
			return fmt.Errorf("%w: a story can move to review only while its epic is review or ready (epic is %s)",
				ErrTransitionBlocked, c.EpicState)
		}
	case "design", "implementation", "testing", "finished":
		if c.EpicState != "ready" {
			return fmt.Errorf("%w: a story can move to %s only while its epic is ready (epic is %s)",
				ErrTransitionBlocked, to, c.EpicState)
		}
	}
	if to == "finished" {
		var open []string
		for _, d := range c.Dependencies {
			if d.State != "finished" {
				open = append(open, "#"+strconv.FormatInt(d.ID, 10)+" "+strconv.Quote(d.Name)+" ("+d.State+")")
			}
		}
		if len(open) > 0 {
			return fmt.Errorf("%w: a story can finish only when the stories it depends on are finished: %s",
				ErrTransitionBlocked, strings.Join(open, ", "))
		}
	}
	return nil
}
