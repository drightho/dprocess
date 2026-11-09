package api

import (
	"strings"
	"testing"

	"github.com/dright/dprocess/internal/store"
)

// finishStory walks a story through the story workflow (the epic must be ready).
func finishStory(t *testing.T, call func(method, path, body string) (int, map[string]any), id string) {
	t.Helper()
	for _, to := range []string{"review", "design", "implementation", "testing", "pr_review", "finished"} {
		if code, m := call("POST", "/stories/"+id+"/transition", `{"to":"`+to+`"}`); code != 200 {
			t.Fatalf("story %s -> %s: %d %v", id, to, code, m)
		}
	}
}

func toState(t *testing.T, call func(method, path, body string) (int, map[string]any), epic, state string, want int) map[string]any {
	t.Helper()
	code, m := call("POST", "/epics/"+epic+"/transition", `{"to":"`+state+`","actor":"ann","reason":"because"}`)
	if code != want {
		t.Fatalf("epic %s -> %s: got %d, want %d (%v)", epic, state, code, want, m)
	}
	return m
}

func TestEpicFinishRequiresFinishedStories(t *testing.T) {
	_, call := setupStories(t) // epic 1 (project P) holds stories 1-4
	toState(t, call, "1", "review", 200)
	toState(t, call, "1", "ready", 200)

	// Unfinished stories block finishing, and the message names them.
	m := toState(t, call, "1", "finished", 409)
	if d, _ := m["detail"].(string); d == "" || !strings.Contains(d, `"a" (draft)`) {
		t.Fatalf("detail: %v", m["detail"])
	}
	// Finish 1 and 2, cancel 3 and 4: now it may finish.
	finishStory(t, call, "1")
	finishStory(t, call, "2")
	call("POST", "/stories/3/transition", `{"to":"cancelled"}`)
	toState(t, call, "1", "finished", 409) // story 4 still draft
	call("POST", "/stories/4/transition", `{"to":"cancelled"}`)
	m = toState(t, call, "1", "finished", 200)
	if m["state"] != "finished" || len(m["allowed_transitions"].([]any)) != 0 {
		t.Fatalf("finished epic: %v", m)
	}
	// Final: no cancel, nothing else.
	toState(t, call, "1", "cancelled", 409)
	toState(t, call, "1", "draft", 409)

	// A finished epic accepts no new stories.
	if code, _ := call("POST", "/epics/1/stories", `{"name":"late"}`); code != 409 {
		t.Fatalf("story in finished epic: %d", code)
	}
}

func TestEpicWithoutFinishedStoryCannotFinish(t *testing.T) {
	_, call := setupStories(t)
	// A brand-new epic (id 3) has no stories.
	call("POST", "/projects/1/epics", `{"name":"empty"}`)
	toState(t, call, "3", "review", 200)
	toState(t, call, "3", "ready", 200)
	m := toState(t, call, "3", "finished", 409)
	if d, _ := m["detail"].(string); !strings.Contains(d, "at least one finished story") {
		t.Fatalf("detail: %v", m["detail"])
	}
	// Only cancelled stories: still no finished story.
	call("POST", "/epics/3/stories", `{"name":"x"}`) // story 6
	call("POST", "/stories/6/transition", `{"to":"cancelled"}`)
	toState(t, call, "3", "finished", 409)
}

func TestEpicCancelCascadesToStories(t *testing.T) {
	srv, st := newTestServer(t)
	call := func(method, path, body string) (int, map[string]any) {
		resp, m := do(t, method, srv.URL+"/api/v1"+path, body)
		return resp.StatusCode, m
	}
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")
	for _, n := range []string{"draft-one", "in-testing", "done", "already-cancelled"} {
		st.CreateStory(1, store.NewStory{Name: n})
	}
	toState(t, call, "1", "review", 200) // stories can only advance once the epic is
	toState(t, call, "1", "ready", 200)
	for _, to := range []string{"review", "design", "implementation", "testing"} {
		if code, m := call("POST", "/stories/2/transition", `{"to":"`+to+`"}`); code != 200 {
			t.Fatalf("story 2 -> %s: %d %v", to, code, m)
		}
	}
	finishStory(t, call, "3")
	call("POST", "/stories/4/transition", `{"to":"cancelled"}`)

	m := toState(t, call, "1", "cancelled", 200)
	if m["state"] != "cancelled" {
		t.Fatalf("epic: %v", m)
	}
	states := map[int64]string{}
	all, _ := st.ListEpicStories(1)
	for _, s := range all {
		states[s.ID] = s.State
	}
	want := map[int64]string{1: "cancelled", 2: "cancelled", 3: "finished", 4: "cancelled"}
	for id, w := range want {
		if states[id] != w {
			t.Errorf("story %d: got %s, want %s", id, states[id], w)
		}
	}

	// History: the epic and each cascaded story, attributed to the same actor.
	h, _ := st.ListHistory("story", 2)
	last := h[len(h)-1]
	if last.FromState != "testing" || last.ToState != "cancelled" || last.Actor != "ann" || last.Reason != "epic 1 cancelled: because" {
		t.Errorf("story 2 history: %+v", last)
	}
	if h, _ := st.ListHistory("story", 3); h[len(h)-1].ToState != "finished" {
		t.Errorf("finished story must not gain a cancel entry: %+v", h)
	}
	if h, _ := st.ListHistory("story", 4); len(h) != 1 { // only its own cancel
		t.Errorf("already-cancelled story history: %+v", h)
	}
	eh, _ := st.ListHistory("epic", 1)
	if len(eh) != 3 || eh[2].FromState != "ready" || eh[2].ToState != "cancelled" {
		t.Errorf("epic history: %+v", eh)
	}

	// Cancelled epics are final and take no new stories.
	toState(t, call, "1", "draft", 409)
	toState(t, call, "1", "cancelled", 409)
	if code, _ := call("POST", "/epics/1/stories", `{"name":"late"}`); code != 409 {
		t.Fatalf("story in cancelled epic: %d", code)
	}
}

func TestEpicCancelFromEachOpenState(t *testing.T) {
	_, call := setupStories(t)
	toState(t, call, "1", "cancelled", 200) // from draft
	toState(t, call, "2", "review", 200)
	toState(t, call, "2", "cancelled", 200) // from review
}

func TestEpicForwardOnly(t *testing.T) {
	_, call := setupStories(t)
	toState(t, call, "1", "ready", 409) // must review first
	toState(t, call, "1", "review", 200)
	toState(t, call, "1", "draft", 409) // no going back
	toState(t, call, "1", "ready", 200)
	toState(t, call, "1", "review", 409)
	// Stories can still be added while the epic is draft, review or ready.
	if code, _ := call("POST", "/epics/1/stories", `{"name":"more"}`); code != 201 {
		t.Fatalf("story in ready epic: %d", code)
	}
}
