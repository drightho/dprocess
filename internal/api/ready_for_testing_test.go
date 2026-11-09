package api

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// storyAt walks story id to state through the API (epic 1 must be ready).
func storyAt(t *testing.T, call caller, id, state string) {
	t.Helper()
	path := []string{"review", "design", "implementation", "ready_for_testing"}
	for _, to := range path {
		storyTo(t, call, id, to, 200)
		if to == state {
			return
		}
	}
	t.Fatalf("storyAt: unsupported state %s", state)
}

func strs(m map[string]any, key string) []string {
	at, _ := m[key].([]any)
	var out []string
	for _, v := range at {
		out = append(out, v.(string))
	}
	return out
}

func TestReadyForTestingAllowedMoves(t *testing.T) {
	api, call := setupStories(t)
	readyEpic(t, call, "1")

	// implementation offers exactly ready_for_testing, design, cancelled.
	storyAt(t, call, "1", "implementation")
	_, m := call("GET", "/stories/1", "")
	if got := strings.Join(strs(m, "allowed_transitions"), ","); got != "ready_for_testing,design,cancelled" {
		t.Fatalf("allowed at implementation: %s", got)
	}
	m = storyTo(t, call, "1", "ready_for_testing", 200)
	if got := strings.Join(strs(m, "allowed_transitions"), ","); got != "testing,implementation,design,cancelled" {
		t.Fatalf("allowed at ready_for_testing: %s", got)
	}

	// The three moves out and back in, each leaving a history row.
	storyTo(t, call, "1", "implementation", 200)
	storyTo(t, call, "1", "ready_for_testing", 200)
	storyTo(t, call, "1", "design", 200)
	storyTo(t, call, "1", "implementation", 200) // from design: walk forward again
	storyTo(t, call, "1", "ready_for_testing", 200)
	storyTo(t, call, "1", "testing", 200)

	h, err := httpGetJSONArray(api + "/stories/1/history")
	if err != nil {
		t.Fatal(err)
	}
	var pairs []string
	for _, e := range h {
		r := e.(map[string]any)
		pairs = append(pairs, r["from_state"].(string)+">"+r["to_state"].(string))
	}
	got := strings.Join(pairs, " ")
	for _, want := range []string{
		"implementation>ready_for_testing", "ready_for_testing>implementation",
		"ready_for_testing>design", "ready_for_testing>testing",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("history lacks %s: %s", want, got)
		}
	}
	if strings.Contains(got, "implementation>testing") {
		t.Errorf("direct edge used: %s", got)
	}
}

func TestReadyForTestingCancel(t *testing.T) {
	api, call := setupStories(t)
	readyEpic(t, call, "1")
	storyAt(t, call, "1", "ready_for_testing")
	m := storyTo(t, call, "1", "cancelled", 200)
	if m["state"] != "cancelled" {
		t.Fatalf("%v", m)
	}
	h, _ := httpGetJSONArray(api + "/stories/1/history")
	last := h[len(h)-1].(map[string]any)
	if last["from_state"] != "ready_for_testing" || last["to_state"] != "cancelled" {
		t.Errorf("last history: %v", last)
	}
}

func TestReadyForTestingIllegalMoves(t *testing.T) {
	_, call := setupStories(t)
	readyEpic(t, call, "1")

	// implementation -> testing is gone.
	storyAt(t, call, "1", "implementation")
	storyTo(t, call, "1", "testing", 409)
	storyTo(t, call, "1", "pr_review", 409)
	storyTo(t, call, "1", "finished", 409)

	storyTo(t, call, "1", "ready_for_testing", 200)
	for _, to := range []string{"pr_review", "finished", "draft", "review", "ready_for_testing"} {
		storyTo(t, call, "1", to, 409)
	}
	// Unchanged after the refusals.
	if _, m := call("GET", "/stories/1", ""); m["state"] != "ready_for_testing" {
		t.Fatalf("state: %v", m["state"])
	}
	// testing -> ready_for_testing is not allowed; design -> ready_for_testing neither.
	storyTo(t, call, "1", "testing", 200)
	storyTo(t, call, "1", "ready_for_testing", 409)
	storyTo(t, call, "1", "design", 200)
	storyTo(t, call, "1", "ready_for_testing", 409)
}

func TestReadyForTestingNeedsReadyEpic(t *testing.T) {
	srv, st := newTestServer(t)
	call := func(method, path, body string) (int, map[string]any) {
		resp, m := do(t, method, srv.URL+"/api/v1"+path, body)
		return resp.StatusCode, m
	}
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")
	for _, n := range []string{"a", "b"} {
		st.CreateStory(1, newStory(n, ""))
	}
	toState(t, call, "1", "review", 200) // epic review: not ready
	// States the API cannot reach while the epic is in review are set directly.
	st.DB.Exec(`UPDATE stories SET state = 'implementation' WHERE id = 1`)
	st.DB.Exec(`UPDATE stories SET state = 'ready_for_testing' WHERE id = 2`)

	m := storyTo(t, call, "1", "ready_for_testing", 409)
	if d, _ := m["detail"].(string); !strings.Contains(d, "ready_for_testing") || !strings.Contains(d, "epic is review") {
		t.Fatalf("detail: %v", m["detail"])
	}
	// The backward moves out of ready_for_testing are gated the same way.
	for _, to := range []string{"implementation", "design", "testing"} {
		m = storyTo(t, call, "2", to, 409)
		if d, _ := m["detail"].(string); !strings.Contains(d, "epic is review") {
			t.Fatalf("-> %s detail: %v", to, m["detail"])
		}
	}
	// Cancelling is not gated.
	storyTo(t, call, "2", "cancelled", 200)
}

func TestReadyForTestingStaysLive(t *testing.T) {
	_, call := setupStories(t)
	readyEpic(t, call, "1")
	storyAt(t, call, "1", "ready_for_testing")

	// Fields stay editable.
	if code, m := call("PATCH", "/stories/1", `{"name":"renamed","estimate_loc":120}`); code != 200 || m["name"] != "renamed" {
		t.Fatalf("PATCH: %d %v", code, m)
	}
	// Tags, comments, issue links and pull request links work as in other live states.
	if code, _ := call("PUT", "/stories/1/tags/qa", ""); code != 200 {
		t.Errorf("tag: %d", code)
	}
	if code, _ := call("DELETE", "/stories/1/tags/qa", ""); code != 204 {
		t.Errorf("untag: %d", code)
	}
	if code, _ := call("POST", "/stories/1/comments", `{"body":"ready to test"}`); code != 201 {
		t.Errorf("comment: %d", code)
	}
	if code, i := call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/widgets/issues/9","story_id":1}`); code != 201 || i["story_id"] != float64(1) {
		t.Errorf("issue link: %d %v", code, i)
	}
	if code, _ := call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/widgets/pull/3"}`); code != 201 {
		t.Errorf("pull request: %d", code)
	}
	// Dependencies can be changed.
	if code, _ := call("PUT", "/stories/1/dependencies/2", ""); code != 200 && code != 201 && code != 204 {
		t.Errorf("add dependency: %d", code)
	}
}

func TestReadyForTestingDeleteRules(t *testing.T) {
	_, call := setupStories(t)
	readyEpic(t, call, "1")
	storyAt(t, call, "1", "ready_for_testing")
	storyAt(t, call, "2", "ready_for_testing")
	call("PUT", "/stories/3/dependencies/1", "") // story 3 depends on 1

	if code, _ := call("DELETE", "/stories/1", ""); code != 409 {
		t.Errorf("delete with dependents: %d", code)
	}
	if code, _ := call("DELETE", "/stories/2", ""); code != 204 {
		t.Errorf("delete live story: %d", code)
	}
}

func TestOpenAPIListsReadyForTesting(t *testing.T) {
	b, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	spec := string(b)
	found := false
	for _, line := range strings.Split(spec, "\n") {
		if strings.Contains(line, "enum:") && strings.Contains(line, "pr_review") && strings.Contains(line, "finished") {
			found = true
			if !strings.Contains(line, "implementation, ready_for_testing, testing") {
				t.Errorf("story state enum lacks ready_for_testing between implementation and testing: %s", line)
			}
		}
	}
	if !found {
		t.Error("story state enum not found")
	}
	if strings.Contains(spec, "read-for-testing") || strings.Contains(spec, "ready-for-testing") {
		t.Error("spec uses a misspelled state name")
	}
}

// The docs and the plugin spell the state ready_for_testing, never with hyphens.
func TestDocsSpellReadyForTesting(t *testing.T) {
	for _, f := range []string{"../../CLAUDE.md", "../../README.md"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), "ready_for_testing") {
			t.Errorf("%s does not mention ready_for_testing", f)
		}
	}
	files := []string{"../../CLAUDE.md", "../../README.md"}
	err := filepath.WalkDir("../../plugins/dprocess", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			files = append(files, p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, bad := range []string{"read-for-testing", "ready-for-testing"} {
			if strings.Contains(string(b), bad) {
				t.Errorf("%s contains %q", f, bad)
			}
		}
	}
}
