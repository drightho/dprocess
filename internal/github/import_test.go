package github

// Design tests for story 87: the import of open, unassigned GitHub issues as
// issue references. They use only existing entry points (Syncer.RunOnce, the
// store and a fake GitHub), so they compile before the feature exists.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dright/dprocess/internal/store"
)

// importCap is the story's limit of created references per sync run.
const importCap = 20

// ghIssue is one entry of the fake's issue list.
type ghIssue struct {
	Number   int64  // also the sort key when the number is hidden
	Title    string // "" = "Issue <n>"
	State    string // "" = open
	Assignee string // login, "" = unassigned
	PR       bool   // carries the "pull_request" key
	HTMLURL  string // "" = the repository's own URL
	// How "number" appears in the list answer: "" as is, "omit" or "zero".
	NumberMode string
}

type ghRepo struct {
	issues   []ghIssue
	status   int               // != 0: the list answers with this status
	failPage int               // the status applies from this page on (0 = every page)
	header   map[string]string // extra headers for the failing answer
	body     string            // != "": raw 200 body of the list
	nextLink string            // != "": replaces the rel="next" URL
	// onList runs before a list request is answered.
	onList func(page int, r *http.Request)
	// assignFail makes the assignment POST of an issue number fail (story 88).
	assignFail map[int64]*ghFail
	// apiURL != "": the list entries carry "url", "repository_url" and
	// "assignees_url" pointing there (a host the token must never reach).
	apiURL string
}

// ghFail describes how the fake answers a request wrongly (story 88).
type ghFail struct {
	Status int               // != 0: answer with this status
	Header map[string]string // headers of that answer
	Body   string            // != "": raw body of a 2xx answer (or of the failure)
	Drop   bool              // close the connection without an answer
	// Assignees != nil: the assignees the 2xx answer reports instead of the
	// requested login. An empty list is GitHub silently ignoring the assignee;
	// a non-empty list is stored as the assignment.
	Assignees *[]string
}

func logins(l ...string) *[]string { return &l }

type ghReq struct {
	Method, Path, Query, Auth string
	List                      bool   // a list request (not a single item)
	Repo                      string // owner/repo
	Page                      int    // list requests only
	User                      bool   // GET /user (story 88)
	Assign                    bool   // POST .../issues/{n}/assignees (story 88)
	Number                    int64  // assignment requests only
	Body                      string // assignment requests only
}

// fakeGitHub imitates the endpoints the sync uses: the issue list and single
// items (reads), GET /user and the assignment POST (story 88). Like GitHub, the list
// filters and orders only when asked: the default is open issues with any
// assignee, newest first, 30 per page, pull requests included.
type fakeGitHub struct {
	*httptest.Server
	t          *testing.T
	mu         sync.Mutex
	repos      map[string]*ghRepo
	maxPerPage int // upper limit for per_page (GitHub: 100)
	itemStatus int // != 0: every single-item request answers with it
	reqs       []ghReq
	// Story 88: the token owner's login, how GET /user fails (nil = works) and
	// a hook run before an assignment is answered.
	userLogin string
	userFail  *ghFail
	onAssign  func(repo string, number int64, r *http.Request)
}

var (
	listPath = regexp.MustCompile(`^/repos/([^/]+/[^/]+)/issues$`)
	itemPath = regexp.MustCompile(`^/repos/([^/]+/[^/]+)/(issues|pulls)/(\d+)$`)
	// assignPath is the one write the sync may send (story 88).
	assignPath = regexp.MustCompile(`^/repos/([^/]+/[^/]+)/issues/(\d+)/assignees$`)
)

func newFakeGitHub(t *testing.T) *fakeGitHub {
	t.Helper()
	f := &fakeGitHub{t: t, repos: map[string]*ghRepo{}, maxPerPage: 100, userLogin: "bot"}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(func() {
		f.Close()
		for _, r := range f.requests() {
			if r.Method != http.MethodGet && !r.Assign {
				t.Errorf("the only write the sync may send is the assignment POST: got %s %s", r.Method, r.Path)
			}
			if r.Assign && r.Method != http.MethodPost {
				t.Errorf("an assignment must be a POST, got %s %s", r.Method, r.Path)
			}
		}
	})
	return f
}

func (f *fakeGitHub) serve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	req := ghReq{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Auth: r.Header.Get("Authorization")}
	if m := listPath.FindStringSubmatch(r.URL.Path); m != nil {
		req.List, req.Repo, req.Page = true, m[1], 1
		if p, err := strconv.Atoi(q.Get("page")); err == nil && p > 0 {
			req.Page = p
		}
	} else if m := itemPath.FindStringSubmatch(r.URL.Path); m != nil {
		req.Repo = m[1]
	}
	am := assignPath.FindStringSubmatch(r.URL.Path)
	if am != nil {
		req.Repo = am[1]
		req.Number, _ = strconv.ParseInt(am[2], 10, 64)
		req.Assign = true
		b, _ := io.ReadAll(r.Body)
		req.Body = string(b)
	}
	req.User = r.URL.Path == "/user"
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	f.mu.Unlock()
	if am != nil && r.Method == http.MethodPost {
		f.serveAssign(w, r, req)
		return
	}
	if req.User && r.Method == http.MethodGet {
		f.serveUser(w)
		return
	}
	if r.Method != http.MethodGet || am != nil {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if req.List {
		f.serveList(w, r, req)
		return
	}
	f.serveItem(w, r)
}

func (f *fakeGitHub) serveList(w http.ResponseWriter, r *http.Request, req ghReq) {
	f.mu.Lock()
	repo := f.repos[req.Repo]
	var hook func(int, *http.Request)
	if repo != nil {
		hook = repo.onList
	}
	f.mu.Unlock()
	if repo == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if hook != nil {
		hook(req.Page, r)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if repo.status != 0 && req.Page >= repo.failPage {
		for k, v := range repo.header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(repo.status)
		return
	}
	if repo.body != "" {
		w.Write([]byte(repo.body))
		return
	}
	q := r.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "open"
	}
	var sel []ghIssue
	for _, is := range repo.issues {
		st := is.State
		if st == "" {
			st = "open"
		}
		if state != "all" && st != state {
			continue
		}
		if q.Get("assignee") == "none" && is.Assignee != "" {
			continue
		}
		sel = append(sel, is)
	}
	asc := q.Get("direction") == "asc"
	sort.Slice(sel, func(i, j int) bool {
		if asc {
			return sel[i].Number < sel[j].Number
		}
		return sel[i].Number > sel[j].Number
	})
	per := 30
	if p, err := strconv.Atoi(q.Get("per_page")); err == nil && p > 0 {
		per = p
	}
	if per > f.maxPerPage {
		per = f.maxPerPage
	}
	pages := (len(sel) + per - 1) / per
	from := (req.Page - 1) * per
	if from > len(sel) {
		from = len(sel)
	}
	to := from + per
	if to > len(sel) {
		to = len(sel)
	}
	if req.Page < pages {
		pageURL := func(p int) string {
			v := url.Values{}
			for k, vs := range q {
				v[k] = vs
			}
			v.Set("page", strconv.Itoa(p))
			return f.URL + r.URL.Path + "?" + v.Encode()
		}
		next := pageURL(req.Page + 1)
		if repo.nextLink != "" {
			next = repo.nextLink
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s>; rel="next", <%s>; rel="last"`, next, pageURL(pages)))
	}
	out := []map[string]any{}
	for _, is := range sel[from:to] {
		e := map[string]any{
			"title":     issueTitle(is),
			"state":     "open",
			"html_url":  fmt.Sprintf("https://github.com/%s/issues/%d", req.Repo, is.Number),
			"assignee":  nil,
			"assignees": []any{},
		}
		switch is.NumberMode {
		case "omit":
		case "zero":
			e["number"] = 0
		default:
			e["number"] = is.Number
		}
		if is.State != "" {
			e["state"] = is.State
		}
		if is.HTMLURL != "" {
			e["html_url"] = is.HTMLURL
		}
		if repo.apiURL != "" {
			e["url"] = fmt.Sprintf("%s/repos/%s/issues/%d", repo.apiURL, req.Repo, is.Number)
			e["repository_url"] = fmt.Sprintf("%s/repos/%s", repo.apiURL, req.Repo)
			e["assignees_url"] = fmt.Sprintf("%s/repos/%s/issues/%d/assignees{/user}", repo.apiURL, req.Repo, is.Number)
		}
		if is.Assignee != "" {
			u := map[string]any{"login": is.Assignee}
			e["assignee"], e["assignees"] = u, []any{u}
		}
		if is.PR {
			e["pull_request"] = map[string]any{"url": fmt.Sprintf("%s/repos/%s/pulls/%d", f.URL, req.Repo, is.Number)}
		}
		out = append(out, e)
	}
	json.NewEncoder(w).Encode(out)
}

// answerFail writes a ghFail; it reports whether it answered. An answer that
// is not a failure (a 2xx status with no body) is left to the caller.
func answerFail(w http.ResponseWriter, fl *ghFail) bool {
	if fl == nil {
		return false
	}
	if fl.Drop {
		if hj, ok := w.(http.Hijacker); ok {
			if c, _, err := hj.Hijack(); err == nil {
				c.Close()
			}
		}
		return true
	}
	if fl.Status >= 400 {
		for k, v := range fl.Header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(fl.Status)
		w.Write([]byte(fl.Body))
		return true
	}
	return false
}

// serveUser answers GET /user with the token owner.
func (f *fakeGitHub) serveUser(w http.ResponseWriter) {
	f.mu.Lock()
	fl, login := f.userFail, f.userLogin
	f.mu.Unlock()
	if answerFail(w, fl) {
		return
	}
	if fl != nil && fl.Body != "" {
		w.Write([]byte(fl.Body))
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"login": login, "id": 1})
}

// serveAssign answers POST /repos/{o}/{r}/issues/{n}/assignees like GitHub: 201
// with the issue and its assignees. A success stores the assignment, so the list
// with assignee=none no longer returns the issue.
func (f *fakeGitHub) serveAssign(w http.ResponseWriter, r *http.Request, req ghReq) {
	f.mu.Lock()
	hook := f.onAssign
	var fl *ghFail
	if repo := f.repos[req.Repo]; repo != nil {
		fl = repo.assignFail[req.Number]
	}
	f.mu.Unlock()
	if hook != nil {
		hook(req.Repo, req.Number, r)
	}
	if answerFail(w, fl) {
		return
	}
	if fl != nil && fl.Body != "" {
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(fl.Body))
		return
	}
	var in struct {
		Assignees []string `json:"assignees"`
	}
	if err := json.Unmarshal([]byte(req.Body), &in); err != nil {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	got := in.Assignees
	if fl != nil && fl.Assignees != nil {
		got = *fl.Assignees
	}
	f.mu.Lock()
	found := false
	if repo := f.repos[req.Repo]; repo != nil {
		for i := range repo.issues {
			if repo.issues[i].Number == req.Number {
				found = true
				if len(got) > 0 {
					repo.issues[i].Assignee = got[0]
				}
			}
		}
	}
	f.mu.Unlock()
	if !found {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	users := []map[string]any{}
	for _, l := range got {
		users = append(users, map[string]any{"login": l})
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"number": req.Number, "state": "open", "assignees": users})
}

// serveItem answers the status refresh: a single object, separate from the list.
func (f *fakeGitHub) serveItem(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := itemPath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if f.itemStatus != 0 {
		w.WriteHeader(f.itemStatus)
		return
	}
	if m[2] == "pulls" {
		w.Write([]byte(`{"title":"A pull request","state":"closed","merged":true}`))
		return
	}
	n, _ := strconv.ParseInt(m[3], 10, 64)
	if repo := f.repos[m[1]]; repo != nil {
		for _, is := range repo.issues {
			if is.Number == n && is.NumberMode == "" {
				st := is.State
				if st == "" {
					st = "open"
				}
				json.NewEncoder(w).Encode(map[string]any{"number": n, "title": issueTitle(is), "state": st})
				return
			}
		}
	}
	w.WriteHeader(http.StatusNotFound)
}

func issueTitle(is ghIssue) string {
	if is.Title != "" {
		return is.Title
	}
	return fmt.Sprintf("Issue %d", is.Number)
}

// repo returns (creating it if needed) the fake repository; change it only
// inside edit once a run may be in flight.
func (f *fakeGitHub) repo(name string, issues ...ghIssue) *ghRepo {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.repos[name]
	if r == nil {
		r = &ghRepo{}
		f.repos[name] = r
	}
	r.issues = append(r.issues, issues...)
	return r
}

func (f *fakeGitHub) edit(fn func()) { f.mu.Lock(); fn(); f.mu.Unlock() }

func (f *fakeGitHub) requests() []ghReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ghReq(nil), f.reqs...)
}

func (f *fakeGitHub) resetLog() { f.mu.Lock(); f.reqs = nil; f.mu.Unlock() }

// lists returns the list requests so far, in order.
func (f *fakeGitHub) lists() []ghReq {
	var out []ghReq
	for _, r := range f.requests() {
		if r.List {
			out = append(out, r)
		}
	}
	return out
}

// items returns the single-item (status refresh) requests so far.
func (f *fakeGitHub) items() []ghReq {
	var out []ghReq
	for _, r := range f.requests() {
		if !r.List && !r.User && !r.Assign {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeGitHub) sawItem(path string) bool {
	for _, r := range f.items() {
		if r.Path == path {
			return true
		}
	}
	return false
}

// listed describes the list requests as "owner/repo?page=N".
func (f *fakeGitHub) listed() []string {
	out := []string{}
	for _, r := range f.lists() {
		out = append(out, fmt.Sprintf("%s?page=%d", r.Repo, r.Page))
	}
	return out
}

func openIssues(from, to int64) []ghIssue {
	var out []ghIssue
	for n := from; n <= to; n++ {
		out = append(out, ghIssue{Number: n})
	}
	return out
}

func seq(from, to int64) []int64 {
	out := []int64{}
	for n := from; n <= to; n++ {
		out = append(out, n)
	}
	return out
}

type importEnv struct {
	t  *testing.T
	st *store.Store
	gh *fakeGitHub
	y  *Syncer
}

// newImportEnv builds an empty store, a fake GitHub and a syncer with the token.
func newImportEnv(t *testing.T, token string) *importEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	gh := newFakeGitHub(t)
	return &importEnv{t: t, st: st, gh: gh,
		y: &Syncer{Store: st, Client: &Client{BaseURL: gh.URL, Token: token}}}
}

// project creates a project linked to github.com/<repo> ("" = no link).
func (e *importEnv) project(name, repo string) int64 {
	e.t.Helper()
	u := ""
	if repo != "" {
		u = "https://github.com/" + repo
	}
	p, err := e.st.CreateProjectWithRepo(name, "", u)
	if err != nil {
		e.t.Fatal(err)
	}
	return p.ID
}

// story adds an epic and a story to the project and returns the story id.
func (e *importEnv) story(projectID int64) int64 {
	e.t.Helper()
	ep, err := e.st.CreateEpic(projectID, "E", "")
	if err != nil {
		e.t.Fatal(err)
	}
	s, err := e.st.CreateStory(ep.ID, store.NewStory{Name: "s"})
	if err != nil {
		e.t.Fatal(err)
	}
	return s.ID
}

const linkedPullPath = "/repos/acme/linked/pulls/99"

// linkPull links a pull request that existed before the run; a request for
// linkedPullPath then proves that the status refresh ran.
func (e *importEnv) linkPull(projectID int64) {
	e.t.Helper()
	if _, err := e.st.AddPullRequest(e.story(projectID), "https://github.com/acme/linked/pull/99", "acme/linked", 99); err != nil {
		e.t.Fatal(err)
	}
}

func (e *importEnv) ref(projectID int64, repo string, number int64) *store.Issue {
	e.t.Helper()
	i, err := e.st.CreateIssue(projectID, store.NewIssue{
		URL: fmt.Sprintf("https://github.com/%s/issues/%d", repo, number), Repo: repo, Number: number})
	if err != nil {
		e.t.Fatal(err)
	}
	return i
}

// run does one sync run and fails instead of hanging.
func (e *importEnv) run() { e.t.Helper(); e.runCtx(context.Background()) }

func (e *importEnv) runCtx(ctx context.Context) {
	e.t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); e.y.RunOnce(ctx) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		e.t.Fatal("the sync run did not return")
	}
}

func (e *importEnv) refs(projectID int64) []*store.Issue {
	e.t.Helper()
	is, err := e.st.ListIssues(projectID, 0)
	if err != nil {
		e.t.Fatal(err)
	}
	return is
}

// numbers returns the issue numbers referenced in the project, ascending.
func (e *importEnv) numbers(projectID int64) []int64 {
	e.t.Helper()
	out := []int64{}
	for _, i := range e.refs(projectID) {
		out = append(out, i.Number)
	}
	sort.Slice(out, func(a, b int) bool { return out[a] < out[b] })
	return out
}

func (e *importEnv) wantNumbers(projectID int64, want []int64) {
	e.t.Helper()
	if got := e.numbers(projectID); !reflect.DeepEqual(got, want) {
		e.t.Errorf("project %d references issues %v, want %v", projectID, got, want)
	}
}

func (e *importEnv) lastErr() string { return e.y.Status().LastError }

func (e *importEnv) wantNoError() {
	e.t.Helper()
	if s := e.y.Status(); s.LastRunAt == nil || s.LastError != "" {
		e.t.Errorf("want a clean run, got %+v", s)
	}
}

// wantErrorNames checks that last_error names the repository and the project id.
func (e *importEnv) wantErrorNames(repo string, projectID int64) {
	e.t.Helper()
	le := e.lastErr()
	if !strings.Contains(le, repo) || !strings.Contains(le, fmt.Sprintf("project %d", projectID)) {
		e.t.Errorf("last_error %q must name %q and \"project %d\"", le, repo, projectID)
	}
}

func (e *importEnv) wantRefreshRan() {
	e.t.Helper()
	if !e.gh.sawItem(linkedPullPath) {
		e.t.Errorf("the status refresh did not run (no request for %s)", linkedPullPath)
	}
}

// AC1: open issues without an assignee are imported; closed and assigned are not.
func TestImportSelectsOpenUnassigned(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.gh.repo("acme/w",
		ghIssue{Number: 1},
		ghIssue{Number: 2, State: "closed"},
		ghIssue{Number: 3, Assignee: "ann"},
		ghIssue{Number: 4},
		ghIssue{Number: 5, State: "closed", Assignee: "ann"})

	e.run()

	e.wantNumbers(p, []int64{1, 4})
	e.wantNoError()
	lists := e.gh.lists()
	if len(lists) == 0 {
		t.Fatal("no list request reached GitHub")
	}
	for _, r := range lists {
		if r.Auth != "Bearer tok" || r.Repo != "acme/w" {
			t.Errorf("list request %+v: want repository acme/w with Authorization \"Bearer tok\"", r)
		}
	}
}

// AC2: list entries with a "pull_request" key are skipped.
func TestImportSkipsPullRequests(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.gh.repo("acme/w", ghIssue{Number: 1}, ghIssue{Number: 2, PR: true}, ghIssue{Number: 3})

	e.run()

	e.wantNumbers(p, []int64{1, 3})
	e.wantNoError()
}

// AC3: the fields of a created reference come from the project's repository
// and the issue number, never from html_url; nothing else is created.
func TestImportCreatedFields(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/widgets")
	e.story(p) // one epic and one story exist before the run
	e.gh.repo("acme/widgets", ghIssue{Number: 42, Title: "Crash on Save",
		HTMLURL: "https://github.com/Other-Org/Renamed/issues/42"})

	e.run()

	refs := e.refs(p)
	if len(refs) != 1 {
		t.Fatalf("want 1 reference, got %d", len(refs))
	}
	got := refs[0]
	if got.GitHubRepo != "acme/widgets" || got.GitHubURL != "https://github.com/acme/widgets/issues/42" {
		t.Errorf("repo %q url %q: want the linked repository, not html_url", got.GitHubRepo, got.GitHubURL)
	}
	if got.Number != 42 || got.Title != "Crash on Save" || got.Kind != "" || got.StoryID != nil || got.ProjectID != p {
		t.Errorf("reference %+v: want number 42, the GitHub title, kind \"\" and no story", got)
	}
	for table, want := range map[string]int{"epics": 1, "stories": 1, "issues": 1} {
		var n int
		if err := e.st.DB.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil || n != want {
			t.Errorf("%s: %d rows (err %v), want %d", table, n, err, want)
		}
	}
	e.wantNoError()
}

// AC4: every project linked to the repository gets the issue; the repository
// is listed once per run.
func TestImportEveryLinkedProjectListsRepoOnce(t *testing.T) {
	e := newImportEnv(t, "tok")
	p1 := e.project("One", "acme/w")
	p2 := e.project("Two", "acme/w")
	e.gh.repo("acme/w", openIssues(1, 2)...)

	e.run()

	e.wantNumbers(p1, []int64{1, 2})
	e.wantNumbers(p2, []int64{1, 2})
	if got := e.gh.listed(); !reflect.DeepEqual(got, []string{"acme/w?page=1"}) {
		t.Errorf("list requests %v, want exactly one for acme/w", got)
	}
	e.wantNoError()
}

// AC5: all pages are followed, also when the earlier pages already exist.
func TestImportFollowsPagination(t *testing.T) {
	t.Run("fresh project", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.maxPerPage = 2
		e.gh.repo("acme/w", openIssues(1, 5)...)

		e.run()

		e.wantNumbers(p, seq(1, 5))
		want := []string{"acme/w?page=1", "acme/w?page=2", "acme/w?page=3"}
		if got := e.gh.listed(); !reflect.DeepEqual(got, want) {
			t.Errorf("list requests %v, want %v", got, want)
		}
		e.wantNoError()
	})
	t.Run("earlier pages already exist", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.maxPerPage = 2
		e.gh.repo("acme/w", openIssues(1, 5)...)
		for n := int64(1); n <= 4; n++ {
			e.ref(p, "acme/w", n)
		}

		e.run()

		e.wantNumbers(p, seq(1, 5))
		e.wantNoError()
	})
}

// AC6: an existing reference is neither created again nor modified; a second
// run without changes creates nothing.
func TestImportLeavesExistingReferences(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	sid := e.story(p)
	old, err := e.st.CreateIssue(p, store.NewIssue{StoryID: &sid, URL: "https://github.com/acme/w/issues/1",
		Repo: "acme/w", Number: 1, Title: "my own title", Kind: "bug"})
	if err != nil {
		t.Fatal(err)
	}
	e.gh.repo("acme/w", ghIssue{Number: 1, Title: "title on GitHub"}, ghIssue{Number: 2})

	e.run()

	e.wantNumbers(p, []int64{1, 2})
	got, err := e.st.GetIssue(old.ID)
	if err != nil {
		t.Fatalf("the existing reference is gone: %v", err)
	}
	if got.Title != "my own title" || got.Kind != "bug" || got.StoryID == nil || *got.StoryID != sid {
		t.Errorf("existing reference was modified: %+v", got)
	}
	e.wantNoError()

	ids := func() []int64 {
		out := []int64{}
		for _, i := range e.refs(p) {
			out = append(out, i.ID)
		}
		return out
	}
	before := ids()
	e.run()
	if after := ids(); !reflect.DeepEqual(after, before) {
		t.Errorf("a second run changed the references: ids %v -> %v", before, after)
	}
	e.wantNoError()
}

// AC7: a reference that appears between the list and the insert is skipped
// silently and does not count toward the cap.
func TestImportDuplicateAtInsertIsSilent(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	r := e.gh.repo("acme/w", openIssues(1, importCap+1)...)
	var once sync.Once
	var raceErr atomic.Value
	r.onList = func(int, *http.Request) {
		once.Do(func() { // someone else creates #1 while GitHub answers
			if _, err := e.st.CreateIssue(p, store.NewIssue{URL: "https://github.com/acme/w/issues/1",
				Repo: "acme/w", Number: 1, Title: "raced"}); err != nil {
				raceErr.Store(err.Error())
			}
		})
	}

	e.run() // fails by timeout if the import holds the database during the request

	if v := raceErr.Load(); v != nil {
		t.Fatalf("test setup: creating the racing reference failed: %v", v)
	}
	// The raced one plus a full cap of created ones.
	e.wantNumbers(p, seq(1, importCap+1))
	e.wantNoError()
	for _, i := range e.refs(p) {
		if i.Number == 1 && i.Title != "raced" {
			t.Errorf("the raced reference was modified: %+v", i)
		}
	}
}

// AC8: at most 20 references per run across all projects; later runs create
// the rest.
func TestImportCapPerRun(t *testing.T) {
	t.Run("one project", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 45)...)
		for _, want := range []int64{20, 40, 45, 45} {
			e.run()
			e.wantNumbers(p, seq(1, want))
			e.wantNoError()
		}
	})
	t.Run("one issue in two projects counts as two", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p1 := e.project("One", "acme/w")
		p2 := e.project("Two", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 11)...)

		e.run()
		e.wantNumbers(p1, seq(1, 10))
		e.wantNumbers(p2, seq(1, 10))
		e.wantNoError()

		e.run()
		e.wantNumbers(p1, seq(1, 11))
		e.wantNumbers(p2, seq(1, 11))
		e.wantNoError()
	})
}

// AC9 (the story's example): lowest issue number first, each issue in all its
// projects in project id order before the next issue.
func TestImportCapOrderExample(t *testing.T) {
	e := newImportEnv(t, "tok")
	// Names sort the other way round than ids.
	p1 := e.project("C", "acme/w")
	p2 := e.project("B", "acme/w")
	p3 := e.project("A", "acme/w")
	e.gh.repo("acme/w", openIssues(1, 7)...)

	e.run()
	e.wantNumbers(p1, seq(1, 7))
	e.wantNumbers(p2, seq(1, 7))
	e.wantNumbers(p3, seq(1, 6))
	e.wantNoError()

	e.run()
	e.wantNumbers(p1, seq(1, 7))
	e.wantNumbers(p2, seq(1, 7))
	e.wantNumbers(p3, seq(1, 7))
	e.wantNoError()
}

// AC9: repositories are taken in order of their lowest linked project id.
func TestImportCapOrderRepositories(t *testing.T) {
	e := newImportEnv(t, "tok")
	p1 := e.project("B first id", "zeta/z")
	p2 := e.project("A second id", "alpha/a")
	p3 := e.project("C third id", "zeta/z")
	e.gh.repo("zeta/z", openIssues(1, 8)...)
	e.gh.repo("alpha/a", openIssues(1, 8)...)

	e.run()

	// zeta/z first (16 references in projects 1 and 3), then 4 of alpha/a.
	e.wantNumbers(p1, seq(1, 8))
	e.wantNumbers(p3, seq(1, 8))
	e.wantNumbers(p2, seq(1, 4))
	if got, want := e.gh.listed(), []string{"zeta/z?page=1", "alpha/a?page=1"}; !reflect.DeepEqual(got, want) {
		t.Errorf("list requests %v, want %v", got, want)
	}
	e.wantNoError()

	e.run()
	e.wantNumbers(p2, seq(1, 8))
	e.wantNoError()
}

// AC10 (and AC5): reaching the cap is silent, stops every further list
// request of that run and leaves the status refresh running; the next run
// pages past what exists.
func TestImportCapIsSilent(t *testing.T) {
	e := newImportEnv(t, "tok")
	p1 := e.project("One", "acme/w")
	p2 := e.project("Two", "other/r")
	e.linkPull(p1)
	e.gh.maxPerPage = 10
	e.gh.repo("acme/w", openIssues(1, 35)...)
	e.gh.repo("other/r", openIssues(1, 3)...)

	e.run()

	e.wantNoError()
	e.wantNumbers(p1, seq(1, 20))
	e.wantNumbers(p2, []int64{})
	// The 20th reference is the last entry of page 2: neither page 3 nor the
	// next repository is listed.
	if got, want := e.gh.listed(), []string{"acme/w?page=1", "acme/w?page=2"}; !reflect.DeepEqual(got, want) {
		t.Errorf("list requests %v, want %v", got, want)
	}
	e.wantRefreshRan()
	if got := e.st.RemoteStatus(store.KindIssue, "acme/w", 20); got.State != "open" {
		t.Errorf("issue 20 was created in this run and must be refreshed in it: %+v", got)
	}

	e.gh.resetLog()
	// Story 88: run one assigned issues 1..20; un-assign them again so that the
	// second run pages as story 87 described (nothing else changes).
	e.gh.edit(func() {
		for _, r := range e.gh.repos {
			for i := range r.issues {
				r.issues[i].Assignee = ""
			}
		}
	})
	e.run()

	e.wantNoError()
	e.wantNumbers(p1, seq(1, 35))
	e.wantNumbers(p2, seq(1, 3))
	want := []string{"acme/w?page=1", "acme/w?page=2", "acme/w?page=3", "acme/w?page=4", "other/r?page=1"}
	if got := e.gh.listed(); !reflect.DeepEqual(got, want) {
		t.Errorf("second run: list requests %v, want %v", got, want)
	}
}

// AC11: without a token nothing is listed or imported and the status refresh
// works as before.
func TestImportNeedsToken(t *testing.T) {
	e := newImportEnv(t, "")
	p := e.project("P", "acme/w")
	e.gh.repo("acme/w", ghIssue{Number: 1}, ghIssue{Number: 3, Title: "A bug"})
	e.ref(p, "acme/w", 3)
	e.linkPull(p)

	e.run()

	if got := e.gh.listed(); len(got) != 0 {
		t.Errorf("no list request may be sent without a token, got %v", got)
	}
	e.wantNumbers(p, []int64{3})
	e.wantNoError()
	if got := e.st.RemoteStatus(store.KindIssue, "acme/w", 3); got.State != "open" || got.Title != "A bug" {
		t.Errorf("status refresh without a token: %+v", got)
	}
	e.wantRefreshRan()
	for _, r := range e.gh.requests() {
		if r.Auth != "" {
			t.Errorf("no Authorization header expected, got %q on %s", r.Auth, r.Path)
		}
	}
}

// AC12: a project without a repository link is skipped silently.
func TestImportSkipsProjectsWithoutRepo(t *testing.T) {
	t.Run("only an unlinked project", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p := e.project("P", "")
		e.gh.repo("acme/w", openIssues(1, 2)...)

		e.run()

		if got := e.gh.requests(); len(got) != 0 {
			t.Errorf("no request expected, got %+v", got)
		}
		e.wantNumbers(p, []int64{})
		e.wantNoError()
	})
	t.Run("beside a linked project", func(t *testing.T) {
		e := newImportEnv(t, "tok")
		p1 := e.project("Unlinked", "")
		p2 := e.project("Linked", "acme/w")
		e.gh.repo("acme/w", openIssues(1, 2)...)

		e.run()

		e.wantNumbers(p1, []int64{})
		e.wantNumbers(p2, []int64{1, 2})
		if got := e.gh.listed(); !reflect.DeepEqual(got, []string{"acme/w?page=1"}) {
			t.Errorf("list requests %v, want one for acme/w", got)
		}
		e.wantNoError()
	})
}

// AC13: the import runs before the status refresh of the same run.
func TestImportRunsBeforeRefresh(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.linkPull(p)
	e.gh.maxPerPage = 1
	e.gh.repo("acme/w", ghIssue{Number: 1, Title: "A bug"}, ghIssue{Number: 2})

	e.run()

	e.wantNumbers(p, []int64{1, 2})
	if got := e.st.RemoteStatus(store.KindIssue, "acme/w", 1); got.State != "open" || got.Title != "A bug" || got.CheckedAt == nil {
		t.Errorf("the new reference has no status after the same run: %+v", got)
	}
	lastList, firstItem := -1, -1
	for i, r := range e.gh.requests() {
		if r.List {
			lastList = i
		} else if firstItem < 0 {
			firstItem = i
		}
	}
	if lastList < 0 || firstItem < 0 || lastList > firstItem {
		t.Errorf("want every list request before the first status request; last list at %d, first status at %d",
			lastList, firstItem)
	}
	e.wantNoError()
}

// AC14: a rejected token or a rate limit during the import ends the run.
func TestImportFatalErrors(t *testing.T) {
	for name, c := range map[string]struct {
		status int
		header map[string]string
		want   error
	}{
		"401":                       {401, nil, ErrBadToken},
		"429":                       {429, nil, ErrRateLimited},
		"403 with no requests left": {403, map[string]string{"X-RateLimit-Remaining": "0"}, ErrRateLimited},
	} {
		t.Run(name, func(t *testing.T) {
			e := newImportEnv(t, "tok")
			p1 := e.project("One", "acme/w")
			p2 := e.project("Two", "other/r")
			e.linkPull(p1)
			r := e.gh.repo("acme/w", openIssues(1, 2)...)
			r.status, r.header = c.status, c.header
			e.gh.repo("other/r", openIssues(1, 2)...)

			e.run()

			if le := e.lastErr(); !strings.Contains(le, c.want.Error()) {
				t.Errorf("last_error %q, want %q", le, c.want.Error())
			}
			if got := e.gh.listed(); !reflect.DeepEqual(got, []string{"acme/w?page=1"}) {
				t.Errorf("list requests %v: the run must end at the first one", got)
			}
			if got := e.gh.items(); len(got) != 0 {
				t.Errorf("no status refresh request may be sent, got %+v", got)
			}
			e.wantNumbers(p1, []int64{})
			e.wantNumbers(p2, []int64{})
		})
	}
}

// AC14: references created before the fatal error stay, without a status.
func TestImportFatalErrorKeepsCreatedReferences(t *testing.T) {
	e := newImportEnv(t, "tok")
	p1 := e.project("One", "acme/w")
	p2 := e.project("Two", "other/r")
	e.linkPull(p1)
	e.gh.repo("acme/w", openIssues(1, 2)...)
	e.gh.repo("other/r", openIssues(1, 2)...).status = 401

	e.run()

	e.wantNumbers(p1, []int64{1, 2})
	e.wantNumbers(p2, []int64{})
	if le := e.lastErr(); !strings.Contains(le, ErrBadToken.Error()) {
		t.Errorf("last_error %q, want %q", le, ErrBadToken.Error())
	}
	if got := e.gh.items(); len(got) != 0 {
		t.Errorf("no status refresh request may be sent, got %+v", got)
	}
	if got := e.st.RemoteStatus(store.KindIssue, "acme/w", 1); got.State != "unknown" {
		t.Errorf("issue 1 was not refreshed in this run and must be unknown: %+v", got)
	}
}

// AC15: a repository that cannot be listed is an error naming the repository
// and its lowest project; the other repositories and the refresh go on.
func TestImportNonFatalListErrors(t *testing.T) {
	for name, c := range map[string]struct {
		status int
		body   string
	}{
		"404":             {status: 404},
		"403 not a limit": {status: 403},
		"410":             {status: 410},
		"500":             {status: 500},
		"unreadable body": {body: "<html>this is not JSON</html>"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newImportEnv(t, "tok")
			p1 := e.project("One", "broken/repo")
			p2 := e.project("Two", "broken/repo")
			p3 := e.project("Three", "acme/w")
			e.linkPull(p1)
			r := e.gh.repo("broken/repo", openIssues(1, 2)...)
			r.status, r.body = c.status, c.body
			e.gh.repo("acme/w", openIssues(1, 2)...)

			e.run()

			e.wantErrorNames("broken/repo", p1)
			e.wantNumbers(p1, []int64{})
			e.wantNumbers(p2, []int64{})
			e.wantNumbers(p3, []int64{1, 2})
			e.wantRefreshRan()
			if got := e.st.RemoteStatus(store.KindIssue, "acme/w", 1); got.State != "open" {
				t.Errorf("the imported issue must be refreshed in the same run: %+v", got)
			}
		})
	}
}

// AC15: a later page that fails keeps the earlier pages' references.
func TestImportPageFailureKeepsEarlierPages(t *testing.T) {
	e := newImportEnv(t, "tok")
	p1 := e.project("One", "acme/w")
	p2 := e.project("Two", "other/r")
	e.linkPull(p1)
	e.gh.maxPerPage = 2
	r := e.gh.repo("acme/w", openIssues(1, 5)...)
	r.status, r.failPage = 500, 2
	e.gh.repo("other/r", ghIssue{Number: 1})

	e.run()

	e.wantNumbers(p1, []int64{1, 2})
	e.wantErrorNames("acme/w", p1)
	e.wantNumbers(p2, []int64{1})
	e.wantRefreshRan()
}

// AC15: a rel="next" link to another host is not followed (the token must not
// leave the configured API host); it is a non-fatal error for the repository.
func TestImportDoesNotFollowForeignNextLink(t *testing.T) {
	var foreignHits atomic.Int64
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		foreignHits.Add(1)
		w.Write([]byte(`[{"number":77,"title":"from another host","state":"open"}]`))
	}))
	defer foreign.Close()
	fu, err := url.Parse(foreign.URL)
	if err != nil {
		t.Fatal(err)
	}
	e := newImportEnv(t, "tok")
	p1 := e.project("One", "acme/w")
	p2 := e.project("Two", "other/r")
	e.linkPull(p1)
	e.gh.maxPerPage = 2
	// Another host name and another port than Client.BaseURL (127.0.0.1).
	e.gh.repo("acme/w", openIssues(1, 4)...).nextLink = "http://localhost:" + fu.Port() + "/repos/acme/w/issues?page=2"
	e.gh.repo("other/r", ghIssue{Number: 1})

	e.run()

	if n := foreignHits.Load(); n != 0 {
		t.Errorf("the foreign host got %d request(s)", n)
	}
	e.wantErrorNames("acme/w", p1)
	e.wantNumbers(p1, []int64{1, 2})
	e.wantNumbers(p2, []int64{1})
	e.wantRefreshRan()
}

// AC15: a failing insert of one issue does not stop the others.
func TestImportCreateFailureContinues(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.linkPull(p)
	e.gh.repo("acme/w", openIssues(1, 3)...)
	if _, err := e.st.DB.Exec(`CREATE TRIGGER story87_fail_issue_2 BEFORE INSERT ON issues
		WHEN NEW.number = 2 BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`); err != nil {
		t.Fatal(err)
	}

	e.run()

	e.wantNumbers(p, []int64{1, 3})
	e.wantErrorNames("acme/w", p)
	e.wantRefreshRan()
}

// A list entry without a usable number is skipped silently (user decision).
func TestImportSkipsEntriesWithoutNumber(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.gh.repo("acme/w",
		ghIssue{Number: 1},
		ghIssue{Number: 2, NumberMode: "omit"},
		ghIssue{Number: 3, NumberMode: "zero"},
		ghIssue{Number: 4})

	e.run()

	e.wantNumbers(p, []int64{1, 4})
	e.wantNoError()
}

// AC16: last_error is the first error of the run across import and refresh,
// and a clean run clears it.
func TestImportLastErrorIsFirstOfRun(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "broken/repo")
	e.linkPull(p)
	e.gh.repo("broken/repo").status = 404
	e.gh.edit(func() { e.gh.itemStatus = 500 })

	e.run() // the import fails first, then the refresh of the linked pull request

	e.wantErrorNames("broken/repo", p)
	e.wantRefreshRan()
	if le := e.lastErr(); strings.Contains(le, "acme/linked") {
		t.Errorf("a later refresh error replaced the import error: %q", le)
	}

	e.gh.edit(func() { e.gh.repos["broken/repo"].status = 0 })
	e.run() // only the refresh fails now
	if le := e.lastErr(); !strings.Contains(le, "acme/linked#99") || !strings.Contains(le, "GitHub answered 500") {
		t.Errorf("last_error %q, want the refresh error of acme/linked#99", le)
	}
	if len(e.gh.lists()) == 0 {
		t.Error("the repository was never listed")
	}

	e.gh.edit(func() { e.gh.itemStatus = 0 })
	e.run()
	e.wantNoError()
}

// AC17: a cancelled run stops importing: no further request, no further
// reference.
func TestImportHonoursCancellation(t *testing.T) {
	e := newImportEnv(t, "tok")
	p1 := e.project("One", "acme/w")
	p2 := e.project("Two", "other/r")
	e.linkPull(p1)
	e.gh.maxPerPage = 2
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.gh.repo("acme/w", openIssues(1, 6)...).onList = func(page int, r *http.Request) {
		if page == 2 {
			cancel()
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
		}
	}
	e.gh.repo("other/r", ghIssue{Number: 1})

	e.runCtx(ctx)

	if got, want := e.gh.listed(), []string{"acme/w?page=1", "acme/w?page=2"}; !reflect.DeepEqual(got, want) {
		t.Errorf("list requests %v, want %v (nothing after the cancellation)", got, want)
	}
	if got := e.gh.items(); len(got) != 0 {
		t.Errorf("no request may follow the cancellation, got %+v", got)
	}
	for _, n := range e.numbers(p1) {
		if n > 2 {
			t.Errorf("issue %d was created after the cancellation", n)
		}
	}
	e.wantNumbers(p2, []int64{})
}

// Story 88 AC14 (was story 87's AC18): the only non-GET request of a full run
// is the assignment POST; lists, pages and the status refresh stay GET.
func TestImportOnlyAssignmentWrites(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.project("Q", "broken/repo")
	e.linkPull(p)
	e.gh.maxPerPage = 2
	e.gh.repo("acme/w", openIssues(1, 5)...)
	e.gh.repo("broken/repo").status = 404

	e.run()
	e.run()

	if len(e.gh.lists()) < 4 || len(e.gh.items()) < 6 {
		t.Errorf("expected list and status requests, got %d and %d", len(e.gh.lists()), len(e.gh.items()))
	}
	posts := 0
	for _, r := range e.gh.requests() {
		switch {
		case r.Method == http.MethodGet:
		case r.Method == http.MethodPost && r.Assign:
			posts++
		default:
			t.Errorf("%s %s: only GET and the assignment POST are allowed", r.Method, r.Path)
		}
	}
	if posts != 5 {
		t.Errorf("want 5 assignment POSTs (one per imported issue), got %d", posts)
	}
	for _, r := range e.gh.items() {
		if r.Method != http.MethodGet {
			t.Errorf("status refresh %s %s must be GET", r.Method, r.Path)
		}
	}
	e.wantNumbers(p, seq(1, 5))
}

// AC19: no clean-up when an issue stops matching; a deleted reference of a
// still matching issue comes back.
func TestImportNoCleanupAndRecreate(t *testing.T) {
	e := newImportEnv(t, "tok")
	p := e.project("P", "acme/w")
	e.gh.repo("acme/w", openIssues(1, 3)...)
	e.run()
	e.wantNumbers(p, []int64{1, 2, 3})
	byNumber := func() map[int64]store.Issue {
		out := map[int64]store.Issue{}
		for _, i := range e.refs(p) {
			c := *i
			c.Remote, c.Warnings = store.RemoteStatus{}, nil
			out[i.Number] = c
		}
		return out
	}
	before := byNumber()

	e.gh.edit(func() {
		r := e.gh.repos["acme/w"]
		r.issues[0].State = "closed"
		r.issues[1].Assignee = "bob"
		// Story 88: run one assigned all three; issue 3 is unassigned again
		// (someone un-assigned it), so it still matches.
		r.issues[2].Assignee = ""
	})
	if err := e.st.DeleteIssue(before[3].ID); err != nil {
		t.Fatal(err)
	}
	e.run()

	e.wantNumbers(p, []int64{1, 2, 3})
	after := byNumber()
	for _, n := range []int64{1, 2} {
		if !reflect.DeepEqual(after[n], before[n]) {
			t.Errorf("issue %d no longer matches on GitHub but must stay unchanged: %+v -> %+v", n, before[n], after[n])
		}
	}
	// (SQLite may reuse the row id, so only its presence is checked.)
	if after[3].ID == 0 || after[3].Title != "Issue 3" {
		t.Errorf("the deleted reference of issue 3 must be created again: %+v", after[3])
	}
	e.wantNoError()
}

// Story 89: the first list request of each linked repository asks GitHub for
// exactly open, unassigned issues, oldest first by creation, 100 per page. Only
// that request is built by the import; later pages follow the Link header.
func TestImportListQuery(t *testing.T) {
	e := newImportEnv(t, "tok")
	e.project("A1", "acme/a")
	e.project("B", "acme/b")
	e.project("A2", "acme/a") // a second link to acme/a: still one list per run
	e.gh.maxPerPage = 2       // acme/a has follow-up pages, which are not checked
	e.gh.repo("acme/a", openIssues(1, 5)...)
	e.gh.repo("acme/b", openIssues(1, 1)...)

	e.run()

	want := url.Values{
		"state":     {"open"},
		"assignee":  {"none"},
		"sort":      {"created"},
		"direction": {"asc"},
		"per_page":  {"100"},
	}
	first := map[string]ghReq{}
	for _, r := range e.gh.lists() {
		if _, ok := first[r.Repo]; !ok {
			first[r.Repo] = r
		}
	}
	for _, repo := range []string{"acme/a", "acme/b"} {
		r, ok := first[repo]
		if !ok {
			t.Errorf("%s: no list request reached GitHub", repo)
			continue
		}
		got, err := url.ParseQuery(r.Query)
		if err != nil {
			t.Errorf("%s: unreadable query %q: %v", repo, r.Query, err)
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: first list request has query %v, want exactly %v", repo, got, want)
		}
	}
	e.wantNoError()
}
