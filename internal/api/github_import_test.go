package api

// Design tests for story 87 at the HTTP surface: the GitHub issue import as
// part of the sync that is turned on by the flag or the API.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"
)

// importGH is a small fake GitHub for the import: the repository acme/w has
// one open, unassigned issue (#5) whose html_url names another repository,
// and the pull request #7 that newSyncEnv links.
type importGH struct {
	*httptest.Server
	mu        sync.Mutex
	log       []string // "list" or "item", in order
	auths     []string // Authorization of the list requests
	methods   []string
	posts     []string // story 88: bodies of the assignment POSTs for #5
	badWrites []string
	block     bool          // hold list requests until their context ends
	arrived   chan struct{} // signalled on each list request
	ctxDone   chan struct{} // signalled when a held request's context ended
}

func newImportGH(t *testing.T) *importGH {
	t.Helper()
	g := &importGH{arrived: make(chan struct{}, 100), ctxDone: make(chan struct{}, 100)}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kind := "item"
		switch {
		case r.URL.Path == "/repos/acme/w/issues":
			kind = "list"
		case r.URL.Path == "/user":
			kind = "user"
		case r.URL.Path == "/repos/acme/w/issues/5/assignees" && r.Method == http.MethodPost:
			kind = "assign"
		}
		var body []byte
		if kind == "assign" {
			body, _ = io.ReadAll(r.Body)
		}
		g.mu.Lock()
		if kind == "assign" {
			g.posts = append(g.posts, string(body))
		} else if r.Method != http.MethodGet {
			g.badWrites = append(g.badWrites, r.Method+" "+r.URL.Path)
		}
		g.log = append(g.log, kind)
		g.methods = append(g.methods, r.Method)
		if kind == "list" {
			g.auths = append(g.auths, r.Header.Get("Authorization"))
		}
		block := g.block
		g.mu.Unlock()
		switch {
		case kind == "list":
			select {
			case g.arrived <- struct{}{}:
			default:
			}
			if block {
				select {
				case <-r.Context().Done():
					g.ctxDone <- struct{}{}
				case <-time.After(10 * time.Second):
				}
				return
			}
			w.Write([]byte(`[{"number":5,"title":"Imported from GitHub","state":"open","assignee":null,"assignees":[],` +
				`"html_url":"https://github.com/Other-Org/Renamed/issues/5"}]`))
		case kind == "user":
			w.Write([]byte(`{"login":"bot"}`))
		case kind == "assign":
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"number":5,"assignees":[{"login":"bot"}]}`))
		case r.URL.Path == "/repos/acme/w/issues/5":
			w.Write([]byte(`{"number":5,"title":"Imported from GitHub","state":"open"}`))
		case r.URL.Path == "/repos/acme/w/pulls/7":
			w.Write([]byte(`{"title":"Add thing","state":"closed","merged":true}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(func() {
		g.Close()
		g.mu.Lock()
		defer g.mu.Unlock()
		for _, m := range g.badWrites {
			t.Errorf("the only write the sync may send is the assignment POST for #5: got %s", m)
		}
	})
	return g
}

func (g *importGH) count(kind string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, k := range g.log {
		if k == kind {
			n++
		}
	}
	return n
}

// newImportSyncEnv is newSyncEnv with project 1 linked to acme/w.
func newImportSyncEnv(t *testing.T, g *importGH, token string) *syncEnv {
	t.Helper()
	e := newSyncEnv(t, &fakeGH{Server: g.Server}, token, time.Hour, nil)
	if code, m := e.call("PATCH", "/projects/1", `{"github_repo_url":"https://github.com/acme/w"}`); code != 200 {
		t.Fatalf("link repository: %d %v", code, m)
	}
	return e
}

func (e *syncEnv) issues(t *testing.T) []map[string]any {
	t.Helper()
	list, err := httpGetJSONArray(e.base + "/projects/1/issues")
	if err != nil {
		t.Fatal(err)
	}
	out := []map[string]any{}
	for _, v := range list {
		out = append(out, v.(map[string]any))
	}
	return out
}

// assertImported checks the one reference the immediate run must have created.
func assertImported(t *testing.T, e *syncEnv, g *importGH) {
	t.Helper()
	e.waitRun(t)
	if _, m := e.call("GET", "/github-sync", ""); m["enabled"] != true || m["last_error"] != "" {
		t.Errorf("status after the run: %v", m)
	}
	iss := e.issues(t)
	if len(iss) != 1 {
		t.Fatalf("want 1 imported issue reference after the first run, got %d: %v", len(iss), iss)
	}
	i := iss[0]
	if i["number"] != float64(5) || i["title"] != "Imported from GitHub" {
		t.Errorf("imported reference: %v", i)
	}
	// The same run refreshed it (import before refresh).
	rs, _ := i["remote_status"].(map[string]any)
	if rs["state"] != "open" || rs["checked_at"] == nil {
		t.Errorf("remote_status after the same run: %v", rs)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.log) == 0 || g.log[0] != "list" {
		t.Errorf("the run must list before it refreshes, requests: %v", g.log)
	}
	if len(g.auths) == 0 || g.auths[0] != "Bearer tok" {
		t.Errorf("the list request must carry the server's token, got %v", g.auths)
	}
}

// AC13: the immediate run after PUT {"enabled": true} imports and refreshes.
func TestImportOnEnableViaPUT(t *testing.T) {
	g := newImportGH(t)
	e := newImportSyncEnv(t, g, "tok")
	if code, m := e.put(true); code != 200 || m["enabled"] != true {
		t.Fatalf("enable: %d %v", code, m)
	}
	assertImported(t, e, g)
}

// Story 88, end to end: the immediate run after PUT {"enabled": true} assigns
// the imported issue to the token owner with exactly one POST.
func TestAssignOnEnableViaPUT(t *testing.T) {
	g := newImportGH(t)
	e := newImportSyncEnv(t, g, "tok")
	e.put(true)
	assertImported(t, e, g)
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.posts) != 1 {
		t.Fatalf("want exactly one assignment POST for #5, got %v", g.posts)
	}
	var b map[string][]string
	if err := json.Unmarshal([]byte(g.posts[0]), &b); err != nil || !reflect.DeepEqual(b["assignees"], []string{"bot"}) || len(b) != 1 {
		t.Errorf("assignment body %q, want {\"assignees\":[\"bot\"]}", g.posts[0])
	}
}

// AC13: the immediate run at startup (--github-sync) imports and refreshes.
func TestImportOnStartGitHub(t *testing.T) {
	g := newImportGH(t)
	e := newImportSyncEnv(t, g, "tok")
	e.api.StartGitHub()
	assertImported(t, e, g)
}

// AC3: the API document of an imported reference; html_url naming another
// repository gives no repo_mismatch warning.
func TestImportedIssueHasNoRepoMismatch(t *testing.T) {
	g := newImportGH(t)
	e := newImportSyncEnv(t, g, "tok")
	e.put(true)
	e.waitRun(t)
	iss := e.issues(t)
	if len(iss) != 1 {
		t.Fatalf("want 1 imported issue reference, got %d: %v", len(iss), iss)
	}
	i := iss[0]
	if i["github_repo"] != "acme/w" || i["github_url"] != "https://github.com/acme/w/issues/5" {
		t.Errorf("repo %v url %v: want the project's repository", i["github_repo"], i["github_url"])
	}
	if i["kind"] != "" || i["story_id"] != nil || i["project_id"] != float64(1) {
		t.Errorf("kind %q story_id %v project_id %v", i["kind"], i["story_id"], i["project_id"])
	}
	if w, ok := i["warnings"].([]any); !ok || len(w) != 0 {
		t.Errorf("warnings %v, want []", i["warnings"])
	}
	// No story or epic was created (newSyncEnv made one of each).
	if stories, _ := httpGetJSONArray(e.base + "/projects/1/stories"); len(stories) != 1 {
		t.Errorf("stories: %d, want 1", len(stories))
	}
	if epics, _ := httpGetJSONArray(e.base + "/projects/1/epics"); len(epics) != 1 {
		t.Errorf("epics: %d, want 1", len(epics))
	}
}

// AC11: without DPROCESS_GITHUB_TOKEN nothing is listed or imported and the
// status sync works as before.
func TestImportSkippedWithoutTokenViaAPI(t *testing.T) {
	g := newImportGH(t)
	e := newImportSyncEnv(t, g, "")
	e.put(true)
	e.waitRun(t)
	if n := g.count("list"); n != 0 {
		t.Errorf("%d list request(s) without a token", n)
	}
	if iss := e.issues(t); len(iss) != 0 {
		t.Errorf("nothing may be imported without a token: %v", iss)
	}
	if _, m := e.call("GET", "/github-sync", ""); m["last_error"] != "" {
		t.Errorf("last_error %q, want empty", m["last_error"])
	}
	prs, _ := httpGetJSONArray(e.base + "/stories/1/pull-requests")
	if len(prs) != 1 || prs[0].(map[string]any)["remote_status"].(map[string]any)["state"] != "merged" {
		t.Errorf("the status refresh must still work: %v", prs)
	}
}

// AC17: turning the sync off cancels an import in flight.
func TestDisableCancelsImportInFlight(t *testing.T) {
	g := newImportGH(t)
	g.block = true
	e := newImportSyncEnv(t, g, "tok")
	e.put(true)
	select {
	case <-g.arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the import did not list the linked repository")
	}
	code, m := e.put(false)
	if code != 200 {
		t.Fatalf("disable: %d", code)
	}
	e.assertDisabled(t, m)
	select {
	case <-g.ctxDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the list request in flight was not cancelled")
	}
	time.Sleep(150 * time.Millisecond)
	if n := g.count("list"); n != 1 {
		t.Errorf("%d list requests, want only the cancelled one", n)
	}
	if n := g.count("item"); n != 0 {
		t.Errorf("%d request(s) after the cancellation", n)
	}
	if iss := e.issues(t); len(iss) != 0 {
		t.Errorf("a cancelled import created references: %v", iss)
	}
	_, m = e.call("GET", "/github-sync", "")
	e.assertDisabled(t, m)
}

// AC21: the status document keeps exactly its three fields after an import.
func TestGitHubSyncDocumentKeysUnchanged(t *testing.T) {
	g := newImportGH(t)
	e := newImportSyncEnv(t, g, "tok")
	_, put := e.put(true)
	e.waitRun(t)
	if iss := e.issues(t); len(iss) != 1 {
		t.Fatalf("want 1 imported issue reference, got %d", len(iss))
	}
	_, get := e.call("GET", "/github-sync", "")
	want := []string{"enabled", "last_error", "last_run_at"}
	for name, doc := range map[string]map[string]any{"PUT": put, "GET": get} {
		keys := []string{}
		for k := range doc {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if !reflect.DeepEqual(keys, want) {
			t.Errorf("%s document has fields %v, want %v", name, keys, want)
		}
	}
}
