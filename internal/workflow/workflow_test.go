package workflow

import (
	"errors"
	"testing"
)

func TestEpicTransitions(t *testing.T) {
	cases := []struct {
		from, to string
		err      error
	}{
		{"draft", "review", nil},
		{"review", "ready", nil},
		{"ready", "finished", nil},
		{"draft", "cancelled", nil},
		{"ready", "cancelled", nil},
		{"draft", "ready", ErrIllegalTransition},
		{"review", "draft", ErrIllegalTransition},
		{"finished", "cancelled", ErrIllegalTransition},
		{"cancelled", "draft", ErrIllegalTransition},
		{"draft", "design", ErrUnknownState}, // story-only state
		{"draft", "bogus", ErrUnknownState},
	}
	for _, c := range cases {
		if err := Epic.Check(c.from, c.to); !errors.Is(err, c.err) {
			t.Errorf("%s -> %s: got %v, want %v", c.from, c.to, err, c.err)
		}
	}
}

func TestStoryTransitions(t *testing.T) {
	// The complete set of legal moves; every other pair must be rejected.
	legal := map[string][]string{
		"draft":          {"review", "cancelled"},
		"review":         {"design", "cancelled"},
		"design":         {"implementation", "cancelled"},
		"implementation": {"testing", "design", "cancelled"}, // may step back to design
		"testing":        {"finished", "implementation", "design", "cancelled"},
	}
	allowed := func(from, to string) bool {
		for _, x := range legal[from] {
			if x == to {
				return true
			}
		}
		return false
	}
	for _, from := range Story.States {
		for _, to := range Story.States {
			err := Story.Check(from, to)
			if allowed(from, to) && err != nil {
				t.Errorf("%s -> %s should be legal: %v", from, to, err)
			}
			if !allowed(from, to) && !errors.Is(err, ErrIllegalTransition) {
				t.Errorf("%s -> %s should be illegal, got %v", from, to, err)
			}
		}
	}
	if err := Story.Check("draft", "ready"); !errors.Is(err, ErrUnknownState) {
		t.Errorf("epic-only state: %v", err)
	}
	if Story.Initial != "draft" {
		t.Errorf("initial: %s", Story.Initial)
	}
	// finished and cancelled are final.
	for _, s := range []string{"finished", "cancelled"} {
		if got := Story.Targets(s); len(got) != 0 {
			t.Errorf("%s targets: %v", s, got)
		}
	}
	// Forward move comes first, cancel last: handy for UIs.
	got := Story.Targets("testing")
	if len(got) != 4 || got[0] != "finished" || got[3] != "cancelled" {
		t.Errorf("testing targets: %v", got)
	}
}

func TestEpicInitialState(t *testing.T) {
	if Epic.Initial != "draft" {
		t.Errorf("initial: %s", Epic.Initial)
	}
}
