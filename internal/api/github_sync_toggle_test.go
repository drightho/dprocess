package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dright/dprocess/internal/github"
	"github.com/dright/dprocess/internal/store"
)

// fakeGH is a fake GitHub API that counts requests.
type fakeGH struct {
	*httptest.Server
	hits    atomic.Int64
	mu      sync.Mutex
	auths   []string
	status  int           // 0 = 200 with a merged PR
	arrived chan struct{} // if set, signalled on each request
	block   bool          // hold requests until their context ends
	ctxDone chan struct{} // closed-by-send when a blocked request's context ended
}

func newFakeGH(t *testing.T) *fakeGH {
	f := &fakeGH{arrived: make(chan struct{}, 100), ctxDone: make(chan struct{}, 100)}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		f.mu.Lock()
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		block, status := f.block, f.status
		f.mu.Unlock()
		select {
		case f.arrived <- struct{}{}:
		default:
		}
		if block {
			select {
			case <-r.Context().Done():
				f.ctxDone <- struct{}{}
			case <-time.After(10 * time.Second):
			}
			return
		}
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		w.Write([]byte(`{"title":"Add thing","state":"closed","merged":true}`))
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeGH) setBlock(b bool) { f.mu.Lock(); f.block = b; f.mu.Unlock() }

type syncEnv struct {
	api  *Server
	st   *store.Store
	base string
	call func(method, path, body string) (int, map[string]any)
}

// newSyncEnv builds a server with sync off, configured for on-demand enabling.
func newSyncEnv(t *testing.T, gh *fakeGH, token string, interval time.Duration, ctx context.Context) *syncEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	api := &Server{Store: st, GitHubToken: token, GitHubAPI: gh.URL, GitHubInterval: interval, Ctx: ctx}
	srv := httptest.NewServer(api.Handler())
	t.Cleanup(func() { srv.Close(); api.Close(); st.Close() })
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")
	st.CreateStory(1, newStory("a", ""))
	e := &syncEnv{api: api, st: st, base: srv.URL + "/api/v1"}
	e.call = func(m, p, b string) (int, map[string]any) {
		r, v := do(t, m, e.base+p, b)
		return r.StatusCode, v
	}
	e.call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/w/pull/7"}`)
	return e
}

func (e *syncEnv) put(enabled bool) (int, map[string]any) {
	body := `{"enabled":false}`
	if enabled {
		body = `{"enabled":true}`
	}
	return e.call("PUT", "/github-sync", body)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (e *syncEnv) waitRun(t *testing.T) {
	waitFor(t, "last_run_at", func() bool {
		_, m := e.call("GET", "/github-sync", "")
		return m["last_run_at"] != nil
	})
}

func (e *syncEnv) assertDisabled(t *testing.T, m map[string]any) {
	t.Helper()
	if m["enabled"] != false || m["last_run_at"] != nil || m["last_error"] != "" {
		t.Errorf("want disabled document, got %v", m)
	}
}

func TestToggleEnableWhenStartedWithSyncOff(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	_, m := e.call("GET", "/github-sync", "")
	e.assertDisabled(t, m)

	code, m := e.put(true)
	if code != 200 || m["enabled"] != true {
		t.Fatalf("enable: %d %v", code, m)
	}
	if _, ok := m["last_run_at"]; !ok {
		t.Errorf("response is not the status document: %v", m)
	}
	e.waitRun(t)
	_, m = e.call("GET", "/github-sync", "")
	if m["enabled"] != true || m["last_error"] != "" {
		t.Errorf("GET after enable: %v", m)
	}
	// The immediate sync stored the remote status.
	waitFor(t, "remote status", func() bool {
		prs, _ := httpGetJSONArray(e.base + "/stories/1/pull-requests")
		return len(prs) == 1 && prs[0].(map[string]any)["remote_status"].(map[string]any)["state"] == "merged"
	})
	if gh.auths[0] != "" {
		t.Errorf("empty token must send no Authorization header, got %q", gh.auths[0])
	}
}

func TestToggleBothWays(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	if code, m := e.put(true); code != 200 || m["enabled"] != true {
		t.Fatalf("enable: %d %v", code, m)
	}
	e.waitRun(t)
	code, m := e.put(false)
	if code != 200 {
		t.Fatalf("disable: %d %v", code, m)
	}
	e.assertDisabled(t, m)
	_, m = e.call("GET", "/github-sync", "")
	e.assertDisabled(t, m)
}

func TestToggleEnableUsesTokenAndNeverReturnsIt(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "s3cret-token", time.Hour, nil)
	r1, _ := e.put(true)
	if r1 != 200 {
		t.Fatalf("enable: %d", r1)
	}
	e.waitRun(t)
	if gh.auths[0] != "Bearer s3cret-token" {
		t.Errorf("Authorization = %q", gh.auths[0])
	}
	// Raw bodies must not contain the token.
	for _, method := range []string{"GET", "PUT"} {
		body := `{"enabled":true}`
		if method == "GET" {
			body = ""
		}
		rq, _ := http.NewRequest(method, e.base+"/github-sync", strings.NewReader(body))
		resp, err := http.DefaultClient.Do(rq)
		if err != nil {
			t.Fatal(err)
		}
		buf := new(strings.Builder)
		b := make([]byte, 4096)
		n, _ := resp.Body.Read(b)
		buf.Write(b[:n])
		resp.Body.Close()
		if strings.Contains(buf.String(), "s3cret") {
			t.Errorf("%s response leaks the token: %s", method, buf.String())
		}
	}
	// A token in the request is refused.
	if code, _ := e.call("PUT", "/github-sync", `{"enabled":true,"token":"x"}`); code != 400 {
		t.Errorf("token field: want 400, got %d", code)
	}
}

func TestToggleRepeatIsNoOp(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	e.put(true)
	e.waitRun(t)
	hits := gh.hits.Load()
	_, before := e.call("GET", "/github-sync", "")
	for i := 0; i < 3; i++ {
		code, m := e.put(true)
		if code != 200 || m["enabled"] != true {
			t.Fatalf("repeat enable: %d %v", code, m)
		}
		if m["last_run_at"] != before["last_run_at"] {
			t.Errorf("repeat enable changed last_run_at: %v -> %v", before["last_run_at"], m["last_run_at"])
		}
	}
	time.Sleep(200 * time.Millisecond)
	if gh.hits.Load() != hits {
		t.Errorf("repeated enable ran another sync: %d -> %d requests", hits, gh.hits.Load())
	}

	// Disabling twice.
	e.put(false)
	for i := 0; i < 2; i++ {
		code, m := e.put(false)
		if code != 200 {
			t.Fatalf("repeat disable: %d", code)
		}
		e.assertDisabled(t, m)
	}
}

func TestToggleDisableWhenNeverEnabled(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	code, m := e.put(false)
	if code != 200 {
		t.Fatalf("disable: %d", code)
	}
	e.assertDisabled(t, m)
	if gh.hits.Load() != 0 {
		t.Errorf("no request expected, got %d", gh.hits.Load())
	}
}

func TestToggleBadBody(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	cases := []struct {
		name, body string
		want       int
	}{
		{"empty body", ``, 400},
		{"malformed json", `{"enabled":`, 400},
		{"not json", `enable`, 400},
		{"unknown field", `{"enabled":true,"interval":"1s"}`, 400},
		{"wrong type string", `{"enabled":"yes"}`, 400},
		{"wrong type number", `{"enabled":1}`, 400},
		{"missing enabled", `{}`, 422},
		{"null enabled", `{"enabled":null}`, 422},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp, m := do(t, "PUT", e.base+"/github-sync", c.body)
			if resp.StatusCode != c.want {
				t.Fatalf("status %d, want %d (%v)", resp.StatusCode, c.want, m)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/problem+json") {
				t.Errorf("content type %q", ct)
			}
			if m["title"] == nil || m["detail"] == nil || int(m["status"].(float64)) != c.want {
				t.Errorf("not a problem document: %v", m)
			}
		})
	}
	// None of the refused bodies changed the state.
	_, m := e.call("GET", "/github-sync", "")
	e.assertDisabled(t, m)
	if gh.hits.Load() != 0 {
		t.Errorf("refused bodies started a sync")
	}
}

func TestToggleBadBodyKeepsEnabledState(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	e.put(true)
	e.waitRun(t)
	e.call("PUT", "/github-sync", `{}`)
	if _, m := e.call("GET", "/github-sync", ""); m["enabled"] != true {
		t.Errorf("422 changed state: %v", m)
	}
}

func TestToggleDisableCancelsInFlightRunAndKeepsCache(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	// First a normal run so a cached status exists.
	e.put(true)
	e.waitRun(t)
	e.put(false)
	// Re-enable with a hanging GitHub, then disable while the run is in flight.
	gh.setBlock(true)
	for len(gh.arrived) > 0 {
		<-gh.arrived
	}
	e.put(true)
	select {
	case <-gh.arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("sync did not start")
	}
	code, m := e.put(false)
	if code != 200 {
		t.Fatalf("disable: %d", code)
	}
	e.assertDisabled(t, m)
	select {
	case <-gh.ctxDone:
	case <-time.After(5 * time.Second):
		t.Fatal("in-flight request was not cancelled")
	}
	// The cancelled run must never show up later.
	time.Sleep(300 * time.Millisecond)
	_, m = e.call("GET", "/github-sync", "")
	e.assertDisabled(t, m)
	// The cached remote_status survives.
	prs, _ := httpGetJSONArray(e.base + "/stories/1/pull-requests")
	rs := prs[0].(map[string]any)["remote_status"].(map[string]any)
	if rs["state"] != "merged" || rs["checked_at"] == nil {
		t.Errorf("cached status lost: %v", rs)
	}
}

func TestToggleReEnableStartsFresh(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	e.put(true)
	e.waitRun(t)
	e.put(false)
	gh.setBlock(true)
	code, m := e.put(true)
	if code != 200 || m["enabled"] != true || m["last_run_at"] != nil || m["last_error"] != "" {
		t.Fatalf("re-enable: %d %v", code, m)
	}
	select {
	case <-gh.arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("re-enable did not run a sync immediately")
	}
	_, m = e.call("GET", "/github-sync", "")
	if m["enabled"] != true || m["last_run_at"] != nil {
		t.Errorf("before the new run completes: %v", m)
	}
	e.put(false)
}

func TestToggleFailingSyncReportsLastError(t *testing.T) {
	gh := newFakeGH(t)
	gh.status = 401
	e := newSyncEnv(t, gh, "bad", time.Hour, nil)
	code, m := e.put(true)
	if code != 200 || m["enabled"] != true {
		t.Fatalf("enable: %d %v", code, m)
	}
	e.waitRun(t)
	_, m = e.call("GET", "/github-sync", "")
	if m["last_error"] == "" || m["last_error"] == nil {
		t.Errorf("want last_error, got %v", m)
	}
}

func TestToggleInjectedSyncerCountsAsEnabled(t *testing.T) {
	gh := newFakeGH(t)
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	syncer := &github.Syncer{Store: st, Client: &github.Client{BaseURL: gh.URL}, Interval: time.Hour}
	api := &Server{Store: st, GitHub: syncer}
	srv := httptest.NewServer(api.Handler())
	t.Cleanup(func() { srv.Close(); api.Close(); st.Close() })
	_, m := do(t, "PUT", srv.URL+"/api/v1/github-sync", `{"enabled":true}`)
	if m["enabled"] != true {
		t.Errorf("repeat on injected syncer: %v", m)
	}
	_, m = do(t, "PUT", srv.URL+"/api/v1/github-sync", `{"enabled":false}`)
	if m["enabled"] != false || m["last_run_at"] != nil {
		t.Errorf("disable injected syncer: %v", m)
	}
	if api.GitHubSyncer() != nil {
		t.Errorf("GitHubSyncer() should be nil when disabled")
	}
	_, m = do(t, "GET", srv.URL+"/api/v1/github-sync", "")
	if m["enabled"] != false {
		t.Errorf("GET: %v", m)
	}
}

func TestToggleShutdownStopsLoop(t *testing.T) {
	gh := newFakeGH(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e := newSyncEnv(t, gh, "", 20*time.Millisecond, ctx)
	e.put(true)
	// The loop repeats at the configured interval.
	waitFor(t, "repeated syncs", func() bool { return gh.hits.Load() >= 3 })
	cancel()
	done := make(chan struct{})
	go func() { e.api.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not return")
	}
	time.Sleep(50 * time.Millisecond)
	n := gh.hits.Load()
	time.Sleep(250 * time.Millisecond)
	if gh.hits.Load() != n {
		t.Errorf("loop kept running after shutdown: %d -> %d", n, gh.hits.Load())
	}
}

func TestToggleCloseStopsLoopWithoutCancellingCtx(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", 20*time.Millisecond, nil)
	e.put(true)
	waitFor(t, "syncs", func() bool { return gh.hits.Load() >= 2 })
	e.api.Close()
	e.api.Close() // idempotent
	n := gh.hits.Load()
	time.Sleep(250 * time.Millisecond)
	if gh.hits.Load() != n {
		t.Errorf("loop kept running after Close: %d -> %d", n, gh.hits.Load())
	}
}

func TestToggleCloseWithNothingStarted(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", time.Hour, nil)
	e.api.Close()
	e.api.Close()
}

func TestToggleConcurrentRequests(t *testing.T) {
	gh := newFakeGH(t)
	e := newSyncEnv(t, gh, "", 5*time.Millisecond, nil)
	var wg sync.WaitGroup
	for g := 0; g < 6; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				var code int
				if g%3 == 2 {
					code, _ = e.call("GET", "/github-sync", "")
				} else {
					code, _ = e.put((i+g)%2 == 0)
				}
				if code != 200 {
					t.Errorf("status %d", code)
					return
				}
			}
		}(g)
	}
	wg.Wait()
}
