package api

import "net/http"

func (s *Server) registerGitHubSync(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/github-sync", s.githubSyncStatus)
}

// githubSyncStatus tells the UI whether remote status is being synced.
func (s *Server) githubSyncStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.GitHub.Status())
}
