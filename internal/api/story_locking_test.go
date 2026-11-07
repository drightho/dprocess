package api

import (
	"strings"
	"testing"
)

// lockedSetup returns a project where epic 1 is ready, story 1 is finished,
// story 2 is cancelled and stories 3 and 4 are still in draft.
func lockedSetup(t *testing.T) (string, caller) {
	t.Helper()
	api, call := setupStories(t)
	readyEpic(t, call, "1")
	finishStory(t, call, "1")
	storyTo(t, call, "2", "cancelled", 200)
	return api, call
}

func TestTerminalStoriesCannotBeEdited(t *testing.T) {
	_, call := lockedSetup(t)

	for _, id := range []string{"1", "2"} { // finished, cancelled
		for _, body := range []string{
			`{"name":"renamed"}`, `{"description":"d"}`, `{"assignee":"zed"}`, `{"estimate_loc":10}`, `{"estimate_loc":null}`,
		} {
			code, m := call("PATCH", "/stories/"+id, body)
			if code != 409 {
				t.Fatalf("PATCH %s %s: got %d, want 409 (%v)", id, body, code, m)
			}
		}
		_, m := call("GET", "/stories/"+id, "")
		if m["name"] == "renamed" || m["assignee"] == "zed" {
			t.Fatalf("story %s changed despite 409: %v", id, m)
		}
	}
	if code, m := call("PATCH", "/stories/1", `{"name":"x"}`); code != 409 || !strings.Contains(m["detail"].(string), "finished") {
		t.Fatalf("message: %v", m)
	}
	// Live stories are still editable; unknown ones are 404, not 409.
	if code, _ := call("PATCH", "/stories/3", `{"name":"ok"}`); code != 200 {
		t.Fatalf("live story: %d", code)
	}
	if code, _ := call("PATCH", "/stories/99", `{"name":"x"}`); code != 404 {
		t.Fatalf("unknown story: %d", code)
	}
}

func TestDependenciesOfTerminalStoriesAreFrozen(t *testing.T) {
	_, call := lockedSetup(t)

	// Adding a dependency to a finished or cancelled story is refused...
	for _, id := range []string{"1", "2"} {
		if code, _ := call("PUT", "/stories/"+id+"/dependencies/3", ""); code != 409 {
			t.Errorf("add dependency to terminal story %s: %d", id, code)
		}
	}
	// ...but a live story may depend on a finished or a cancelled one.
	if code, _ := call("PUT", "/stories/3/dependencies/1", ""); code != 200 {
		t.Errorf("depend on finished story: %d", code)
	}
	if code, _ := call("PUT", "/stories/4/dependencies/2", ""); code != 200 {
		t.Errorf("depend on cancelled story: %d", code)
	}
	// Validation still comes first.
	if code, _ := call("PUT", "/stories/1/dependencies/1", ""); code != 422 {
		t.Errorf("self dependency on terminal story: %d", code)
	}

	// Removing a dependency also modifies the depending story: build an edge,
	// cancel the depending story, and the edge can no longer be removed.
	_, call2 := setupStories(t)
	readyEpic(t, call2, "1")
	call2("PUT", "/stories/3/dependencies/4", "")
	storyTo(t, call2, "3", "cancelled", 200)
	if code, _ := call2("DELETE", "/stories/3/dependencies/4", ""); code != 409 {
		t.Errorf("remove dependency from cancelled story: %d", code)
	}
	_, m := call2("GET", "/stories/3", "")
	if len(m["depends_on"].([]any)) != 1 {
		t.Errorf("edge must survive a rejected removal: %v", m["depends_on"])
	}
	if code, _ := call2("DELETE", "/stories/3/dependencies/99", ""); code != 404 {
		t.Errorf("missing edge: %d", code)
	}
}

func TestCancelledDependencyCanBeRemovedFromLiveStory(t *testing.T) {
	_, call := setupStories(t)
	readyEpic(t, call, "1")

	// Story 1 depends on story 2, which then gets cancelled: story 1 is stuck.
	call("PUT", "/stories/1/dependencies/2", "")
	for _, to := range []string{"review", "design", "implementation", "testing", "pr_review"} {
		storyTo(t, call, "1", to, 200)
	}
	storyTo(t, call, "2", "cancelled", 200)
	m := storyTo(t, call, "1", "finished", 409)
	if !strings.Contains(m["detail"].(string), "(cancelled)") {
		t.Fatalf("detail: %v", m["detail"])
	}

	// The live story may drop the dependency on the cancelled one...
	if code, _ := call("DELETE", "/stories/1/dependencies/2", ""); code != 204 {
		t.Fatalf("remove dependency on cancelled story: %d", code)
	}
	// ...and is then free to finish.
	storyTo(t, call, "1", "finished", 200)
	// Once finished, nothing about its dependencies can change any more.
	call("PUT", "/stories/3/dependencies/1", "") // fine: 3 is live, 1 is finished
	if code, _ := call("PUT", "/stories/1/dependencies/3", ""); code != 409 {
		t.Fatalf("add after finish: %d", code)
	}
}

func TestDeletingTerminalStories(t *testing.T) {
	_, call := lockedSetup(t)

	// Finished stories are kept.
	if code, m := call("DELETE", "/stories/1", ""); code != 409 || !strings.Contains(m["detail"].(string), "finished") {
		t.Fatalf("delete finished: %d %v", code, m)
	}
	if code, _ := call("GET", "/stories/1", ""); code != 200 {
		t.Fatalf("finished story must survive: %d", code)
	}

	// Cancelled stories may be deleted, but not while others depend on them.
	call("PUT", "/stories/3/dependencies/2", "")
	if code, _ := call("DELETE", "/stories/2", ""); code != 409 {
		t.Fatalf("cancelled with dependents: %d", code)
	}
	if code, _ := call("DELETE", "/stories/3/dependencies/2", ""); code != 204 {
		t.Fatalf("free the dependent: %d", code)
	}
	if code, _ := call("DELETE", "/stories/2", ""); code != 204 {
		t.Fatalf("delete cancelled: %d", code)
	}
	if code, _ := call("GET", "/stories/2", ""); code != 404 {
		t.Fatalf("after delete: %d", code)
	}
}

func TestTagsCommentsAndIssuesStayOpenOnTerminalStories(t *testing.T) {
	_, call := lockedSetup(t)
	for _, id := range []string{"1", "2"} { // finished, cancelled
		if code, _ := call("PUT", "/stories/"+id+"/tags/retro", ""); code != 200 {
			t.Errorf("add tag to %s: %d", id, code)
		}
		if code, _ := call("DELETE", "/stories/"+id+"/tags/retro", ""); code != 204 {
			t.Errorf("remove tag from %s: %d", id, code)
		}
		if code, _ := call("POST", "/stories/"+id+"/comments", `{"body":"afterthought"}`); code != 201 {
			t.Errorf("comment on %s: %d", id, code)
		}
	}
	code, i := call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/widgets/issues/9","story_id":1}`)
	if code != 201 || i["story_id"] != float64(1) {
		t.Fatalf("link issue to finished story: %d %v", code, i)
	}
	if code, _ := call("PATCH", "/issues/1", `{"story_id":2}`); code != 200 {
		t.Fatalf("relink to cancelled story: %d", code)
	}
	if code, _ := call("PATCH", "/issues/1", `{"story_id":null}`); code != 200 {
		t.Fatalf("unlink: %d", code)
	}
}
