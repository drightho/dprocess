package api

import (
	"strings"
	"testing"
)

type caller = func(method, path, body string) (int, map[string]any)

func storyTo(t *testing.T, call caller, id, state string, want int) map[string]any {
	t.Helper()
	code, m := call("POST", "/stories/"+id+"/transition", `{"to":"`+state+`","actor":"bob","reason":"r"}`)
	if code != want {
		t.Fatalf("story %s -> %s: got %d, want %d (%v)", id, state, code, want, m)
	}
	return m
}

func readyEpic(t *testing.T, call caller, id string) {
	t.Helper()
	toState(t, call, id, "review", 200)
	toState(t, call, id, "ready", 200)
}

func TestStoryEpicGatesOverAPI(t *testing.T) {
	_, call := setupStories(t) // epic 1 holds stories 1-4

	// Epic draft: nothing but cancel.
	m := storyTo(t, call, "1", "review", 409)
	if d, _ := m["detail"].(string); !strings.Contains(d, "epic is draft") {
		t.Fatalf("detail: %v", m["detail"])
	}
	storyTo(t, call, "4", "cancelled", 200)

	// Epic review: stories may enter review but not design.
	toState(t, call, "1", "review", 200)
	storyTo(t, call, "1", "review", 200)
	m = storyTo(t, call, "1", "design", 409)
	if d, _ := m["detail"].(string); !strings.Contains(d, "only while its epic is ready (epic is review)") {
		t.Fatalf("detail: %v", m["detail"])
	}

	// Epic ready: design is open.
	toState(t, call, "1", "ready", 200)
	storyTo(t, call, "1", "design", 200)
	// A story that was still in draft can enter review while the epic is ready.
	storyTo(t, call, "2", "review", 200)
}

func TestStoryBackwardMovesAndHistory(t *testing.T) {
	api, call := setupStories(t)
	readyEpic(t, call, "1")

	for _, to := range []string{"review", "design", "implementation"} {
		storyTo(t, call, "1", to, 200)
	}
	// implementation -> design is allowed, review is not reachable backwards.
	storyTo(t, call, "1", "design", 200)
	storyTo(t, call, "1", "implementation", 200)
	storyTo(t, call, "1", "ready_for_testing", 200)
	storyTo(t, call, "1", "testing", 200)

	m := storyTo(t, call, "1", "review", 409) // testing -> review: not allowed
	if m["status"] != float64(409) {
		t.Fatalf("%v", m)
	}
	// testing -> implementation and testing -> design are both allowed.
	storyTo(t, call, "1", "implementation", 200)
	storyTo(t, call, "1", "ready_for_testing", 200)
	storyTo(t, call, "1", "testing", 200)
	m = storyTo(t, call, "1", "design", 200)
	if at, _ := m["allowed_transitions"].([]any); len(at) != 2 || at[0] != "implementation" || at[1] != "cancelled" {
		t.Fatalf("allowed at design: %v", m["allowed_transitions"])
	}

	// design <- no further back; draft is never a target.
	storyTo(t, call, "1", "draft", 409)
	storyTo(t, call, "1", "review", 409)

	// Every successful move, backward ones included, is in the history in
	// order; rejected moves are not.
	want := []string{"review", "design", "implementation", "design", "implementation", "ready_for_testing", "testing", "implementation", "ready_for_testing", "testing", "design"}
	h, err := httpGetJSONArray(api + "/stories/1/history")
	if err != nil || len(h) != len(want) {
		t.Fatalf("history: %v %v", h, err)
	}
	for i, e := range h {
		if got := e.(map[string]any)["to_state"]; got != want[i] {
			t.Errorf("history[%d]: got %v, want %s", i, got, want[i])
		}
	}
}

func TestStoryFinishNeedsFinishedDependenciesOverAPI(t *testing.T) {
	_, call := setupStories(t)
	// A second epic in the same project so the dependency crosses epics.
	call("POST", "/projects/1/epics", `{"name":"E-other"}`) // epic 3
	call("POST", "/epics/3/stories", `{"name":"base"}`)     // story 6
	readyEpic(t, call, "1")
	readyEpic(t, call, "3")

	// Story 1 depends on story 6 (other epic) and story 2.
	call("PUT", "/stories/1/dependencies/6", "")
	call("PUT", "/stories/1/dependencies/2", "")
	for _, to := range []string{"review", "design", "implementation", "ready_for_testing", "testing", "pr_review"} {
		storyTo(t, call, "1", to, 200)
	}

	m := storyTo(t, call, "1", "finished", 409)
	d, _ := m["detail"].(string)
	if !strings.Contains(d, `#2 "b" (draft)`) || !strings.Contains(d, `#6 "base" (draft)`) {
		t.Fatalf("detail: %v", d)
	}
	// Other moves are not blocked by unfinished dependencies.
	storyTo(t, call, "1", "design", 200)
	for _, to := range []string{"implementation", "ready_for_testing", "testing", "pr_review"} {
		storyTo(t, call, "1", to, 200)
	}

	finishStory(t, call, "6")
	m = storyTo(t, call, "1", "finished", 409) // story 2 still open
	if d, _ := m["detail"].(string); strings.Contains(d, "#6") || !strings.Contains(d, "#2") {
		t.Fatalf("detail after finishing 6: %v", d)
	}

	// A cancelled dependency does not count as finished.
	storyTo(t, call, "2", "cancelled", 200)
	m = storyTo(t, call, "1", "finished", 409)
	if d, _ := m["detail"].(string); !strings.Contains(d, `#2 "b" (cancelled)`) {
		t.Fatalf("cancelled dependency: %v", d)
	}
	// Removing the dependency unblocks it.
	if code, _ := call("DELETE", "/stories/1/dependencies/2", ""); code != 204 {
		t.Fatal(code)
	}
	m = storyTo(t, call, "1", "finished", 200)
	if m["state"] != "finished" || len(m["allowed_transitions"].([]any)) != 0 {
		t.Fatalf("finished story: %v", m)
	}
	// Finished is final: no cancel, no moving back.
	for _, to := range []string{"cancelled", "pr_review", "testing", "design"} {
		storyTo(t, call, "1", to, 409)
	}
}

func TestStoryCancelFromEveryNonFinalState(t *testing.T) {
	_, call := setupStories(t)
	readyEpic(t, call, "1")
	call("POST", "/epics/1/stories", `{"name":"e"}`) // story 6; epic 1 now has stories 1-4 and 6
	call("POST", "/epics/1/stories", `{"name":"f"}`) // story 7

	call("POST", "/epics/1/stories", `{"name":"g"}`) // story 8
	path := []string{"draft", "review", "design", "implementation", "ready_for_testing", "testing", "pr_review"}
	ids := []string{"1", "2", "3", "4", "6", "7", "8"}
	for i, state := range path {
		for _, to := range path[1 : i+1] {
			storyTo(t, call, ids[i], to, 200)
		}
		m := storyTo(t, call, ids[i], "cancelled", 200)
		if m["state"] != "cancelled" {
			t.Fatalf("from %s: %v", state, m)
		}
		// Cancelled is final.
		storyTo(t, call, ids[i], "draft", 409)
		storyTo(t, call, ids[i], "cancelled", 409)
	}
}

func TestNewStoryStartsInDraft(t *testing.T) {
	_, call := setupStories(t)
	_, m := call("POST", "/epics/1/stories", `{"name":"fresh"}`)
	if m["state"] != "draft" {
		t.Fatalf("%v", m)
	}
	if at, _ := m["allowed_transitions"].([]any); len(at) != 2 || at[0] != "review" || at[1] != "cancelled" {
		t.Fatalf("allowed: %v", m["allowed_transitions"])
	}
}

func TestStoryPRReview(t *testing.T) {
	api, call := setupStories(t)
	readyEpic(t, call, "1")
	for _, to := range []string{"review", "design", "implementation", "ready_for_testing", "testing"} {
		storyTo(t, call, "1", to, 200)
	}
	// Testing no longer finishes a story directly; pr_review comes first.
	storyTo(t, call, "1", "finished", 409)
	m := storyTo(t, call, "1", "pr_review", 200)
	at, _ := m["allowed_transitions"].([]any)
	if len(at) != 3 || at[0] != "finished" || at[1] != "design" || at[2] != "cancelled" {
		t.Fatalf("allowed at pr_review: %v", m["allowed_transitions"])
	}
	// Only finished, design and cancelled leave pr_review.
	storyTo(t, call, "1", "testing", 409)
	storyTo(t, call, "1", "implementation", 409)

	// Review failed: back to design, then the whole way again.
	storyTo(t, call, "1", "design", 200)
	for _, to := range []string{"implementation", "ready_for_testing", "testing", "pr_review", "finished"} {
		storyTo(t, call, "1", to, 200)
	}
	h, err := httpGetJSONArray(api + "/stories/1/history")
	if err != nil || len(h) != 12 {
		t.Fatalf("history: %v %v", h, err)
	}
	if e := h[5].(map[string]any); e["from_state"] != "testing" || e["to_state"] != "pr_review" {
		t.Errorf("history[5]: %v", e)
	}
	if e := h[6].(map[string]any); e["from_state"] != "pr_review" || e["to_state"] != "design" {
		t.Errorf("history[6]: %v", e)
	}
}
