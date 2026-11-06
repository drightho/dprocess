package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/dright/dprocess/internal/store"
)

func newStory(name, assignee string) store.NewStory {
	return store.NewStory{Name: name, Assignee: assignee}
}

func httpGetJSONArray(url string) ([]any, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out []any
	err = json.NewDecoder(resp.Body).Decode(&out)
	return out, err
}

func TestStoryLifecycle(t *testing.T) {
	srv, st := newTestServer(t)
	api := srv.URL + "/api/v1"
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")

	resp, s := do(t, "POST", api+"/epics/1/stories",
		`{"name":" S1 ","description":"d","acceptance_criteria":"ac","estimate_loc":120,"assignee":"bob"}`)
	if resp.StatusCode != 201 || s["name"] != "S1" || s["state"] != "draft" || s["project_id"] != float64(1) || s["estimate_loc"] != float64(120) {
		t.Fatalf("create: %d %v", resp.StatusCode, s)
	}
	if w, _ := s["warnings"].([]any); len(w) != 0 {
		t.Fatalf("unexpected warnings: %v", s["warnings"])
	}

	// Validation.
	for _, body := range []string{`{}`, `{"name":" "}`, `{"name":"x","estimate_loc":-1}`} {
		if resp, _ = do(t, "POST", api+"/epics/1/stories", body); resp.StatusCode != 422 {
			t.Fatalf("%s: %d", body, resp.StatusCode)
		}
	}
	if resp, _ = do(t, "POST", api+"/epics/1/stories", `{"name":"x","estimate_loc":"big"}`); resp.StatusCode != 400 {
		t.Fatalf("string estimate: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "POST", api+"/epics/9/stories", `{"name":"x"}`); resp.StatusCode != 404 {
		t.Fatalf("unknown epic: %d", resp.StatusCode)
	}

	// Large estimate is accepted with a warning.
	resp, s = do(t, "PATCH", api+"/stories/1", `{"estimate_loc":450}`)
	if resp.StatusCode != 200 {
		t.Fatalf("patch: %d %v", resp.StatusCode, s)
	}
	if w, _ := s["warnings"].([]any); len(w) != 1 || w[0] != "estimate_exceeds_400_loc" {
		t.Fatalf("warnings: %v", s["warnings"])
	}
	// Exactly 400 does not warn; other fields stay untouched.
	resp, s = do(t, "PATCH", api+"/stories/1", `{"estimate_loc":400}`)
	if w, _ := s["warnings"].([]any); len(w) != 0 || s["assignee"] != "bob" {
		t.Fatalf("400: %v", s)
	}
	// Explicit null clears the estimate; absent field leaves it alone.
	_, s = do(t, "PATCH", api+"/stories/1", `{"description":"d2"}`)
	if s["estimate_loc"] != float64(400) {
		t.Fatalf("absent estimate changed: %v", s["estimate_loc"])
	}
	_, s = do(t, "PATCH", api+"/stories/1", `{"estimate_loc":null}`)
	if s["estimate_loc"] != nil {
		t.Fatalf("null estimate: %v", s["estimate_loc"])
	}
	// State is not patchable.
	if resp, _ = do(t, "PATCH", api+"/stories/1", `{"state":"finished"}`); resp.StatusCode != 400 {
		t.Fatalf("patch state: %d", resp.StatusCode)
	}

	// Transitions.
	resp, s = do(t, "POST", api+"/stories/1/transition", `{"to":"review","reason":"r","actor":"ann"}`)
	if resp.StatusCode != 200 || s["state"] != "review" {
		t.Fatalf("to review: %d %v", resp.StatusCode, s)
	}
	if at, _ := s["allowed_transitions"].([]any); len(at) != 2 || at[0] != "design" {
		t.Fatalf("allowed: %v", s["allowed_transitions"])
	}
	if resp, _ = do(t, "POST", api+"/stories/1/transition", `{"to":"testing"}`); resp.StatusCode != 409 {
		t.Fatalf("illegal: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "POST", api+"/stories/1/transition", `{"to":"ready"}`); resp.StatusCode != 422 {
		t.Fatalf("epic-only state: %d", resp.StatusCode)
	}
	if h, _ := st.ListHistory("story", 1); len(h) != 1 || h[0].ToState != "review" || h[0].Actor != "ann" {
		t.Fatalf("history: %+v", h)
	}
}

func TestStoryListingAndFilters(t *testing.T) {
	srv, st := newTestServer(t)
	api := srv.URL + "/api/v1"
	st.CreateProject("P", "")
	st.CreateProject("Q", "")
	st.CreateEpic(1, "E1", "")
	st.CreateEpic(1, "E2", "")
	st.CreateEpic(2, "E3", "")
	st.CreateStory(1, newStory("a", "ann"))
	st.CreateStory(2, newStory("b", "bob"))
	st.CreateStory(3, newStory("c", "ann"))
	do(t, "POST", api+"/stories/2/transition", `{"to":"review"}`)

	count := func(url string) int {
		t.Helper()
		resp, err := httpGetJSONArray(url)
		if err != nil {
			t.Fatal(err)
		}
		return len(resp)
	}
	if n := count(api + "/projects/1/stories"); n != 2 {
		t.Fatalf("project 1: %d", n)
	}
	if n := count(api + "/projects/1/stories?state=review"); n != 1 {
		t.Fatalf("state: %d", n)
	}
	if n := count(api + "/projects/1/stories?epic=1"); n != 1 {
		t.Fatalf("epic: %d", n)
	}
	if n := count(api + "/projects/1/stories?assignee=ann"); n != 1 {
		t.Fatalf("assignee: %d", n)
	}
	if n := count(api + "/epics/2/stories"); n != 1 {
		t.Fatalf("epic stories: %d", n)
	}
	if resp, _ := do(t, "GET", api+"/projects/1/stories?state=bogus", ""); resp.StatusCode != 422 {
		t.Fatalf("bad state: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "GET", api+"/projects/1/stories?epic=x", ""); resp.StatusCode != 422 {
		t.Fatalf("bad epic: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "GET", api+"/projects/9/stories", ""); resp.StatusCode != 404 {
		t.Fatalf("unknown project: %d", resp.StatusCode)
	}
}

func TestDeleteStory(t *testing.T) {
	srv, st := newTestServer(t)
	api := srv.URL + "/api/v1"
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")
	st.CreateStory(1, newStory("a", ""))
	st.CreateStory(1, newStory("b", ""))
	st.DB.Exec(`INSERT INTO story_dependencies(story_id, depends_on_id) VALUES (2, 1)`)

	// Story 1 has a dependent: refuse. Story 2 has only outgoing edges: allowed.
	if resp, _ := do(t, "DELETE", api+"/stories/1", ""); resp.StatusCode != 409 {
		t.Fatalf("with dependents: %d", resp.StatusCode)
	}
	do(t, "POST", api+"/stories/2/transition", `{"to":"review"}`)
	if resp, _ := do(t, "DELETE", api+"/stories/2", ""); resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if h, _ := st.ListHistory("story", 2); len(h) != 0 {
		t.Fatalf("history kept: %v", h)
	}
	if resp, _ := do(t, "DELETE", api+"/stories/1", ""); resp.StatusCode != 204 {
		t.Fatalf("delete after edge removed: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "GET", api+"/stories/1", ""); resp.StatusCode != 404 {
		t.Fatalf("after delete: %d", resp.StatusCode)
	}
}
