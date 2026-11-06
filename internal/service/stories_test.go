package service

import (
	"errors"
	"strings"
	"testing"

	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

func ctx(from, epic string, deps ...string) store.StoryContext {
	c := store.StoryContext{From: from, EpicState: epic, Dependencies: []store.StoryRef{}}
	for i, s := range deps {
		c.Dependencies = append(c.Dependencies, store.StoryRef{ID: int64(10 + i), Name: "dep" + string(rune('a'+i)), State: s})
	}
	return c
}

func TestStoryEpicGates(t *testing.T) {
	cases := []struct {
		from, to, epic string
		want           error // nil, ErrTransitionBlocked or a workflow error
	}{
		// review: epic must be review or ready
		{"draft", "review", "draft", ErrTransitionBlocked},
		{"draft", "review", "review", nil},
		{"draft", "review", "ready", nil},
		{"draft", "review", "finished", ErrTransitionBlocked},
		{"draft", "review", "cancelled", ErrTransitionBlocked},
		// design: epic must be ready
		{"review", "design", "draft", ErrTransitionBlocked},
		{"review", "design", "review", ErrTransitionBlocked},
		{"review", "design", "ready", nil},
		// later states imply a ready epic
		{"design", "implementation", "ready", nil},
		{"implementation", "testing", "ready", nil},
		{"testing", "finished", "ready", nil},
		{"implementation", "design", "ready", nil},
		{"testing", "implementation", "ready", nil},
		{"testing", "design", "ready", nil},
		{"design", "implementation", "review", ErrTransitionBlocked},
		// cancelling is never gated by the epic
		{"draft", "cancelled", "draft", nil},
		{"review", "cancelled", "review", nil},
		{"testing", "cancelled", "ready", nil},
		// the table still applies first
		{"draft", "design", "ready", workflow.ErrIllegalTransition},
		{"finished", "cancelled", "ready", workflow.ErrIllegalTransition},
		{"cancelled", "review", "ready", workflow.ErrIllegalTransition},
		{"testing", "review", "ready", workflow.ErrIllegalTransition}, // no further backward moves
		{"draft", "ready", "ready", workflow.ErrUnknownState},
	}
	for _, c := range cases {
		err := StoryTransitionCheck(c.to, ctx(c.from, c.epic))
		if c.want == nil && err != nil || c.want != nil && !errors.Is(err, c.want) {
			t.Errorf("%s -> %s (epic %s): got %v, want %v", c.from, c.to, c.epic, err, c.want)
		}
	}
}

func TestStoryFinishNeedsFinishedDependencies(t *testing.T) {
	for _, deps := range [][]string{nil, {"finished"}, {"finished", "finished"}} {
		if err := StoryTransitionCheck("finished", ctx("testing", "ready", deps...)); err != nil {
			t.Errorf("%v should allow finishing: %v", deps, err)
		}
	}
	for _, deps := range [][]string{
		{"draft"}, {"testing"}, {"cancelled"}, {"finished", "implementation"}, {"cancelled", "finished"},
	} {
		err := StoryTransitionCheck("finished", ctx("testing", "ready", deps...))
		if !errors.Is(err, ErrTransitionBlocked) {
			t.Errorf("%v should block finishing, got %v", deps, err)
		}
	}
	// The message names only the stories that are not finished.
	err := StoryTransitionCheck("finished", ctx("testing", "ready", "finished", "testing", "cancelled"))
	if err == nil || strings.Contains(err.Error(), "#10") ||
		!strings.Contains(err.Error(), `#11 "depb" (testing)`) || !strings.Contains(err.Error(), `#12 "depc" (cancelled)`) {
		t.Errorf("message: %v", err)
	}
	// Dependencies only matter for finishing: other moves ignore them.
	for _, to := range []string{"implementation", "design", "cancelled"} {
		if err := StoryTransitionCheck(to, ctx("testing", "ready", "draft")); err != nil {
			t.Errorf("testing -> %s with an unfinished dependency: %v", to, err)
		}
	}
}
