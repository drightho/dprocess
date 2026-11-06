package service

import (
	"errors"
	"strings"
	"testing"

	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

func refs(states ...string) []store.StoryRef {
	out := make([]store.StoryRef, len(states))
	for i, s := range states {
		out[i] = store.StoryRef{ID: int64(i + 1), Name: "s" + string(rune('a'+i)), State: s}
	}
	return out
}

func TestEpicSimpleTransitionsHaveNoEffects(t *testing.T) {
	for _, c := range [][2]string{{"draft", "review"}, {"review", "ready"}} {
		// Stories in any state do not matter for these moves.
		ch, err := EpicTransitionEffects(1, c[0], c[1], "", refs("draft", "implementation"))
		if err != nil || len(ch) != 0 {
			t.Errorf("%v: %v %v", c, ch, err)
		}
	}
}

func TestEpicIllegalMoves(t *testing.T) {
	cases := []struct {
		from, to string
		err      error
	}{
		{"draft", "ready", workflow.ErrIllegalTransition},    // skipping review
		{"draft", "finished", workflow.ErrIllegalTransition}, // skipping
		{"review", "draft", workflow.ErrIllegalTransition},   // forward only
		{"ready", "review", workflow.ErrIllegalTransition},   // forward only
		{"finished", "cancelled", workflow.ErrIllegalTransition},
		{"finished", "draft", workflow.ErrIllegalTransition},
		{"cancelled", "cancelled", workflow.ErrIllegalTransition},
		{"cancelled", "draft", workflow.ErrIllegalTransition},
		{"draft", "design", workflow.ErrUnknownState},
	}
	for _, c := range cases {
		if _, err := EpicTransitionEffects(1, c.from, c.to, "", nil); !errors.Is(err, c.err) {
			t.Errorf("%s -> %s: got %v, want %v", c.from, c.to, err, c.err)
		}
	}
}

func TestEpicFinishGuard(t *testing.T) {
	ok := [][]string{
		{"finished"},
		{"finished", "cancelled"},
		{"cancelled", "finished", "finished"},
	}
	for _, st := range ok {
		if _, err := EpicTransitionEffects(1, "ready", "finished", "", refs(st...)); err != nil {
			t.Errorf("%v should finish: %v", st, err)
		}
	}
	blocked := [][]string{
		nil,                        // no stories
		{"cancelled"},              // nothing finished
		{"cancelled", "cancelled"}, // nothing finished
		{"finished", "testing"},    // unfinished story
		{"draft"},                  // unfinished story
		{"finished", "cancelled", "implementation"},
	}
	for _, st := range blocked {
		_, err := EpicTransitionEffects(1, "ready", "finished", "", refs(st...))
		if !errors.Is(err, ErrTransitionBlocked) {
			t.Errorf("%v should be blocked, got %v", st, err)
		}
	}
	// The message names the offending stories and their states.
	_, err := EpicTransitionEffects(1, "ready", "finished", "", refs("finished", "testing"))
	if err == nil || !strings.Contains(err.Error(), `#2 "sb" (testing)`) || strings.Contains(err.Error(), "#1") {
		t.Errorf("message: %v", err)
	}
}

func TestEpicCancelCascade(t *testing.T) {
	stories := refs("draft", "implementation", "finished", "cancelled", "review")
	for _, from := range []string{"draft", "review", "ready"} {
		ch, err := EpicTransitionEffects(7, from, "cancelled", " scope dropped ", stories)
		if err != nil {
			t.Fatalf("%s: %v", from, err)
		}
		var ids []int64
		for _, c := range ch {
			ids = append(ids, c.ID)
			if c.To != "cancelled" || c.Reason != "epic 7 cancelled: scope dropped" {
				t.Errorf("change %+v", c)
			}
		}
		// Finished (3) and already cancelled (4) stories are left alone.
		if len(ids) != 3 || ids[0] != 1 || ids[1] != 2 || ids[2] != 5 {
			t.Errorf("%s: cascade ids %v", from, ids)
		}
	}
	ch, _ := EpicTransitionEffects(7, "draft", "cancelled", "", nil)
	if len(ch) != 0 {
		t.Errorf("no stories, no changes: %v", ch)
	}
	ch, _ = EpicTransitionEffects(7, "draft", "cancelled", "", refs("draft"))
	if ch[0].Reason != "epic 7 cancelled" {
		t.Errorf("reason without text: %q", ch[0].Reason)
	}
}
