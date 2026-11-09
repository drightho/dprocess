package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/dright/dprocess/internal/service"
	"github.com/dright/dprocess/internal/store"
)

func (s *Server) registerIssues(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/projects/{id}/issues", s.listIssues)
	mux.HandleFunc("POST /api/v1/projects/{id}/issues", s.createIssue)
	mux.HandleFunc("GET /api/v1/issues/{id}", s.getIssue)
	mux.HandleFunc("PATCH /api/v1/issues/{id}", s.updateIssue)
	mux.HandleFunc("DELETE /api/v1/issues/{id}", s.deleteIssue)
}

type createIssueInput struct {
	GitHubURL string  `json:"github_url"`
	Title     *string `json:"title"`
	Kind      *string `json:"kind"`
	StoryID   optInt  `json:"story_id"`
}

type updateIssueInput struct {
	Title   *string `json:"title"`
	Kind    *string `json:"kind"`
	StoryID optInt  `json:"story_id"`
}

func trimPtr(p *string) *string {
	if p == nil {
		return nil
	}
	t := strings.TrimSpace(*p)
	return &t
}

func (s *Server) createIssue(w http.ResponseWriter, r *http.Request) {
	pid, ok := idOr404(w, r, "project")
	if !ok {
		return
	}
	var in createIssueInput
	if !decode(w, r, &in) {
		return
	}
	repo, number, canonical, err := service.ParseIssueURL(in.GitHubURL)
	if err != nil {
		storeError(w, err)
		return
	}
	i, err := s.Store.CreateIssue(pid, store.NewIssue{
		StoryID: in.StoryID.Value,
		URL:     canonical,
		Repo:    repo,
		Number:  number,
		Title:   strings.TrimSpace(deref(in.Title)),
		Kind:    strings.TrimSpace(deref(in.Kind)),
	})
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.warnIssues(i.ProjectID, i); err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/issues/"+strconv.FormatInt(i.ID, 10))
	writeJSON(w, http.StatusCreated, i)
}

func (s *Server) listIssues(w http.ResponseWriter, r *http.Request) {
	pid, ok := idOr404(w, r, "project")
	if !ok {
		return
	}
	var storyID int64
	if v := r.URL.Query().Get("story"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusUnprocessableEntity, "validation failed", "invalid story filter")
			return
		}
		storyID = id
	}
	is, err := s.Store.ListIssues(pid, storyID)
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.warnIssues(pid, is...); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, is)
}

func (s *Server) getIssue(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "issue")
	if !ok {
		return
	}
	i, err := s.Store.GetIssue(id)
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.warnIssues(i.ProjectID, i); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, i)
}

func (s *Server) updateIssue(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "issue")
	if !ok {
		return
	}
	var in updateIssueInput
	if !decode(w, r, &in) {
		return
	}
	i, err := s.Store.UpdateIssue(id, store.IssuePatch{
		Title:    trimPtr(in.Title),
		Kind:     trimPtr(in.Kind),
		StorySet: in.StoryID.Set,
		StoryID:  in.StoryID.Value,
	})
	if err != nil {
		storeError(w, err)
		return
	}
	if err := s.warnIssues(i.ProjectID, i); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, i)
}

func (s *Server) deleteIssue(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "issue")
	if !ok {
		return
	}
	if err := s.Store.DeleteIssue(id); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
