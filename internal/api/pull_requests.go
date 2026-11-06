package api

import (
	"net/http"
	"strconv"

	"github.com/dright/dprocess/internal/service"
)

func (s *Server) registerPullRequests(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/stories/{id}/pull-requests", s.listPullRequests)
	mux.HandleFunc("POST /api/v1/stories/{id}/pull-requests", s.addPullRequest)
	mux.HandleFunc("DELETE /api/v1/stories/{id}/pull-requests/{prId}", s.removePullRequest)
}

func (s *Server) listPullRequests(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
		return
	}
	prs, err := s.Store.ListPullRequestsChecked(id)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, prs)
}

type pullRequestInput struct {
	GitHubURL string `json:"github_url"`
}

func (s *Server) addPullRequest(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
		return
	}
	var in pullRequestInput
	if !decode(w, r, &in) {
		return
	}
	repo, number, canonical, err := service.ParsePullRequestURL(in.GitHubURL)
	if err != nil {
		storeError(w, err)
		return
	}
	pr, err := s.Store.AddPullRequest(id, canonical, repo, number)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/stories/"+strconv.FormatInt(id, 10)+"/pull-requests")
	writeJSON(w, http.StatusCreated, pr)
}

func (s *Server) removePullRequest(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
		return
	}
	prID, err := strconv.ParseInt(r.PathValue("prId"), 10, 64)
	if err != nil || prID <= 0 {
		writeError(w, http.StatusNotFound, "not found", "invalid pull request id")
		return
	}
	if err := s.Store.RemovePullRequest(id, prID); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
