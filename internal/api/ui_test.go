package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/dright/dprocess/internal/store"
)

func newUIServer(t *testing.T, ui fstest.MapFS) *httptest.Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "ui.db"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer((&Server{Store: st, UI: ui}).Handler())
	t.Cleanup(func() { srv.Close(); st.Close() })
	return srv
}

func get(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestUIServing(t *testing.T) {
	srv := newUIServer(t, fstest.MapFS{
		"index.html":    {Data: []byte("<html>app</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
		".gitkeep":      {Data: nil},
	})

	for _, p := range []string{"/", "/projects/1", "/some/deep/route"} {
		resp, body := get(t, srv.URL+p)
		if resp.StatusCode != 200 || !strings.Contains(body, "app") || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
			t.Errorf("%s: %d %q %s", p, resp.StatusCode, body, resp.Header.Get("Content-Type"))
		}
	}
	resp, body := get(t, srv.URL+"/assets/app.js")
	if resp.StatusCode != 200 || body != "console.log(1)" || !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("asset: %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if resp, _ := get(t, srv.URL+"/assets/missing.js"); resp.StatusCode != 404 {
		t.Errorf("missing asset: %d", resp.StatusCode)
	}

	// API stays JSON: real endpoints work, unknown ones are JSON 404s.
	if resp, _ := get(t, srv.URL+"/api/v1/health"); resp.StatusCode != 200 {
		t.Errorf("health: %d", resp.StatusCode)
	}
	resp, body = get(t, srv.URL+"/api/v1/nope")
	if resp.StatusCode != 404 || resp.Header.Get("Content-Type") != "application/problem+json" || strings.Contains(body, "<html>") {
		t.Errorf("unknown api path: %d %s %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	resp, body = get(t, srv.URL+"/api/v1/openapi.yaml")
	if resp.StatusCode != 200 || !strings.HasPrefix(body, "openapi: 3.0.3") {
		t.Errorf("spec: %d %.40q", resp.StatusCode, body)
	}

	req, _ := http.NewRequest("POST", srv.URL+"/", nil)
	if r, err := http.DefaultClient.Do(req); err != nil || r.StatusCode != 405 {
		t.Errorf("POST /: %v %v", r, err)
	}
}

func TestUINotBuilt(t *testing.T) {
	srv := newUIServer(t, fstest.MapFS{".gitkeep": {Data: nil}})
	resp, body := get(t, srv.URL+"/")
	if resp.StatusCode != 503 || !strings.Contains(body, "make web") {
		t.Errorf("not built: %d %q", resp.StatusCode, body)
	}
	if resp, _ := get(t, srv.URL+"/api/v1/health"); resp.StatusCode != 200 {
		t.Errorf("API must still work: %d", resp.StatusCode)
	}
}
