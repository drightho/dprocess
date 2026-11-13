package github

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

	"github.com/dright/dprocess/internal/store"
)

func testStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")
	st.CreateStory(1, store.NewStory{Name: "s"})
	return st
}

func link(t *testing.T, st *store.Store) {
	t.Helper()
	if _, err := st.AddPullRequest(1, "https://github.com/acme/w/pull/7", "acme/w", 7); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateIssue(1, store.NewIssue{URL: "https://github.com/acme/w/issues/3", Repo: "acme/w", Number: 3}); err != nil {
		t.Fatal(err)
	}
}

func TestSyncCachesStatusReadOnly(t *testing.T) {
	var methods, auth atomic.Value // every method seen / the last Authorization
	var mu sync.Mutex
	var all []string
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods.Store(r.Method)
		mu.Lock()
		all = append(all, r.Method+" "+r.URL.Path)
		mu.Unlock()
		auth.Store(r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/repos/acme/w/pulls/7":
			w.Write([]byte(`{"title":"Add thing","state":"closed","merged":true}`))
		case "/repos/acme/w/issues/3":
			w.Write([]byte(`{"title":"A bug","state":"open"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer gh.Close()
	st := testStore(t)
	link(t, st)
	y := &Syncer{Store: st, Client: &Client{BaseURL: gh.URL, Token: "tok"}}

	y.RunOnce(context.Background())

	if got := st.RemoteStatus(store.KindPull, "acme/w", 7); got.State != "merged" || got.Title != "Add thing" {
		t.Errorf("pull: %+v", got)
	}
	if got := st.RemoteStatus(store.KindIssue, "acme/w", 3); got.State != "open" || got.Title != "A bug" {
		t.Errorf("issue: %+v", got)
	}
	// Story 88: the status refresh stays read-only (the project here links no
	// repository, so no import and no assignment runs).
	mu.Lock()
	for _, m := range all {
		if !strings.HasPrefix(m, "GET ") {
			t.Errorf("the status refresh must only GET, saw %q", m)
		}
	}
	if len(all) == 0 {
		t.Error("no request seen")
	}
	mu.Unlock()
	if auth.Load() != "Bearer tok" {
		t.Errorf("auth %v", auth.Load())
	}
	if s := y.Status(); !s.Enabled || s.LastRunAt == nil || s.LastError != "" {
		t.Errorf("status: %+v", s)
	}
}

func TestSyncDegradesGracefully(t *testing.T) {
	for name, c := range map[string]struct {
		code    int
		wantErr string
	}{
		"invalid token": {401, ErrBadToken.Error()},
		"rate limited":  {429, ErrRateLimited.Error()},
		"server error":  {500, "GitHub answered 500"},
	} {
		t.Run(name, func(t *testing.T) {
			gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(c.code) }))
			defer gh.Close()
			st := testStore(t)
			link(t, st)
			y := &Syncer{Store: st, Client: &Client{BaseURL: gh.URL, Token: "bad"}}
			y.RunOnce(context.Background()) // must not panic or block
			if got := st.RemoteStatus(store.KindPull, "acme/w", 7).State; got != "unknown" {
				t.Errorf("state %q, want unknown", got)
			}
			if e := y.Status().LastError; !strings.Contains(e, c.wantErr) {
				t.Errorf("last error %q, want %q", e, c.wantErr)
			}
		})
	}
	// Unreachable GitHub.
	st := testStore(t)
	link(t, st)
	y := &Syncer{Store: st, Client: &Client{BaseURL: "http://127.0.0.1:1"}}
	y.RunOnce(context.Background())
	if y.Status().LastError == "" {
		t.Error("an unreachable GitHub must be reported")
	}
}

func TestNotFoundForgetsAndStaleIsUnknown(t *testing.T) {
	st := testStore(t)
	link(t, st)
	it := store.RemoteItem{Kind: store.KindPull, Repo: "acme/w", Number: 7}
	st.SetRemoteStatus(it, "t", "open", time.Now())
	if st.RemoteStatus(store.KindPull, "acme/w", 7).State != "open" {
		t.Fatal("fresh status should be open")
	}
	st.SetRemoteStatus(it, "t", "open", time.Now().Add(-store.RemoteMaxAge-time.Minute))
	if got := st.RemoteStatus(store.KindPull, "acme/w", 7); got.State != "unknown" || got.CheckedAt == nil {
		t.Errorf("stale: %+v", got)
	}
	gh := httptest.NewServer(http.NotFoundHandler())
	defer gh.Close()
	(&Syncer{Store: st, Client: &Client{BaseURL: gh.URL}}).RunOnce(context.Background())
	if got := st.RemoteStatus(store.KindPull, "acme/w", 7); got.CheckedAt != nil {
		t.Errorf("a vanished item must be forgotten: %+v", got)
	}
}

func TestDisabledSyncerStatus(t *testing.T) {
	var y *Syncer
	if y.Status().Enabled {
		t.Error("nil syncer must report disabled")
	}
}
