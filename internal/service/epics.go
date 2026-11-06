package service

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

// ErrTransitionBlocked is returned when a legal transition is refused because
// of the state of related records; the API maps it to 409.
var ErrTransitionBlocked = errors.New("transition blocked")

// TransitionEpic moves an epic to a new state, enforcing the epic rules (see
// EpicTransitionEffects) atomically with the change.
func (s *Service) TransitionEpic(id int64, to, reason, actor string) (*store.Epic, error) {
	policy := func(from string, stories []store.StoryRef) ([]store.StoryChange, error) {
		return EpicTransitionEffects(id, from, to, reason, stories)
	}
	return s.Store.TransitionEpic(id, to, reason, actor, policy)
}

// EpicTransitionEffects applies the epic rules to a requested transition.
//
//   - from -> to must be allowed by workflow.Epic (forward one step, or cancel
//     from draft/review/ready; finished and cancelled are final).
//   - To finish, every story must be finished or cancelled and at least one
//     must be finished.
//   - Cancelling cancels every story that is not already finished or
//     cancelled; finished stories stay finished.
//
// It returns the story changes to apply together with the epic change.
func EpicTransitionEffects(epicID int64, from, to, reason string, stories []store.StoryRef) ([]store.StoryChange, error) {
	if err := workflow.Epic.Check(from, to); err != nil {
		return nil, err
	}
	switch to {
	case "finished":
		return nil, checkEpicCanFinish(stories)
	case "cancelled":
		return cascadeCancel(epicID, reason, stories)
	}
	return nil, nil
}

func checkEpicCanFinish(stories []store.StoryRef) error {
	var open []string
	finished := 0
	for _, st := range stories {
		switch st.State {
		case "finished":
			finished++
		case "cancelled":
		default:
			open = append(open, "#"+strconv.FormatInt(st.ID, 10)+" "+strconv.Quote(st.Name)+" ("+st.State+")")
		}
	}
	if len(open) > 0 {
		return fmt.Errorf("%w: epic cannot finish while stories are not finished or cancelled: %s",
			ErrTransitionBlocked, strings.Join(open, ", "))
	}
	if finished == 0 {
		return fmt.Errorf("%w: epic cannot finish without at least one finished story", ErrTransitionBlocked)
	}
	return nil
}

func cascadeCancel(epicID int64, reason string, stories []store.StoryRef) ([]store.StoryChange, error) {
	why := fmt.Sprintf("epic %d cancelled", epicID)
	if reason = strings.TrimSpace(reason); reason != "" {
		why += ": " + reason
	}
	var changes []store.StoryChange
	for _, st := range stories {
		if st.State == "finished" || st.State == "cancelled" {
			continue
		}
		if err := workflow.Story.Check(st.State, "cancelled"); err != nil {
			return nil, fmt.Errorf("cannot cancel story %d: %w", st.ID, err)
		}
		changes = append(changes, store.StoryChange{ID: st.ID, To: "cancelled", Reason: why})
	}
	return changes, nil
}
