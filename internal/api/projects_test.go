package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dright/dprocess/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer((&Server{Store: st}).Handler())
	t.Cleanup(func() { srv.Close(); st.Close() })
	return srv, st
}

func do(t *testing.T, method, url, body string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp, m
}

func TestProjectCRUD(t *testing.T) {
	srv, _ := newTestServer(t)
	base := srv.URL + "/api/v1/projects"

	resp, p := do(t, "POST", base, `{"name":"  Alpha ","description":"d"}`)
	if resp.StatusCode != 201 || p["name"] != "Alpha" {
		t.Fatalf("create: %d %v", resp.StatusCode, p)
	}
	url := base + "/1"

	if resp, p = do(t, "GET", url, ""); resp.StatusCode != 200 || p["description"] != "d" {
		t.Fatalf("get: %d %v", resp.StatusCode, p)
	}
	if resp, p = do(t, "PATCH", url, `{"name":"Beta"}`); resp.StatusCode != 200 || p["name"] != "Beta" || p["description"] != "d" {
		t.Fatalf("patch: %d %v", resp.StatusCode, p)
	}

	resp, _ = do(t, "POST", base, `{"name":""}`)
	if resp.StatusCode != 422 {
		t.Fatalf("empty name: %d", resp.StatusCode)
	}
	resp, _ = do(t, "POST", base, `{"bogus":1}`)
	if resp.StatusCode != 400 {
		t.Fatalf("unknown field: %d", resp.StatusCode)
	}

	resp, _ = do(t, "DELETE", url, "")
	if resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "GET", url, ""); resp.StatusCode != 404 {
		t.Fatalf("get after delete: %d", resp.StatusCode)
	}
}

func TestDeleteProjectWithEpicsConflicts(t *testing.T) {
	srv, st := newTestServer(t)
	p, _ := st.CreateProject("P", "")
	st.DB.Exec(`INSERT INTO epics(project_id, name) VALUES (?, 'e')`, p.ID)
	resp, _ := do(t, "DELETE", srv.URL+"/api/v1/projects/1", "")
	if resp.StatusCode != 409 {
		t.Fatalf("expected 409, got %d", resp.StatusCode)
	}
}
