package service

import (
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

// TransitionStory moves a story to a new state if the workflow allows it.
func (s *Service) TransitionStory(id int64, to, reason, actor string) (*store.Story, error) {
	return s.Store.TransitionStory(id, to, reason, actor, workflow.Story.Check)
}
