package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dright/dprocess/internal/github"
)

func TestRemoteStatusDisabledByDefault(t *testing.T) {
	api, call := setupStories(t)
	call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/w/pull/7"}`)
	call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/w/issues/3","story_id":1}`)

	if code, m := call("GET", "/github-sync", ""); code != 200 || m["enabled"] != false {
		t.Fatalf("sync status: %d %v", code, m)
	}
	prs, _ := httpGetJSONArray(api + "/stories/1/pull-requests")
	rs := prs[0].(map[string]any)["remote_status"].(map[string]any)
	if rs["state"] != "unknown" || rs["checked_at"] != nil {
		t.Errorf("pull request remote_status: %v", rs)
	}
	_, s := call("GET", "/stories/1", "")
	iss := s["issues"].([]any)[0].(map[string]any)["remote_status"].(map[string]any)
	if iss["state"] != "unknown" {
		t.Errorf("issue remote_status: %v", iss)
	}
}

func TestRemoteStatusAfterSync(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/acme/w/pulls/7" {
			w.Write([]byte(`{"title":"Add thing","state":"closed","merged":true}`))
			return
		}
		w.WriteHeader(404) // the issue is not visible
	}))
	defer gh.Close()
	_, st := newTestServer(t)
	syncer := &github.Syncer{Store: st, Client: &github.Client{BaseURL: gh.URL, Token: "x"}}
	srv := httptest.NewServer((&Server{Store: st, GitHub: syncer}).Handler())
	defer srv.Close()
	st.CreateProject("P", "")
	st.CreateEpic(1, "E", "")
	st.CreateStory(1, newStory("a", ""))
	call := func(m, p, b string) (int, map[string]any) {
		r, v := do(t, m, srv.URL+"/api/v1"+p, b)
		return r.StatusCode, v
	}
	call("POST", "/stories/1/pull-requests", `{"github_url":"https://github.com/acme/w/pull/7"}`)
	call("POST", "/projects/1/issues", `{"github_url":"https://github.com/acme/w/issues/3"}`)

	if _, m := call("GET", "/github-sync", ""); m["enabled"] != true || m["last_run_at"] != nil {
		t.Fatalf("before run: %v", m)
	}
	syncer.RunOnce(context.Background())

	prs, _ := httpGetJSONArray(srv.URL + "/api/v1/stories/1/pull-requests")
	rs := prs[0].(map[string]any)["remote_status"].(map[string]any)
	if rs["state"] != "merged" || rs["title"] != "Add thing" || rs["checked_at"] == nil {
		t.Errorf("remote_status: %v", rs)
	}
	// The issue could not be read, so it stays unknown.
	iss, _ := httpGetJSONArray(srv.URL + "/api/v1/projects/1/issues")
	if got := iss[0].(map[string]any)["remote_status"].(map[string]any)["state"]; got != "unknown" {
		t.Errorf("issue state %v", got)
	}
	if _, m := call("GET", "/github-sync", ""); m["last_run_at"] == nil || m["last_error"] != "" {
		t.Errorf("after run: %v", m)
	}
}
