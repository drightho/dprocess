package api

import "testing"

func TestEpicLifecycle(t *testing.T) {
	srv, st := newTestServer(t)
	api := srv.URL + "/api/v1"
	st.CreateProject("P", "")

	resp, e := do(t, "POST", api+"/projects/1/epics", `{"name":" E1 ","description":"d"}`)
	if resp.StatusCode != 201 || e["name"] != "E1" || e["state"] != "draft" {
		t.Fatalf("create: %d %v", resp.StatusCode, e)
	}
	if at, _ := e["allowed_transitions"].([]any); len(at) != 2 || at[0] != "review" {
		t.Fatalf("allowed_transitions: %v", e["allowed_transitions"])
	}

	// Unknown project, validation.
	if resp, _ = do(t, "POST", api+"/projects/99/epics", `{"name":"x"}`); resp.StatusCode != 404 {
		t.Fatalf("unknown project: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "POST", api+"/projects/1/epics", `{"name":" "}`); resp.StatusCode != 422 {
		t.Fatalf("blank name: %d", resp.StatusCode)
	}

	// PATCH cannot change state.
	if resp, _ = do(t, "PATCH", api+"/epics/1", `{"state":"finished"}`); resp.StatusCode != 400 {
		t.Fatalf("patch state: %d", resp.StatusCode)
	}
	if resp, e = do(t, "PATCH", api+"/epics/1", `{"description":"new"}`); resp.StatusCode != 200 || e["description"] != "new" || e["name"] != "E1" {
		t.Fatalf("patch: %d %v", resp.StatusCode, e)
	}

	// Transitions: legal, illegal, unknown.
	if resp, e = do(t, "POST", api+"/epics/1/transition", `{"to":"review","reason":"ready for review","actor":"ann"}`); resp.StatusCode != 200 || e["state"] != "review" {
		t.Fatalf("to review: %d %v", resp.StatusCode, e)
	}
	if resp, _ = do(t, "POST", api+"/epics/1/transition", `{"to":"finished"}`); resp.StatusCode != 409 {
		t.Fatalf("illegal: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "POST", api+"/epics/1/transition", `{"to":"bogus"}`); resp.StatusCode != 422 {
		t.Fatalf("unknown: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "POST", api+"/epics/1/transition", `{}`); resp.StatusCode != 422 {
		t.Fatalf("missing to: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "POST", api+"/epics/99/transition", `{"to":"review"}`); resp.StatusCode != 404 {
		t.Fatalf("unknown epic: %d", resp.StatusCode)
	}

	// Only successful transitions are recorded.
	h, err := st.ListHistory("epic", 1)
	if err != nil || len(h) != 1 {
		t.Fatalf("history: %v %v", h, err)
	}
	if h[0].FromState != "draft" || h[0].ToState != "review" || h[0].Reason != "ready for review" || h[0].Actor != "ann" {
		t.Fatalf("history entry: %+v", h[0])
	}

	// List with state filter.
	do(t, "POST", api+"/projects/1/epics", `{"name":"E2"}`)
	resp2, _ := do(t, "GET", api+"/projects/1/epics?state=bogus", "")
	if resp2.StatusCode != 422 {
		t.Fatalf("bad filter: %d", resp2.StatusCode)
	}
	es, err := st.ListEpics(1, "draft")
	if err != nil || len(es) != 1 || es[0].Name != "E2" {
		t.Fatalf("filter: %v %v", es, err)
	}
}

func TestDeleteEpic(t *testing.T) {
	srv, st := newTestServer(t)
	api := srv.URL + "/api/v1"
	st.CreateProject("P", "")
	e, _ := st.CreateEpic(1, "E", "")
	st.DB.Exec(`INSERT INTO stories(project_id, epic_id, name) VALUES (1, ?, 's')`, e.ID)

	if resp, _ := do(t, "DELETE", api+"/epics/1", ""); resp.StatusCode != 409 {
		t.Fatalf("with stories: %d", resp.StatusCode)
	}
	st.DB.Exec(`DELETE FROM stories`)
	do(t, "POST", api+"/epics/1/transition", `{"to":"review"}`)
	if resp, _ := do(t, "DELETE", api+"/epics/1", ""); resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if h, _ := st.ListHistory("epic", 1); len(h) != 0 {
		t.Fatalf("history not removed: %v", h)
	}
	if resp, _ := do(t, "GET", api+"/epics/1", ""); resp.StatusCode != 404 {
		t.Fatalf("after delete: %d", resp.StatusCode)
	}
}
