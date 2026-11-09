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
		"draft":             {"review", "cancelled"},
		"review":            {"design", "cancelled"},
		"design":            {"implementation", "cancelled"},
		"implementation":    {"ready_for_testing", "design", "cancelled"}, // may step back to design
		"ready_for_testing": {"testing", "implementation", "design", "cancelled"},
		"testing":           {"pr_review", "implementation", "design", "cancelled"},
		"pr_review":         {"finished", "design", "cancelled"}, // review passed, failed, or story cancelled
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
	if len(got) != 4 || got[0] != "pr_review" || got[3] != "cancelled" {
		t.Errorf("testing targets: %v", got)
	}
	for from, want := range map[string][]string{
		"implementation":    {"ready_for_testing", "design", "cancelled"},
		"ready_for_testing": {"testing", "implementation", "design", "cancelled"},
	} {
		got := Story.Targets(from)
		if len(got) != len(want) {
			t.Errorf("%s targets: %v, want %v", from, got, want)
			continue
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("%s targets: %v, want %v", from, got, want)
				break
			}
		}
	}
	got = Story.Targets("pr_review")
	if len(got) != 3 || got[0] != "finished" || got[1] != "design" || got[2] != "cancelled" {
		t.Errorf("pr_review targets: %v", got)
	}
}

func TestEpicInitialState(t *testing.T) {
	if Epic.Initial != "draft" {
		t.Errorf("initial: %s", Epic.Initial)
	}
}

// The new state sits between implementation and testing; the direct edge is gone.
func TestStoryReadyForTesting(t *testing.T) {
	idx := map[string]int{}
	for i, s := range Story.States {
		idx[s] = i
	}
	r, ok := idx["ready_for_testing"]
	if !ok {
		t.Fatalf("ready_for_testing missing from %v", Story.States)
	}
	if r != idx["implementation"]+1 || idx["testing"] != r+1 {
		t.Errorf("order: %v", Story.States)
	}
	for _, c := range []struct {
		from, to string
		ok       bool
	}{
		{"implementation", "ready_for_testing", true},
		{"ready_for_testing", "testing", true},
		{"ready_for_testing", "implementation", true},
		{"ready_for_testing", "design", true},
		{"ready_for_testing", "cancelled", true},
		{"implementation", "testing", false},
		{"testing", "ready_for_testing", false},
		{"ready_for_testing", "pr_review", false},
		{"ready_for_testing", "finished", false},
		{"ready_for_testing", "draft", false},
		{"ready_for_testing", "review", false},
		{"ready_for_testing", "ready_for_testing", false},
		{"design", "ready_for_testing", false},
		{"pr_review", "ready_for_testing", false},
		{"finished", "ready_for_testing", false},
		{"cancelled", "ready_for_testing", false},
	} {
		err := Story.Check(c.from, c.to)
		if c.ok && err != nil {
			t.Errorf("%s -> %s should be legal: %v", c.from, c.to, err)
		}
		if !c.ok && !errors.Is(err, ErrIllegalTransition) {
			t.Errorf("%s -> %s should be illegal, got %v", c.from, c.to, err)
		}
	}
	if err := Story.Check("ready_for_testing", "bogus"); !errors.Is(err, ErrUnknownState) {
		t.Errorf("unknown target: %v", err)
	}
	if err := Story.Check("ready_for_testing", "ready"); !errors.Is(err, ErrUnknownState) {
		t.Errorf("epic-only target: %v", err)
	}
}
