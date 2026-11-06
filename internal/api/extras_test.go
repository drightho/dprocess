package api

import (
	"strings"
	"testing"
)

func names(m map[string]any, key string) []string {
	var out []string
	for _, v := range m[key].([]any) {
		out = append(out, v.(string))
	}
	return out
}

func TestTags(t *testing.T) {
	api, call := setupStories(t)
	call("POST", "/projects/1/epics", `{"name":"E"}`) // epic 3 (setup made 1 and 2)

	// Add (idempotent, normalized) to a story and an epic.
	for i := 0; i < 2; i++ {
		code, m := call("PUT", "/stories/1/tags/Backend", "")
		if code != 200 || strings.Join(names(m, "tags"), ",") != "backend" {
			t.Fatalf("add: %d %v", code, m["tags"])
		}
	}
	call("PUT", "/stories/1/tags/api", "")
	call("PUT", "/stories/2/tags/api", "")
	if code, m := call("PUT", "/epics/1/tags/q1", ""); code != 200 || len(names(m, "tags")) != 1 {
		t.Fatalf("epic tag: %d %v", code, m)
	}

	// Tags show in GET and are sorted.
	_, m := call("GET", "/stories/1", "")
	if strings.Join(names(m, "tags"), ",") != "api,backend" {
		t.Fatalf("tags: %v", m["tags"])
	}
	_, m = call("GET", "/stories/3", "")
	if len(names(m, "tags")) != 0 || m["tags"] == nil {
		t.Fatalf("untagged should be empty array: %v", m["tags"])
	}

	// Filters.
	list := func(path string) []any {
		l, err := httpGetJSONArray(api + path)
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	if n := len(list("/projects/1/stories?tag=api")); n != 2 {
		t.Fatalf("story tag filter: %d", n)
	}
	if n := len(list("/projects/1/stories?tag=BACKEND")); n != 1 {
		t.Fatalf("normalized filter: %d", n)
	}
	if n := len(list("/projects/1/epics?tag=q1")); n != 1 {
		t.Fatalf("epic tag filter: %d", n)
	}
	if l := list("/projects/1/stories"); len(l[0].(map[string]any)["tags"].([]any)) != 2 {
		t.Fatalf("list should carry tags: %v", l[0])
	}
	if code, _ := call("GET", "/projects/1/stories?tag=bad%20tag", ""); code != 422 {
		t.Fatalf("bad filter: %d", code)
	}

	// Errors and removal.
	if code, _ := call("PUT", "/stories/1/tags/-bad", ""); code != 422 {
		t.Fatalf("invalid tag: %d", code)
	}
	if code, _ := call("PUT", "/stories/99/tags/x", ""); code != 404 {
		t.Fatalf("unknown story: %d", code)
	}
	if code, _ := call("DELETE", "/stories/1/tags/api", ""); code != 204 {
		t.Fatalf("remove: %d", code)
	}
	if code, _ := call("DELETE", "/stories/1/tags/api", ""); code != 404 {
		t.Fatalf("remove twice: %d", code)
	}
}

func TestComments(t *testing.T) {
	api, call := setupStories(t)
	code, c := call("POST", "/stories/1/comments", `{"body":"  looks good ","author":"ann"}`)
	if code != 201 || c["body"] != "looks good" || c["author"] != "ann" || c["entity_type"] != "story" {
		t.Fatalf("create: %d %v", code, c)
	}
	call("POST", "/epics/1/comments", `{"body":"epic note"}`)
	for _, body := range []string{`{}`, `{"body":"  "}`} {
		if code, _ := call("POST", "/stories/1/comments", body); code != 422 {
			t.Fatalf("%s: %d", body, code)
		}
	}
	if code, _ := call("POST", "/stories/99/comments", `{"body":"x"}`); code != 404 {
		t.Fatalf("unknown story: %d", code)
	}
	if code, _ := call("GET", "/epics/99/comments", ""); code != 404 {
		t.Fatalf("unknown epic: %d", code)
	}
	// Listing returns only this entity's comments, oldest first.
	call("POST", "/stories/1/comments", `{"body":"second"}`)
	l, err := httpGetJSONArray(api + "/stories/1/comments")
	if err != nil || len(l) != 2 || l[1].(map[string]any)["body"] != "second" {
		t.Fatalf("list: %v %v", l, err)
	}
	if l, _ := httpGetJSONArray(api + "/epics/1/comments"); len(l) != 1 {
		t.Fatalf("epic comments: %v", l)
	}
}

func TestIssues(t *testing.T) {
	_, call := setupStories(t)
	url := "https://github.com/Acme/Widgets/issues/42"

	code, i := call("POST", "/projects/1/issues", `{"github_url":"`+url+`","title":" Crash ","kind":"bug","story_id":1}`)
	if code != 201 {
		t.Fatalf("create: %d %v", code, i)
	}
	if i["github_repo"] != "acme/widgets" || i["number"] != float64(42) || i["title"] != "Crash" ||
		i["github_url"] != "https://github.com/acme/widgets/issues/42" || i["story_id"] != float64(1) {
		t.Fatalf("fields: %v", i)
	}

	// Duplicate (even differently cased / trailing slash) is a conflict.
	if code, _ := call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/widgets/issues/42/"}`); code != 409 {
		t.Fatalf("duplicate: %d", code)
	}
	// Same issue in another project is fine.
	if code, _ := call("POST", "/projects/2/issues", `{"github_url":"`+url+`"}`); code != 201 {
		t.Fatalf("other project: %d", code)
	}

	// Rejected inputs.
	rejected := map[string]int{
		`{}`: 422,
		`{"github_url":"https://gitlab.com/a/b/issues/1"}`:               422,
		`{"github_url":"https://github.com/a/b/pull/1"}`:                 422,
		`{"github_url":"https://github.com/a/b/issues/1#c"}`:             422,
		`{"github_url":"https://github.com/a/b/issues/2","story_id":99}`: 422, // unknown story
		`{"github_url":"https://github.com/a/b/issues/2","story_id":5}`:  422, // story in other project
		`{"github_url":"https://github.com/a/b/issues/2","bogus":true}`:  400,
	}
	for body, want := range rejected {
		if code, m := call("POST", "/projects/1/issues", body); code != want {
			t.Errorf("%s: got %d, want %d (%v)", body, code, want, m)
		}
	}
	if code, _ := call("POST", "/projects/99/issues", `{"github_url":"`+url+`"}`); code != 404 {
		t.Fatalf("unknown project: %d", code)
	}

	// Story detail lists linked issues.
	_, s := call("GET", "/stories/1", "")
	if is, _ := s["issues"].([]any); len(is) != 1 {
		t.Fatalf("story issues: %v", s["issues"])
	}

	// Patch: title/kind, relink, unlink; URL is immutable.
	if code, m := call("PATCH", "/issues/1", `{"title":"New","story_id":2}`); code != 200 || m["title"] != "New" || m["story_id"] != float64(2) || m["kind"] != "bug" {
		t.Fatalf("patch: %d %v", code, m)
	}
	if code, m := call("PATCH", "/issues/1", `{"story_id":null}`); code != 200 || m["story_id"] != nil {
		t.Fatalf("unlink: %d %v", code, m)
	}
	if code, _ := call("PATCH", "/issues/1", `{"story_id":5}`); code != 422 {
		t.Fatalf("relink cross-project: %d", code)
	}
	if code, _ := call("PATCH", "/issues/1", `{"github_url":"https://github.com/a/b/issues/9"}`); code != 400 {
		t.Fatalf("url immutable: %d", code)
	}

	// Filtering, project delete protection, delete.
	call("PATCH", "/issues/1", `{"story_id":3}`)
	if code, _ := call("GET", "/projects/1/issues?story=x", ""); code != 422 {
		t.Fatalf("bad story filter: %d", code)
	}
	if code, _ := call("DELETE", "/projects/2", ""); code != 409 {
		t.Fatalf("project with issues: %d", code)
	}
	if code, _ := call("DELETE", "/issues/2", ""); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := call("GET", "/issues/2", ""); code != 404 {
		t.Fatalf("after delete: %d", code)
	}
	// Deleting a linked story unlinks the issue instead of failing.
	if code, _ := call("DELETE", "/stories/3", ""); code != 204 {
		t.Fatalf("delete linked story: %d", code)
	}
	if _, m := call("GET", "/issues/1", ""); m["story_id"] != nil {
		t.Fatalf("issue should be unlinked: %v", m)
	}
}
