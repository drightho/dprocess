package api

import (
	"net/http"
	"strconv"

	"github.com/dright/dprocess/internal/store"
)

func (s *Server) registerDependencies(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/v1/stories/{id}/dependencies/{depId}", s.addDependency)
	mux.HandleFunc("DELETE /api/v1/stories/{id}/dependencies/{depId}", s.removeDependency)
}

// storyDetail is a story with its dependency relations.
type storyDetail struct {
	storyView
	DependsOn    []store.StoryRef     `json:"depends_on"`
	Dependents   []store.StoryRef     `json:"dependents"`
	Issues       []*store.Issue       `json:"issues"`
	PullRequests []*store.PullRequest `json:"pull_requests"`
}

func (s *Server) detailStory(st *store.Story) (storyDetail, error) {
	d := storyDetail{storyView: viewStory(st)}
	var err error
	if d.DependsOn, err = s.Store.ListDependencies(st.ID); err != nil {
		return d, err
	}
	if d.Dependents, err = s.Store.ListDependents(st.ID); err != nil {
		return d, err
	}
	if d.Issues, err = s.Store.ListIssues(st.ProjectID, st.ID); err != nil {
		return d, err
	}
	if err = s.warnIssues(st.ProjectID, d.Issues...); err != nil {
		return d, err
	}
	if d.PullRequests, err = s.Store.ListPullRequests(st.ID); err != nil {
		return d, err
	}
	err = s.warnPullRequests(st.ID, d.PullRequests...)
	return d, err
}

func depIDs(w http.ResponseWriter, r *http.Request) (id, dep int64, ok bool) {
	id, ok = idOr404(w, r, "story")
	if !ok {
		return
	}
	dep, err := strconv.ParseInt(r.PathValue("depId"), 10, 64)
	if err != nil || dep <= 0 {
		writeError(w, http.StatusNotFound, "not found", "invalid dependency id")
		return 0, 0, false
	}
	return id, dep, true
}

func (s *Server) addDependency(w http.ResponseWriter, r *http.Request) {
	id, dep, ok := depIDs(w, r)
	if !ok {
		return
	}
	if err := s.Store.AddDependency(id, dep); err != nil {
		storeError(w, err)
		return
	}
	st, err := s.Store.GetStory(id)
	if err != nil {
		storeError(w, err)
		return
	}
	d, err := s.detailStory(st)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) removeDependency(w http.ResponseWriter, r *http.Request) {
	id, dep, ok := depIDs(w, r)
	if !ok {
		return
	}
	if err := s.Store.RemoveDependency(id, dep); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
