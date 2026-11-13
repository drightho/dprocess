// Package api implements the REST API and serves the web UI.
package api

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"sync"
	"time"

	"github.com/dright/dprocess/internal/github"
	"github.com/dright/dprocess/internal/store"
)

// Server holds dependencies for HTTP handlers.
type Server struct {
	Store *store.Store
	// UI, if set, is served at / with SPA fallback to index.html.
	UI fs.FS
	// GitHub is the optional GitHub sync (status refresh and issue import); nil means disabled. Once
	// the server is running, read it through GitHubSyncer (the API can change it).
	GitHub *github.Syncer

	// Settings used when the sync is turned on (StartGitHub or PUT /github-sync).
	GitHubToken    string        // optional; empty sends no Authorization header
	GitHubAPI      string        // empty = github.DefaultAPI
	GitHubInterval time.Duration // zero = 15m
	// Ctx is the parent context of sync loops started this way; nil = Background.
	Ctx context.Context

	mu     sync.Mutex
	cancel context.CancelFunc // cancels the loop of the current syncer, nil if none or injected
	loops  []chan struct{}    // done channels of started loops, for Close
}

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	s.registerProjects(mux)
	s.registerEpics(mux)
	s.registerStories(mux)
	s.registerDependencies(mux)
	s.registerTagsAndComments(mux)
	s.registerIssues(mux)
	s.registerPullRequests(mux)
	s.registerGitHubSync(mux)
	mux.HandleFunc("GET /api/v1/openapi.yaml", s.serveSpec)
	mux.HandleFunc("/api/", apiNotFound)
	if s.UI != nil {
		mux.Handle("/", spaHandler(s.UI))
	}
	return mux
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DB.PingContext(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeError emits an RFC 7807-style problem document.
func writeError(w http.ResponseWriter, status int, title, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"title":  title,
		"status": status,
		"detail": detail,
	})
}
