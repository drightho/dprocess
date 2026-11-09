package api

import (
	"reflect"
	"strings"
	"testing"
)

const repoMsg = "expected https://github.com/{owner}/{repo}"

func repoOf(t *testing.T, m map[string]any) string {
	t.Helper()
	v, ok := m["github_repo_url"]
	if !ok {
		t.Fatalf("github_repo_url missing: %v", m)
	}
	s, ok := v.(string)
	if !ok {
		t.Fatalf("github_repo_url must be a string, got %T (%v)", v, v)
	}
	return s
}

func warningsOf(t *testing.T, m map[string]any) []string {
	t.Helper()
	v, ok := m["warnings"]
	if !ok {
		t.Fatalf("warnings missing: %v", m)
	}
	arr, ok := v.([]any)
	if !ok {
		t.Fatalf("warnings must be an array, got %T (%v) in %v", v, v, m)
	}
	out := []string{}
	for _, x := range arr {
		out = append(out, x.(string))
	}
	return out
}

func wantWarn(t *testing.T, what string, m map[string]any, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := warningsOf(t, m); !reflect.DeepEqual(got, want) {
		t.Errorf("%s: warnings %v, want %v", what, got, want)
	}
}

func TestProjectRepoLinkLifecycle(t *testing.T) {
	srv, _ := newTestServer(t)
	base := srv.URL + "/api/v1/projects"

	// Create without the field: "" everywhere.
	resp, p := do(t, "POST", base, `{"name":"A"}`)
	if resp.StatusCode != 201 || repoOf(t, p) != "" {
		t.Fatalf("create: %d %v", resp.StatusCode, p)
	}
	// Create with a messy URL: stored canonical.
	resp, p = do(t, "POST", base, `{"name":"B","github_repo_url":"  https://github.com/Owner/Repo.git/ "}`)
	if resp.StatusCode != 201 || repoOf(t, p) != "https://github.com/owner/repo" {
		t.Fatalf("create with link: %d %v", resp.StatusCode, p)
	}
	// Create with "" or whitespace: 201, no link.
	for i, v := range []string{`""`, `"   "`} {
		resp, p = do(t, "POST", base, `{"name":"E`+string(rune('0'+i))+`","github_repo_url":`+v+`}`)
		if resp.StatusCode != 201 || repoOf(t, p) != "" {
			t.Fatalf("create with %s: %d %v", v, resp.StatusCode, p)
		}
	}
	// GET one and list carry it.
	_, g := do(t, "GET", base+"/2", "")
	if repoOf(t, g) != "https://github.com/owner/repo" {
		t.Errorf("get: %v", g)
	}
	list, err := httpGetJSONArray(base)
	if err != nil || len(list) != 4 {
		t.Fatalf("list: %v %v", list, err)
	}
	links := map[string]string{}
	for _, x := range list {
		m := x.(map[string]any)
		links[m["name"].(string)] = repoOf(t, m)
	}
	if links["A"] != "" || links["B"] != "https://github.com/owner/repo" || links["E0"] != "" {
		t.Errorf("list links: %v", links)
	}

	// PATCH sets the link, canonicalised; name and description edits keep it.
	resp, p = do(t, "PATCH", base+"/1", `{"github_repo_url":"https://github.com/Acme/Widgets"}`)
	if resp.StatusCode != 200 || repoOf(t, p) != "https://github.com/acme/widgets" {
		t.Fatalf("patch set: %d %v", resp.StatusCode, p)
	}
	resp, p = do(t, "PATCH", base+"/1", `{"name":"A2","description":"d"}`)
	if resp.StatusCode != 200 || repoOf(t, p) != "https://github.com/acme/widgets" || p["name"] != "A2" {
		t.Fatalf("name edit keeps link: %d %v", resp.StatusCode, p)
	}
	// null and an absent field leave it unchanged.
	for _, body := range []string{`{"github_repo_url":null}`, `{}`, `{"github_repo_url":null,"name":"A3"}`} {
		resp, p = do(t, "PATCH", base+"/1", body)
		if resp.StatusCode != 200 || repoOf(t, p) != "https://github.com/acme/widgets" {
			t.Fatalf("patch %s: %d %v", body, resp.StatusCode, p)
		}
	}
	// A different link replaces the first.
	resp, p = do(t, "PATCH", base+"/1", `{"github_repo_url":"https://github.com/acme/gadgets.git"}`)
	if resp.StatusCode != 200 || repoOf(t, p) != "https://github.com/acme/gadgets" {
		t.Fatalf("replace: %d %v", resp.StatusCode, p)
	}
	// "" and whitespace clear it, in the response and on the next GET.
	for _, clear := range []string{`""`, `"  \t "`} {
		do(t, "PATCH", base+"/1", `{"github_repo_url":"https://github.com/acme/widgets"}`)
		resp, p = do(t, "PATCH", base+"/1", `{"github_repo_url":`+clear+`}`)
		if resp.StatusCode != 200 || repoOf(t, p) != "" {
			t.Fatalf("clear with %s: %d %v", clear, resp.StatusCode, p)
		}
		_, g = do(t, "GET", base+"/1", "")
		if repoOf(t, g) != "" || g["name"] != "A3" {
			t.Errorf("get after clear: %v", g)
		}
	}
}

func TestProjectRepoLinkRefused(t *testing.T) {
	srv, _ := newTestServer(t)
	base := srv.URL + "/api/v1/projects"
	_, _ = do(t, "POST", base, `{"name":"keep","description":"d","github_repo_url":"https://github.com/o/r"}`)

	bad := []string{
		"http://github.com/o/r", "https://www.github.com/o/r", "https://gitlab.com/o/r",
		"https://u@github.com/o/r", "https://github.com/o/r?x=1", "https://github.com/o/r#f",
		"https://github.com/o/r/tree/main", "https://github.com/o/r/issues", "https://github.com/o/r/pull/1",
		"https://github.com/o", "https://github.com/o/..", "https://github.com/./r", "https://github.com/o/.git",
		"not a url",
	}
	for _, u := range bad {
		resp, m := do(t, "POST", base, `{"name":"new","github_repo_url":"`+u+`"}`)
		if resp.StatusCode != 422 || !strings.Contains(m["detail"].(string), repoMsg) {
			t.Errorf("create %q: %d %v", u, resp.StatusCode, m)
		}
		resp, m = do(t, "PATCH", base+"/1", `{"name":"changed","description":"x","github_repo_url":"`+u+`"}`)
		if resp.StatusCode != 422 || !strings.Contains(m["detail"].(string), repoMsg) {
			t.Errorf("patch %q: %d %v", u, resp.StatusCode, m)
		}
	}
	// No project was created, and the existing one is untouched (also its name and description).
	list, _ := httpGetJSONArray(base)
	if len(list) != 1 {
		t.Fatalf("projects after refused creates: %v", list)
	}
	_, g := do(t, "GET", base+"/1", "")
	if g["name"] != "keep" || g["description"] != "d" || repoOf(t, g) != "https://github.com/o/r" {
		t.Errorf("project changed by refused PATCH: %v", g)
	}
	// Wrong type is a bad request, not a 422.
	if resp, _ := do(t, "PATCH", base+"/1", `{"github_repo_url":5}`); resp.StatusCode != 400 {
		t.Errorf("number: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "PATCH", base+"/99", `{"github_repo_url":"https://github.com/o/r"}`); resp.StatusCode != 404 {
		t.Errorf("unknown project: %d", resp.StatusCode)
	}
}

func TestProjectsMayShareRepo(t *testing.T) {
	srv, _ := newTestServer(t)
	base := srv.URL + "/api/v1/projects"
	for _, n := range []string{"A", "B"} {
		resp, p := do(t, "POST", base, `{"name":"`+n+`","github_repo_url":"https://github.com/o/r"}`)
		if resp.StatusCode != 201 || repoOf(t, p) != "https://github.com/o/r" {
			t.Fatalf("create %s: %d %v", n, resp.StatusCode, p)
		}
	}
	do(t, "POST", base, `{"name":"C"}`)
	if resp, p := do(t, "PATCH", base+"/3", `{"github_repo_url":"https://github.com/O/R.git"}`); resp.StatusCode != 200 || repoOf(t, p) != "https://github.com/o/r" {
		t.Errorf("third project: %d %v", resp.StatusCode, p)
	}
}

func TestEpicsRefuseRepoField(t *testing.T) {
	srv, st := newTestServer(t)
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")
	api := srv.URL + "/api/v1"
	if resp, _ := do(t, "POST", api+"/projects/1/epics", `{"name":"x","github_repo_url":"https://github.com/o/r"}`); resp.StatusCode != 400 {
		t.Errorf("epic create: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "PATCH", api+"/epics/1", `{"github_repo_url":"https://github.com/o/r"}`); resp.StatusCode != 400 {
		t.Errorf("epic patch: %d", resp.StatusCode)
	}
	_, e := do(t, "GET", api+"/epics/1", "")
	if _, has := e["github_repo_url"]; has {
		t.Errorf("epic response must not carry github_repo_url: %v", e)
	}
}

// --- warnings ---

func TestIssueRepoMismatchWarnings(t *testing.T) {
	apiBase, call := setupStories(t) // projects 1 (P) and 2 (Q); stories 1-4 in P

	// No link: no warning, but the array is there on every response.
	code, i := call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/widgets/issues/1"}`)
	if code != 201 {
		t.Fatalf("create: %d %v", code, i)
	}
	wantWarn(t, "create without link", i)
	_, i = call("GET", "/issues/1", "")
	wantWarn(t, "get without link", i)

	call("PATCH", "/projects/1", `{"github_repo_url":"https://github.com/Acme/Widgets"}`)
	// Matching, other repo and other owner, created while linked.
	code, i = call("POST", "/projects/1/issues", `{"github_url":"https://github.com/ACME/widgets/issues/2"}`)
	if code != 201 {
		t.Fatalf("matching: %d", code)
	}
	wantWarn(t, "create matching", i)
	code, i = call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/other/issues/3","title":"t"}`)
	if code != 201 {
		t.Fatalf("mismatching issue must still be created: %d %v", code, i)
	}
	wantWarn(t, "create mismatching", i, "repo_mismatch")
	call("POST", "/projects/1/issues", `{"github_url":"https://github.com/evil/widgets/issues/4"}`)
	// Project 2 has no link: its issue in any repo is fine.
	_, i = call("POST", "/projects/2/issues", `{"github_url":"https://github.com/acme/other/issues/3"}`)
	wantWarn(t, "other project, no link", i)

	// GET one, PATCH and list recompute.
	_, i = call("GET", "/issues/1", "")
	wantWarn(t, "get matching", i)
	_, i = call("GET", "/issues/3", "")
	wantWarn(t, "get mismatching", i, "repo_mismatch")
	code, i = call("PATCH", "/issues/3", `{"title":"renamed"}`)
	if code != 200 {
		t.Fatalf("patch mismatching: %d", code)
	}
	wantWarn(t, "patch mismatching", i, "repo_mismatch")
	_, i = call("PATCH", "/issues/1", `{"title":"renamed"}`)
	wantWarn(t, "patch matching", i)

	checkList := func(what string, want map[float64][]string) {
		t.Helper()
		list, err := httpGetJSONArray(apiBase + "/projects/1/issues")
		if err != nil || len(list) != 4 {
			t.Fatalf("%s: list %v %v", what, list, err)
		}
		for _, x := range list {
			m := x.(map[string]any)
			w := want[m["id"].(float64)]
			wantWarn(t, what+" issue "+m["github_url"].(string), m, w...)
		}
	}
	checkList("linked", map[float64][]string{1: nil, 2: nil, 3: {"repo_mismatch"}, 4: {"repo_mismatch"}})

	// The story filter of the list also carries warnings.
	call("PATCH", "/issues/3", `{"story_id":1}`)
	filtered, _ := httpGetJSONArray(apiBase + "/projects/1/issues?story=1")
	if len(filtered) != 1 {
		t.Fatalf("filtered: %v", filtered)
	}
	wantWarn(t, "filtered list", filtered[0].(map[string]any), "repo_mismatch")

	// Changing the link changes the warnings on the next read.
	call("PATCH", "/projects/1", `{"github_repo_url":"https://github.com/acme/other"}`)
	checkList("relinked", map[float64][]string{1: {"repo_mismatch"}, 2: {"repo_mismatch"}, 3: nil, 4: {"repo_mismatch"}})
	_, i = call("GET", "/issues/3", "")
	wantWarn(t, "get after relink", i)
	// Clearing it removes them all.
	call("PATCH", "/projects/1", `{"github_repo_url":""}`)
	checkList("cleared", map[float64][]string{1: nil, 2: nil, 3: nil, 4: nil})
	// Linking again brings them back; a failed PATCH of the project changes nothing.
	call("PATCH", "/projects/1", `{"github_repo_url":"https://github.com/acme/widgets"}`)
	call("PATCH", "/projects/1", `{"github_repo_url":"https://example.com/x/y"}`)
	checkList("relinked again", map[float64][]string{1: nil, 2: nil, 3: {"repo_mismatch"}, 4: {"repo_mismatch"}})
}

func TestPullRequestRepoMismatchWarnings(t *testing.T) {
	api, call := setupStories(t) // stories 1-4 in project 1, story 5 in project 2
	prs := func(story string) []any {
		t.Helper()
		l, err := httpGetJSONArray(api + "/stories/" + story + "/pull-requests")
		if err != nil {
			t.Fatal(err)
		}
		return l
	}

	code, pr := call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/widgets/pull/1"}`)
	if code != 201 {
		t.Fatalf("add: %d %v", code, pr)
	}
	wantWarn(t, "add without link", pr)

	call("PATCH", "/projects/1", `{"github_repo_url":"https://github.com/acme/widgets"}`)
	code, pr = call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/Acme/Widgets/pull/2"}`)
	if code != 201 {
		t.Fatal(code)
	}
	wantWarn(t, "add matching", pr)
	code, pr = call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/other/pull/3"}`)
	if code != 201 {
		t.Fatalf("mismatching PR must still be added: %d %v", code, pr)
	}
	wantWarn(t, "add mismatching", pr, "repo_mismatch")
	// Story 5 belongs to project 2 (no link): the project is found via story -> epic -> project.
	code, pr = call("POST", "/stories/5/pull-requests", `{"github_url":"https://github.com/acme/other/pull/3"}`)
	if code != 201 {
		t.Fatal(code)
	}
	wantWarn(t, "other project, no link", pr)
	// Project 2 gets a link that only matches story 5's PR.
	call("PATCH", "/projects/2", `{"github_repo_url":"https://github.com/acme/other"}`)
	wantWarn(t, "story 5 matches project 2", prs("5")[0].(map[string]any))
	// Same repo on story 2 (project 1) mismatches there.
	call("POST", "/stories/2/pull-requests", `{"github_url":"https://github.com/acme/other/pull/3"}`)

	check := func(what string, story string, want ...[]string) {
		t.Helper()
		l := prs(story)
		if len(l) != len(want) {
			t.Fatalf("%s: story %s has %d PRs, want %d", what, story, len(l), len(want))
		}
		for n, x := range l {
			wantWarn(t, what, x.(map[string]any), want[n]...)
		}
	}
	check("linked", "1", nil, nil, []string{"repo_mismatch"})
	check("linked", "2", []string{"repo_mismatch"})
	check("linked", "5", nil)
	check("empty list is an array", "3")

	// Story detail embeds the PRs and issues with warnings.
	_, s := call("GET", "/stories/1", "")
	embedded, _ := s["pull_requests"].([]any)
	if len(embedded) != 3 {
		t.Fatalf("story detail: %v", s["pull_requests"])
	}
	wantWarn(t, "story detail pr 1", embedded[0].(map[string]any))
	wantWarn(t, "story detail pr 3", embedded[2].(map[string]any), "repo_mismatch")
	call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/other/issues/9","story_id":1}`)
	call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/widgets/issues/10","story_id":1}`)
	_, s = call("GET", "/stories/1", "")
	iss, _ := s["issues"].([]any)
	if len(iss) != 2 {
		t.Fatalf("story detail issues: %v", s["issues"])
	}
	wantWarn(t, "story detail issue 9", iss[0].(map[string]any), "repo_mismatch")
	wantWarn(t, "story detail issue 10", iss[1].(map[string]any))
	// Other endpoints that return the story detail carry the same arrays.
	for what, resp := range map[string]func() map[string]any{
		"dependency PUT": func() map[string]any { _, m := call("PUT", "/stories/1/dependencies/2", ""); return m },
		"tag PUT":        func() map[string]any { _, m := call("PUT", "/stories/1/tags/x", ""); return m },
	} {
		m := resp()
		prs, _ := m["pull_requests"].([]any)
		iss, _ := m["issues"].([]any)
		if len(prs) != 3 || len(iss) != 2 {
			t.Fatalf("%s: pull_requests %v issues %v", what, m["pull_requests"], m["issues"])
		}
		wantWarn(t, what+" pr 3", prs[2].(map[string]any), "repo_mismatch")
		wantWarn(t, what+" issue 10", iss[1].(map[string]any))
	}
	// Story without PRs/issues: still arrays.
	_, s = call("GET", "/stories/3", "")
	if a, ok := s["pull_requests"].([]any); !ok || len(a) != 0 {
		t.Errorf("empty pull_requests: %v", s["pull_requests"])
	}

	// Changing or clearing the link changes the warnings on the next read.
	call("PATCH", "/projects/1", `{"github_repo_url":"https://github.com/acme/other"}`)
	check("relinked", "1", []string{"repo_mismatch"}, []string{"repo_mismatch"}, nil)
	check("relinked", "2", nil)
	_, s = call("GET", "/stories/1", "")
	wantWarn(t, "story detail after relink", s["pull_requests"].([]any)[2].(map[string]any))
	call("PATCH", "/projects/1", `{"github_repo_url":""}`)
	check("cleared", "1", nil, nil, nil)
	check("cleared", "2", nil)
}
