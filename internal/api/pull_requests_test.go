package api

import (
	"strings"
	"testing"
)

func TestPullRequestLinks(t *testing.T) {
	api, call := setupStories(t)

	code, pr := call("POST", "/stories/1/pull-requests", `{"github_url":" https://github.com/Acme/Widgets/pull/42/ "}`)
	if code != 201 || pr["github_url"] != "https://github.com/acme/widgets/pull/42" ||
		pr["github_repo"] != "acme/widgets" || pr["number"] != float64(42) || pr["story_id"] != float64(1) {
		t.Fatalf("create: %d %v", code, pr)
	}
	call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/widgets/pull/43"}`)
	call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/other/pull/42"}`) // same number, other repo

	// The same PR twice is a conflict (also with different case or trailing slash)...
	for _, u := range []string{"https://github.com/acme/widgets/pull/42", "https://github.com/ACME/widgets/pull/42/"} {
		if code, _ := call("POST", "/stories/1/pull-requests", `{"github_url":"`+u+`"}`); code != 409 {
			t.Errorf("duplicate %s: %d", u, code)
		}
	}
	// ...but another story may link the same PR.
	if code, _ := call("POST", "/stories/2/pull-requests", `{"github_url":"https://github.com/acme/widgets/pull/42"}`); code != 201 {
		t.Errorf("same PR on another story: %d", code)
	}

	// Listing, in the order added, and on the story itself.
	l, err := httpGetJSONArray(api + "/stories/1/pull-requests")
	if err != nil || len(l) != 3 || l[0].(map[string]any)["number"] != float64(42) || l[1].(map[string]any)["number"] != float64(43) {
		t.Fatalf("list: %v %v", l, err)
	}
	_, s := call("GET", "/stories/1", "")
	if prs, _ := s["pull_requests"].([]any); len(prs) != 3 {
		t.Fatalf("story detail pull_requests: %v", s["pull_requests"])
	}
	_, s = call("GET", "/stories/3", "")
	if prs, ok := s["pull_requests"].([]any); !ok || len(prs) != 0 {
		t.Fatalf("story without PRs must show an empty array: %v", s["pull_requests"])
	}

	// Removal.
	if code, _ := call("DELETE", "/stories/1/pull-requests/2", ""); code != 204 {
		t.Fatalf("remove: %d", code)
	}
	if code, _ := call("DELETE", "/stories/1/pull-requests/2", ""); code != 404 {
		t.Fatalf("remove twice: %d", code)
	}
	// A link belongs to its story: another story's link id is a 404.
	if code, _ := call("DELETE", "/stories/3/pull-requests/1", ""); code != 404 {
		t.Fatalf("remove via wrong story: %d", code)
	}
	if code, _ := call("DELETE", "/stories/1/pull-requests/x", ""); code != 404 {
		t.Fatalf("bad id: %d", code)
	}
	if l, _ := httpGetJSONArray(api + "/stories/1/pull-requests"); len(l) != 2 {
		t.Fatalf("after removal: %v", l)
	}

	// Unknown stories.
	if code, _ := call("POST", "/stories/99/pull-requests", `{"github_url":"https://github.com/a/b/pull/1"}`); code != 404 {
		t.Fatalf("unknown story: %d", code)
	}
	if code, _ := call("GET", "/stories/99/pull-requests", ""); code != 404 {
		t.Fatalf("list unknown story: %d", code)
	}
}

func TestOnlyPullRequestURLsAreAccepted(t *testing.T) {
	_, call := setupStories(t)
	rejected := []string{
		``,
		`https://github.com/acme/widgets/issues/1`,     // issues are not pull requests
		`https://github.com/acme/widgets/pull/1/files`, // a tab of a PR
		`https://github.com/acme/widgets/pull/1#discussion_r5`,
		`https://github.com/acme/widgets/pull/1?w=1`,
		`https://github.com/acme/widgets/pull/0`,
		`https://github.com/acme/widgets`,
		`http://github.com/acme/widgets/pull/1`,
		`https://gitlab.com/acme/widgets/pull/1`,
		`https://github.com.evil.example/acme/widgets/pull/1`,
		`ftp://github.com/acme/widgets/pull/1`,
		`github.com/acme/widgets/pull/1`,
		`javascript:alert(1)`,
	}
	for _, u := range rejected {
		code, m := call("POST", "/stories/1/pull-requests", `{"github_url":"`+u+`"}`)
		if code != 422 {
			t.Errorf("%q: got %d, want 422 (%v)", u, code, m)
		}
	}
	if code, m := call("POST", "/stories/1/pull-requests", `{}`); code != 422 || !strings.Contains(m["detail"].(string), "pull") {
		t.Errorf("missing url: %d %v", code, m)
	}
	if code, _ := call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/a/b/pull/1","extra":1}`); code != 400 {
		t.Errorf("unknown field: %d", code)
	}
	// Nothing was stored by the rejected attempts.
	if _, s := call("GET", "/stories/1", ""); len(s["pull_requests"].([]any)) != 0 {
		t.Errorf("rejected links were stored: %v", s["pull_requests"])
	}
	// PR URLs are no longer valid GitHub *issue* references either.
	if code, _ := call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/widgets/pull/1"}`); code != 422 {
		t.Errorf("PR URL as issue: %d", code)
	}
}

func TestPullRequestLinksFreezeWithTheStory(t *testing.T) {
	_, call := lockedSetup(t) // story 1 finished, story 2 cancelled, 3 and 4 live
	url := `{"github_url":"https://github.com/acme/widgets/pull/9"}`

	// Link while the story is live; it is frozen once the story is final.
	call("POST", "/stories/3/pull-requests", url)
	for _, id := range []string{"1", "2"} {
		if code, m := call("POST", "/stories/"+id+"/pull-requests", url); code != 409 || !strings.Contains(m["detail"].(string), "cannot be modified") {
			t.Errorf("add to terminal story %s: %d %v", id, code, m)
		}
	}
	storyTo(t, call, "3", "cancelled", 200)
	if code, _ := call("DELETE", "/stories/3/pull-requests/1", ""); code != 409 {
		t.Errorf("remove from cancelled story: %d", code)
	}
	// Still readable, and the link is intact.
	_, s := call("GET", "/stories/3", "")
	if len(s["pull_requests"].([]any)) != 1 {
		t.Errorf("link must survive a rejected removal: %v", s["pull_requests"])
	}
	if code, _ := call("GET", "/stories/3/pull-requests", ""); code != 200 {
		t.Errorf("list on terminal story: %d", code)
	}
	// Unknown story stays a 404, not a 409.
	if code, _ := call("POST", "/stories/99/pull-requests", url); code != 404 {
		t.Errorf("unknown: %d", code)
	}
}
