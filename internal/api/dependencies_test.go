package api

import "testing"

// setupStories creates projects P(1) and Q(2), one epic each, and stories
// 1..4 in P and 5 in Q.
func setupStories(t *testing.T) (string, func(method, path, body string) (int, map[string]any)) {
	srv, st := newTestServer(t)
	st.CreateProject("P", "")
	st.CreateProject("Q", "")
	st.CreateEpic(1, "E1", "")
	st.CreateEpic(2, "E2", "")
	for _, n := range []string{"a", "b", "c", "d"} {
		st.CreateStory(1, newStory(n, ""))
	}
	st.CreateStory(2, newStory("q", ""))
	api := srv.URL + "/api/v1"
	return api, func(method, path, body string) (int, map[string]any) {
		resp, m := do(t, method, api+path, body)
		return resp.StatusCode, m
	}
}

func TestDependencies(t *testing.T) {
	_, call := setupStories(t)

	// 1 depends on 2 (idempotent), response lists relations.
	for i := 0; i < 2; i++ {
		code, m := call("PUT", "/stories/1/dependencies/2", "")
		if code != 200 {
			t.Fatalf("add: %d %v", code, m)
		}
		if deps, _ := m["depends_on"].([]any); len(deps) != 1 {
			t.Fatalf("depends_on: %v", m["depends_on"])
		}
	}
	_, m := call("GET", "/stories/2", "")
	if d, _ := m["dependents"].([]any); len(d) != 1 || d[0].(map[string]any)["name"] != "a" {
		t.Fatalf("dependents: %v", m["dependents"])
	}
	if d, _ := m["depends_on"].([]any); len(d) != 0 {
		t.Fatalf("depends_on should be empty array: %v", m["depends_on"])
	}

	// Rule violations.
	cases := []struct {
		name, path string
		want       int
	}{
		{"self", "/stories/1/dependencies/1", 422},
		{"cross-project", "/stories/1/dependencies/5", 422},
		{"cross-project reverse", "/stories/5/dependencies/1", 422},
		{"unknown story", "/stories/99/dependencies/1", 404},
		{"unknown dependency", "/stories/1/dependencies/99", 404},
		{"bad dep id", "/stories/1/dependencies/x", 404},
		{"direct cycle", "/stories/2/dependencies/1", 409},
	}
	for _, c := range cases {
		if code, _ := call("PUT", c.path, ""); code != c.want {
			t.Errorf("%s: got %d, want %d", c.name, code, c.want)
		}
	}
}

func TestDependencyCycleTransitiveAndDiamond(t *testing.T) {
	_, call := setupStories(t)
	// 1 -> 2 -> 3, then 3 -> 1 closes a cycle.
	call("PUT", "/stories/1/dependencies/2", "")
	call("PUT", "/stories/2/dependencies/3", "")
	if code, _ := call("PUT", "/stories/3/dependencies/1", ""); code != 409 {
		t.Fatalf("transitive cycle: %d", code)
	}
	// Diamond is fine: 1 -> 4, 4 -> 3 (1 reaches 3 two ways).
	call("PUT", "/stories/1/dependencies/4", "")
	if code, _ := call("PUT", "/stories/4/dependencies/3", ""); code != 200 {
		t.Fatalf("diamond: %d", code)
	}
	// After removing the middle edge the former cycle is allowed.
	if code, _ := call("DELETE", "/stories/1/dependencies/2", ""); code != 204 {
		t.Fatalf("remove: %d", code)
	}
	call("DELETE", "/stories/1/dependencies/4", "")
	if code, _ := call("PUT", "/stories/3/dependencies/1", ""); code != 200 {
		t.Fatalf("after removal: %d", code)
	}
}

func TestRemoveMissingDependency(t *testing.T) {
	_, call := setupStories(t)
	if code, _ := call("DELETE", "/stories/1/dependencies/2", ""); code != 404 {
		t.Fatalf("missing edge: %d", code)
	}
}
