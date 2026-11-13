package github

// Design tests for story 88: after an issue is imported, the sync assigns it
// to the token owner (GET /user, then POST .../issues/{n}/assignees). They use
// only Syncer.RunOnce, Status(), the real store and the fake GitHub of
// import_test.go, so they compile before the feature exists.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// assignCap is the story's limit of assignment requests per sync run.
const assignCap = 20

// posts returns the assignment requests so far, in order.
func (f *fakeGitHub) posts() []ghReq {
	var out []ghReq
	for _, r := range f.requests() {
		if r.Assign {
			out = append(out, r)
		}
	}
	return out
}

// postKeys describes the assignment requests as "owner/repo#number".
func (f *fakeGitHub) postKeys() []string {
	out := []string{}
	for _, r := range f.posts() {
		out = append(out, fmt.Sprintf("%s#%d", r.Repo, r.Number))
	}
	return out
}

// users counts the GET /user requests so far.
func (f *fakeGitHub) users() int {
	n := 0
	for _, r := range f.requests() {
		if r.User {
			n++
		}
	}
	return n
}

// assignedTo returns the numbers of the repository's issues that GitHub holds
// as assigned to login, ascending.
func (f *fakeGitHub) assignedTo(repo, login string) []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []int64{}
	if r := f.repos[repo]; r != nil {
		for _, is := range r.issues {
			if is.Assignee == login {
				out = append(out, is.Number)
			}
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a] < out[b] })
	return out
}

func (e *importEnv) wantPosts(want ...string) {
	e.t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := e.gh.postKeys(); !reflect.DeepEqual(got, want) {
		e.t.Errorf("assignment requests %v, want %v", got, want)
	}
}

// wantAssignError checks that last_error is exactly the story's per-issue form
// up to the cause, then contains cause.
func (e *importEnv) wantAssignError(project int64, repo string, number int64, cause string) {
	e.t.Helper()
	prefix := fmt.Sprintf("github assign: project %d %s#%d: ", project, repo, number)
	le := e.lastErr()
	if !strings.HasPrefix(le, prefix) || !strings.Contains(le, cause) {
		e.t.Errorf("last_error %q, want %q followed by something containing %q", le, prefix, cause)
	}
}

// assignedBody decodes the body of an assignment request.
func assignedBody(t *testing.T, r ghReq) []string {
	t.Helper()
	var b map[string][]string
	if err := json.Unmarshal([]byte(r.Body), &b); err != nil || len(b) != 1 {
		t.Fatalf("assignment body %q is not {\"assignees\": [...]}: %v", r.Body, err)
	}
	return b["assignees"]
}

// refsAtAssign makes the fake check, at each assignment request, that the issue
// is already referenced in every given project. It returns the violations.
func (e *importEnv) refsAtAssign(pids ...int64) func() []string {
	var mu sync.Mutex
	var bad []string
	e.gh.onAssign = func(repo string, n int64, _ *http.Request) {
		for _, pid := range pids {
			found := false
			is, _ := e.st.ListIssues(pid, 0)
			for _, i := range is {
				if i.Number == n && i.GitHubRepo == repo {
					found = true
				}
			}
			if !found {
				mu.Lock()
				bad = append(bad, fmt.Sprintf("%s#%d assigned before project %d had its reference", repo, n, pid))
				mu.Unlock()
			}
		}
	}
	return func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), bad...) }
}

// AC1 (and AC12/AC14 for the request itself): a created reference is assigned
// with one POST on the API base, after the lookup, never with a PATCH.
func TestAssignCreatedIssue(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.linkPull(p)
	e.gh.repo("acme/w", ghIssue{Number: 1}, ghIssue{Number: 2})
	bad := e.refsAtAssign(p)

	e.run()

	e.wantNumbers(p, []int64{1, 2})
	e.wantPosts("acme/w#1", "acme/w#2")
	for _, r := range e.gh.posts() {
		if r.Method != http.MethodPost || r.Auth != "Bearer tok" {
			t.Errorf("%s %s auth %q: want POST with the token", r.Method, r.Path, r.Auth)
		}
		if want := fmt.Sprintf("/repos/acme/w/issues/%d/assignees", r.Number); r.Path != want {
			t.Errorf("path %q, want %q", r.Path, want)
		}
		if got := assignedBody(t, r); !reflect.DeepEqual(got, []string{"bot"}) {
			t.Errorf("assignees %v, want [bot] (the login from GET /user)", got)
		}
	}
	if got := e.gh.assignedTo("acme/w", "bot"); !reflect.DeepEqual(got, []int64{1, 2}) {
		t.Errorf("assigned on GitHub: %v", got)
	}
	if n := e.gh.users(); n != 1 {
		t.Errorf("GET /user sent %d times, want once", n)
	}
	for _, r := range e.gh.requests() {
		if r.User {
			if r.Auth != "Bearer tok" {
				t.Errorf("GET /user auth %q", r.Auth)
			}
			break
		}
		if r.Assign {
			t.Error("an assignment was sent before the token owner was known")
			break
		}
	}
	if v := bad(); len(v) > 0 {
		t.Errorf("the reference must exist before the assignment: %v", v)
	}
	e.wantNoError()
	e.wantRefreshRan()
}

// AC2: an issue is assigned only when every linked project has its reference;
// one request per issue, not per project.
func TestAssignEveryLinkedProjectFirst(t *testing.T) {
	t.Run("cap leaves the third project without issue 7", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p1 := e.project("C", "acme/w")
		p2 := e.project("B", "acme/w")
		p3 := e.project("A", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 7)...)
		bad := e.refsAtAssign(p1, p2, p3)

		e.run()

		e.wantNumbers(p3, seq(1, 6))
		e.wantPosts("acme/w#1", "acme/w#2", "acme/w#3", "acme/w#4", "acme/w#5", "acme/w#6")
		e.wantNoError()

		e.gh.resetLog()
		e.run()

		e.wantNumbers(p3, seq(1, 7))
		e.wantPosts("acme/w#7")
		e.wantNoError()
		if v := bad(); len(v) > 0 {
			t.Error(v)
		}
	})
	t.Run("one request for several projects", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p1 := e.project("One", "acme/w")
		p2 := e.project("Two", "acme/w")
		e.gh.repo("acme/w", ghIssue{Number: 1})
		e.ref(p1, "acme/w", 1) // present in one project, created in the other
		bad := e.refsAtAssign(p1, p2)

		e.run()

		e.wantNumbers(p2, []int64{1})
		e.wantPosts("acme/w#1")
		if v := bad(); len(v) > 0 {
			t.Error(v)
		}
		e.wantNoError()
	})
}

// AC3: an issue whose insert failed in one linked project is not assigned in
// that run; a later run that completes the references assigns it.
func TestAssignInsertFailure(t *testing.T) {
	e := newImportEnv(t, "tok")
	p1 := e.project("One", "acme/w")
	p2 := e.project("Two", "acme/w")
	e.linkPull(p1)
	e.gh.repo("acme/w", openIssues(1, 3)...)
	if _, err := e.st.DB.Exec(fmt.Sprintf(`CREATE TRIGGER story88_fail_issue_2 BEFORE INSERT ON issues
		WHEN NEW.number = 2 AND NEW.project_id = %d BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`, p2)); err != nil {
		t.Fatal(err)
	}

	e.run()

	e.wantNumbers(p1, []int64{1, 2, 3})
	e.wantNumbers(p2, []int64{1, 3})
	e.wantPosts("acme/w#1", "acme/w#3")
	if le := e.lastErr(); !strings.Contains(le, fmt.Sprintf("project %d", p2)) || !strings.Contains(le, "acme/w#2") {
		t.Errorf("last_error %q must report the failed insert of project %d", le, p2)
	}
	e.wantRefreshRan()

	if _, err := e.st.DB.Exec(`DROP TRIGGER story88_fail_issue_2`); err != nil {
		t.Fatal(err)
	}
	e.gh.resetLog()
	e.run()

	e.wantNumbers(p2, []int64{1, 2, 3})
	e.wantPosts("acme/w#2")
	e.wantNoError()
}

// AC4: references that exist already (story 87's, by hand, from a run whose
// assignment failed) are assigned while their issue is still listed.
func TestAssignExistingReferences(t *testing.T) {
	t.Run("by hand and from story 87", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p1 := e.project("One", "acme/w")
		p2 := e.project("Two", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 3)...)
		for n := int64(1); n <= 3; n++ {
			e.ref(p1, "acme/w", n)
			e.ref(p2, "acme/w", n)
		}

		e.run()

		e.wantPosts("acme/w#1", "acme/w#2", "acme/w#3")
		e.wantNoError()

		e.gh.resetLog()
		e.run() // everything is assigned: nothing is listed, nothing is sent
		e.wantPosts()
		if n := e.gh.users(); n != 0 {
			t.Errorf("second run sent %d GET /user, want none", n)
		}
	})
	t.Run("retry after a failed assignment", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		r := e.gh.repo("acme/w", openIssues(1, 2)...)
		r.assignFail = map[int64]*ghFail{1: {Status: 500}}

		e.run()
		e.wantNumbers(p, []int64{1, 2})
		e.wantPosts("acme/w#1", "acme/w#2")

		e.gh.edit(func() { r.assignFail = nil })
		e.gh.resetLog()
		e.run()

		e.wantPosts("acme/w#1")
		e.wantNoError()
		if got := e.gh.assignedTo("acme/w", "bot"); !reflect.DeepEqual(got, []int64{1, 2}) {
			t.Errorf("assigned on GitHub: %v", got)
		}
	})
}

// AC5: the answer must list the token owner, compared case-insensitively.
func TestAssignAssigneeCheck(t *testing.T) {
	t.Run("silently ignored", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		r := e.gh.repo("acme/w", ghIssue{Number: 1})
		r.assignFail = map[int64]*ghFail{1: {Assignees: logins()}}

		e.run()

		e.wantAssignError(p, "acme/w", 1, "GitHub did not assign bot")
		if le := e.lastErr(); !strings.Contains(le, "the token needs write access to issues") {
			t.Errorf("last_error %q must say what the token needs", le)
		}
		e.wantNumbers(p, []int64{1})

		e.run() // still listed: tried again
		e.wantPosts("acme/w#1", "acme/w#1")

		e.gh.edit(func() { r.assignFail = nil })
		e.run()
		e.wantNoError()
		e.wantPosts("acme/w#1", "acme/w#1", "acme/w#1")
	})
	t.Run("another assignee only", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.repo("acme/w", ghIssue{Number: 1}).assignFail = map[int64]*ghFail{1: {Assignees: logins("someone-else")}}
		e.run()
		e.wantAssignError(p, "acme/w", 1, "GitHub did not assign bot")
	})
	t.Run("case-insensitive", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		e.project("P", "acme/w")
		e.gh.userLogin = "Bot"
		e.gh.repo("acme/w", ghIssue{Number: 1}).assignFail = map[int64]*ghFail{1: {Assignees: logins("BOT")}}
		e.run()
		e.wantNoError()
	})
}

// AC6: at most 20 assignment requests per run across repositories; silent;
// references are still created up to their own cap.
func TestAssignWriteCap(t *testing.T) {
	t.Run("one repository", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 25)...)
		for n := int64(1); n <= 25; n++ {
			e.ref(p, "acme/w", n)
		}

		e.run()

		e.wantPosts(keys("acme/w", 1, assignCap)...)
		e.wantNoError()
		e.gh.resetLog()
		e.run()
		e.wantPosts(keys("acme/w", 21, 25)...)
		e.wantNoError()
		if n := e.gh.users(); n != 0 {
			t.Errorf("GET /user on the second run: %d, want none (same Syncer, owner known)", n)
		}
	})
	t.Run("counted across repositories", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p1 := e.project("One", "acme/w")
		p2 := e.project("Two", "other/r")
		e.gh.repo("acme/w", openIssues(1, 15)...)
		e.gh.repo("other/r", openIssues(1, 15)...)
		for n := int64(1); n <= 15; n++ {
			e.ref(p1, "acme/w", n)
			e.ref(p2, "other/r", n)
		}

		e.run()

		e.wantPosts(append(keys("acme/w", 1, 15), keys("other/r", 1, 5)...)...)
		e.wantNoError()
		e.gh.resetLog()
		e.run()
		e.wantPosts(keys("other/r", 6, 15)...)
	})
	t.Run("references go on up to their own cap", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 25)...)
		for n := int64(1); n <= 20; n++ {
			e.ref(p, "acme/w", n)
		}

		e.run()

		e.wantNumbers(p, seq(1, 25))
		e.wantPosts(keys("acme/w", 1, 20)...)
		e.wantNoError()
		e.gh.resetLog()
		e.run()
		e.wantPosts(keys("acme/w", 21, 25)...)
	})
	t.Run("assignments take no reference slot", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 30)...)

		e.run()

		e.wantNumbers(p, seq(1, importCap))
		e.wantPosts(keys("acme/w", 1, assignCap)...)
		e.wantNoError()
	})
	t.Run("failed requests count", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		r := e.gh.repo("acme/w", openIssues(1, 22)...)
		r.assignFail = map[int64]*ghFail{1: {Status: 500}, 2: {Status: 500}, 3: {Status: 500}}
		for n := int64(1); n <= 22; n++ {
			e.ref(p, "acme/w", n)
		}

		e.run()

		e.wantPosts(keys("acme/w", 1, assignCap)...)
		e.wantAssignError(p, "acme/w", 1, "500")
	})
}

func keys(repo string, from, to int64) []string {
	out := []string{}
	for n := from; n <= to; n++ {
		out = append(out, fmt.Sprintf("%s#%d", repo, n))
	}
	return out
}

// AC7: the token owner is looked up lazily and once per Syncer.
func TestAssignLookupOnce(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.gh.repo("acme/w", ghIssue{Number: 5, Assignee: "someone"}, ghIssue{Number: 6, State: "closed"})

	e.run() // nothing to assign: no lookup
	if n := e.gh.users(); n != 0 {
		t.Fatalf("GET /user sent %d times without an issue to assign", n)
	}
	e.wantPosts()

	e.gh.repo("acme/w", ghIssue{Number: 7})
	e.run()
	e.gh.repo("acme/w", ghIssue{Number: 8})
	e.run()

	e.wantPosts("acme/w#7", "acme/w#8")
	if n := e.gh.users(); n != 1 {
		t.Errorf("GET /user sent %d times over three runs, want once", n)
	}
	e.wantNumbers(p, []int64{7, 8})
	e.wantNoError()
}

// AC8: a lookup that fails for another reason than 401 or a rate limit: the run
// goes on without assigning, and the next run asks again.
func TestAssignLookupFailure(t *testing.T) {
	cases := map[string]*ghFail{
		"403":           {Status: 403},
		"403 other":     {Status: 403, Header: map[string]string{"X-RateLimit-Remaining": "7"}},
		"404":           {Status: 404},
		"500":           {Status: 500},
		"unreadable":    {Body: "not json"},
		"no connection": {Drop: true},
	}
	for name, fl := range cases {
		t.Run(name, func(t *testing.T) {
			e := newImportEnv(t, "tok")
			p := e.project("P", "acme/w")
			e.linkPull(p)
			e.gh.repo("acme/w", openIssues(1, 2)...)
			e.gh.userFail = fl

			e.run()

			e.wantNumbers(p, []int64{1, 2})
			e.wantPosts()
			e.wantRefreshRan()
			if le := e.lastErr(); !strings.HasPrefix(le, "github assign: cannot determine the token owner: ") || len(le) <= len("github assign: cannot determine the token owner: ") {
				t.Errorf("last_error %q", le)
			}

			e.gh.edit(func() { e.gh.userFail = nil })
			e.gh.resetLog()
			e.run()

			if n := e.gh.users(); n != 1 {
				t.Errorf("the next run sent %d GET /user, want 1 (a failure is not cached)", n)
			}
			e.wantPosts("acme/w#1", "acme/w#2")
			e.wantNoError()
		})
	}
	t.Run("two repositories: at most one lookup, no assignment", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p1 := e.project("One", "acme/w")
		p2 := e.project("Two", "other/r")
		e.gh.repo("acme/w", ghIssue{Number: 1})
		e.gh.repo("other/r", ghIssue{Number: 1})
		e.gh.userFail = &ghFail{Status: 500}

		e.run()

		e.wantNumbers(p1, []int64{1})
		e.wantNumbers(p2, []int64{1})
		e.wantPosts()
		if n := e.gh.users(); n > 1 {
			t.Errorf("%d GET /user in one run, want at most one", n)
		}
		if !strings.HasPrefix(e.lastErr(), "github assign: cannot determine the token owner: ") {
			t.Errorf("last_error %q", e.lastErr())
		}
	})
	t.Run("an earlier error of the run is kept", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		pb := e.project("B", "broken/repo")
		e.project("P", "acme/w")
		e.gh.repo("broken/repo").status = 404
		e.gh.repo("acme/w", ghIssue{Number: 1})
		e.gh.userFail = &ghFail{Status: 500}

		e.run()

		e.wantErrorNames("broken/repo", pb)
		if le := e.lastErr(); strings.Contains(le, "github assign") {
			t.Errorf("the first error of the run must stay: %q", le)
		}
	})
}

func rateFails() map[string]struct {
	fail *ghFail
	want error
} {
	return map[string]struct {
		fail *ghFail
		want error
	}{
		"401":             {&ghFail{Status: 401}, ErrBadToken},
		"429":             {&ghFail{Status: 429}, ErrRateLimited},
		"403 remaining 0": {&ghFail{Status: 403, Header: map[string]string{"X-RateLimit-Remaining": "0"}}, ErrRateLimited},
		"403 retry-after": {&ghFail{Status: 403, Header: map[string]string{"Retry-After": "60"}}, ErrRateLimited},
	}
}

// AC9: a bad token or rate limit on the lookup or an assignment ends the run.
func TestAssignFatalErrors(t *testing.T) {
	for name, c := range rateFails() {
		setup := func(t *testing.T) (*importEnv, int64, int64) {
			e := newImportEnv(t, "tok")
			p1 := e.project("One", "acme/w")
			p2 := e.project("Two", "other/r")
			e.linkPull(p1)
			e.gh.repo("acme/w", openIssues(1, 2)...)
			e.gh.repo("other/r", ghIssue{Number: 1})
			return e, p1, p2
		}
		check := func(t *testing.T, e *importEnv, p2 int64) {
			t.Helper()
			if le := e.lastErr(); le != c.want.Error() {
				t.Errorf("last_error %q, want %q", le, c.want.Error())
			}
			rs := e.gh.requests()
			if len(rs) == 0 {
				t.Fatal("no request")
			}
			if e.gh.sawItem(linkedPullPath) {
				t.Error("the status refresh ran after the fatal error")
			}
			for _, l := range e.gh.lists() {
				if l.Repo == "other/r" {
					t.Error("another repository was listed after the fatal error")
				}
			}
			e.wantNumbers(p2, []int64{})
		}
		t.Run(name+" on the lookup", func(t *testing.T) {
			e, _, p2 := setup(t)
			e.gh.userFail = c.fail
			e.run()
			check(t, e, p2)
			e.wantPosts()
			if last := e.gh.requests(); !last[len(last)-1].User {
				t.Errorf("the lookup must be the last request, got %+v", last[len(last)-1])
			}
		})
		t.Run(name+" on an assignment", func(t *testing.T) {
			e, p1, p2 := setup(t)
			e.gh.repos["acme/w"].assignFail = map[int64]*ghFail{1: c.fail}
			e.run()
			check(t, e, p2)
			e.wantPosts("acme/w#1")
			if last := e.gh.requests(); !last[len(last)-1].Assign {
				t.Errorf("the assignment must be the last request, got %+v", last[len(last)-1])
			}
			// The reference is inserted before its assignment and stays.
			found := false
			for _, n := range e.numbers(p1) {
				found = found || n == 1
			}
			if !found {
				t.Error("the reference created before the fatal error must stay")
			}
		})
	}
	// Retry-After only turns a 403 on the lookup and assignments into a rate
	// limit; the list keeps story 87's handling (a plain failure of the repo).
	t.Run("403 with Retry-After on a list stays non-fatal", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		pb := e.project("B", "broken/repo")
		p := e.project("P", "acme/w")
		e.gh.repo("broken/repo").status = 403
		e.gh.repos["broken/repo"].header = map[string]string{"Retry-After": "60"}
		e.gh.repo("acme/w", ghIssue{Number: 1})

		e.run()

		e.wantErrorNames("broken/repo", pb)
		e.wantNumbers(p, []int64{1})
		e.wantPosts("acme/w#1")
	})
}

// AC10: every other failure of an assignment is recorded and the next issue is
// tried; N is the lowest linked project id.
func TestAssignNonFatalErrors(t *testing.T) {
	cases := []struct {
		name  string
		fail  *ghFail
		cause string
	}{
		{"403", &ghFail{Status: 403}, "GitHub answered 403"},
		{"403 with remaining requests", &ghFail{Status: 403, Header: map[string]string{"X-RateLimit-Remaining": "4"}}, "GitHub answered 403"},
		{"404", &ghFail{Status: 404}, "GitHub answered 404"},
		{"410", &ghFail{Status: 410}, "GitHub answered 410"},
		{"422", &ghFail{Status: 422}, "GitHub answered 422"},
		{"500", &ghFail{Status: 500}, "GitHub answered 500"},
		{"unreadable", &ghFail{Body: "<html>nope</html>"}, "unreadable GitHub response"},
		{"no connection", &ghFail{Drop: true}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newImportEnv(t, "tok")
			p1 := e.project("One", "acme/w")
			e.project("Two", "acme/w")
			e.linkPull(p1)
			r := e.gh.repo("acme/w", openIssues(1, 3)...)
			r.assignFail = map[int64]*ghFail{2: c.fail}

			e.run()

			e.wantPosts("acme/w#1", "acme/w#2", "acme/w#3")
			e.wantAssignError(p1, "acme/w", 2, c.cause)
			if got := e.gh.assignedTo("acme/w", "bot"); !reflect.DeepEqual(got, []int64{1, 3}) {
				t.Errorf("assigned on GitHub: %v, want [1 3]", got)
			}
			e.wantRefreshRan()

			e.gh.edit(func() { r.assignFail = nil })
			e.gh.resetLog()
			e.run()
			e.wantPosts("acme/w#2")
			e.wantNoError()
		})
	}
	t.Run("the first error of the run is kept", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 3)...).assignFail = map[int64]*ghFail{
			1: {Status: 404}, 2: {Status: 500}}
		e.run()
		e.wantAssignError(p, "acme/w", 1, "404")
	})
	t.Run("an import error is earlier", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		pb := e.project("B", "broken/repo")
		e.project("P", "acme/w")
		e.gh.repo("broken/repo").status = 404
		e.gh.repo("acme/w", ghIssue{Number: 1}).assignFail = map[int64]*ghFail{1: {Status: 404}}
		e.run()
		e.wantErrorNames("broken/repo", pb)
		if strings.Contains(e.lastErr(), "github assign") {
			t.Errorf("last_error %q", e.lastErr())
		}
	})
}

// AC11: no assignment request after the run's context is cancelled.
func TestAssignHonoursCancellation(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.linkPull(p)
	e.gh.repo("acme/w", openIssues(1, 4)...)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.gh.onAssign = func(_ string, _ int64, r *http.Request) {
		cancel()
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}

	e.runCtx(ctx)

	if got := e.gh.postKeys(); len(got) != 1 {
		t.Errorf("assignment requests %v: none may follow the cancellation", got)
	}
	if le := e.lastErr(); strings.Contains(le, "github assign") {
		t.Errorf("a cancelled run must not report an assignment failure: %q", le)
	}
	if e.gh.sawItem(linkedPullPath) {
		t.Error("the status refresh ran after the cancellation")
	}
}

// AC12: the token goes only to the API base; URLs come from the repository and
// the issue number, never from the answers.
func TestAssignTokenHost(t *testing.T) {
	var decoyHits atomic.Int32
	decoy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decoyHits.Add(1)
		w.WriteHeader(http.StatusTeapot)
	}))
	defer decoy.Close()
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	r := e.gh.repo("acme/w", ghIssue{Number: 1, HTMLURL: decoy.URL + "/x"}, ghIssue{Number: 2})
	r.apiURL = decoy.URL

	e.run()

	e.wantNumbers(p, []int64{1, 2})
	e.wantPosts("acme/w#1", "acme/w#2")
	for _, q := range e.gh.posts() {
		if want := fmt.Sprintf("/repos/acme/w/issues/%d/assignees", q.Number); q.Path != want {
			t.Errorf("path %q, want %q", q.Path, want)
		}
	}
	if n := decoyHits.Load(); n != 0 {
		t.Errorf("a foreign host received %d requests", n)
	}
	e.wantNoError()
}

// AC13: nothing is written, and the owner is not even looked up, without a
// token or for a project without a repository.
func TestAssignNoWriteWithoutConditions(t *testing.T) {
	t.Run("no token", func(t *testing.T) {
		e := newImportEnv(t, "")
		p := e.project("P", "acme/w")
		e.gh.repo("acme/w", ghIssue{Number: 1})
		e.ref(p, "acme/w", 1)
		e.run()
		e.wantPosts()
		if n := e.gh.users(); n != 0 {
			t.Errorf("GET /user without a token: %d", n)
		}
	})
	t.Run("no repository link", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "")
		e.gh.repo("acme/w", ghIssue{Number: 1})
		e.ref(p, "acme/w", 1)
		e.run()
		e.wantPosts()
		if n := e.gh.users() + len(e.gh.lists()); n != 0 {
			t.Errorf("no list or GET /user expected, got %d", n)
		}
	})
}

// A repository's paging is not disturbed by assignments, because the listing
// shrinks as issues are assigned: all issues are still seen in one run.
func TestAssignDoesNotDisturbPaging(t *testing.T) {
	t.Run("several pages", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.maxPerPage = 2
		e.gh.repo("acme/w", openIssues(1, 5)...)

		e.run()

		e.wantNumbers(p, seq(1, 5))
		e.wantPosts(keys("acme/w", 1, 5)...)
		e.wantNoError()
	})
	t.Run("a non-fatal list error still assigns what was collected", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.maxPerPage = 2
		r := e.gh.repo("acme/w", openIssues(1, 5)...)
		r.status, r.failPage = 500, 2

		e.run()

		e.wantNumbers(p, []int64{1, 2})
		e.wantPosts("acme/w#1", "acme/w#2")
		e.wantErrorNames("acme/w", p)
		if !strings.HasPrefix(e.lastErr(), "github import:") {
			t.Errorf("last_error %q", e.lastErr())
		}
	})
	t.Run("a fatal list error assigns nothing", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		e.project("P", "acme/w")
		e.gh.maxPerPage = 2
		r := e.gh.repo("acme/w", openIssues(1, 5)...)
		r.status, r.failPage = 401, 2

		e.run()

		e.wantPosts()
		if e.lastErr() != ErrBadToken.Error() {
			t.Errorf("last_error %q", e.lastErr())
		}
	})
}

// AC15: once its issue is assigned a deleted reference stays gone; un-assigning
// the issue brings it back on a later run.
func TestAssignDeletedReferenceStaysGone(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.gh.repo("acme/w", openIssues(1, 3)...)
	e.run()
	e.wantNumbers(p, []int64{1, 2, 3})
	for _, i := range e.refs(p) {
		if i.Number == 2 {
			if err := e.st.DeleteIssue(i.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	e.gh.resetLog()

	e.run()

	e.wantNumbers(p, []int64{1, 3})
	e.wantPosts()
	e.wantNoError()

	e.gh.edit(func() { e.gh.repos["acme/w"].issues[1].Assignee = "" })
	e.run()

	e.wantNumbers(p, []int64{1, 2, 3})
	e.wantPosts("acme/w#2")
	e.wantNoError()
}

// AC18: the sync status keeps exactly enabled, last_run_at and last_error.
func TestAssignStatusDocumentUnchanged(t *testing.T) {
	b, err := json.Marshal((&Syncer{}).Status())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for k := range m {
		got = append(got, k)
	}
	sort.Strings(got)
	if want := []string{"enabled", "last_error", "last_run_at"}; !reflect.DeepEqual(got, want) {
		t.Errorf("status fields %v, want %v", got, want)
	}
}
