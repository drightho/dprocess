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
	path := []string{"draft", "review", "design", "implementation", "testing", "finished"}
	for i := 0; i < len(path)-1; i++ {
		if err := Story.Check(path[i], path[i+1]); err != nil {
			t.Errorf("%s -> %s: %v", path[i], path[i+1], err)
		}
		if err := Story.Check(path[i], "cancelled"); err != nil {
			t.Errorf("%s -> cancelled: %v", path[i], err)
		}
	}
	if err := Story.Check("draft", "design"); !errors.Is(err, ErrIllegalTransition) {
		t.Errorf("skip: %v", err)
	}
	if got := Story.Targets("finished"); len(got) != 0 {
		t.Errorf("finished targets: %v", got)
	}
	if got := Epic.Targets("draft"); len(got) != 2 || got[0] != "review" {
		t.Errorf("draft targets: %v", got)
	}
}
