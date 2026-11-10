package api

import (
	"context"
	"net/http"
	"time"

	"github.com/dright/dprocess/internal/github"
)

// DefaultGitHubInterval is the sync interval used when Server.GitHubInterval is zero.
const DefaultGitHubInterval = 15 * time.Minute

// closeWait bounds how long Close waits for sync loops to exit.
const closeWait = 2 * time.Second

func (s *Server) registerGitHubSync(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/github-sync", s.githubSyncStatus)
	mux.HandleFunc("PUT /api/v1/github-sync", s.githubSyncSet)
}

// GitHubSyncer returns the current syncer, or nil while the sync is disabled.
func (s *Server) GitHubSyncer() *github.Syncer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.GitHub
}

// StartGitHub turns the sync on exactly like an API enable (the startup entry
// point for --github-sync). It does nothing if the sync is already on.
func (s *Server) StartGitHub() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enableLocked()
}

// Close stops the sync loop started by StartGitHub or the API and waits (up to
// about 2s) for every loop to exit. It is idempotent and safe when nothing was
// started. A syncer injected into GitHub without a loop is left alone.
func (s *Server) Close() {
	s.mu.Lock()
	cancel, loops := s.cancel, s.loops
	if cancel != nil {
		s.GitHub = nil
	}
	s.cancel, s.loops = nil, nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	timeout := time.After(closeWait)
	for _, done := range loops {
		select {
		case <-done:
		case <-timeout:
			return
		}
	}
}

// enableLocked builds the syncer from the Server fields and starts its loop,
// which syncs at once. The caller holds s.mu.
func (s *Server) enableLocked() {
	if s.GitHub != nil {
		return
	}
	parent := s.Ctx
	if parent == nil {
		parent = context.Background()
	}
	interval := s.GitHubInterval
	if interval <= 0 {
		interval = DefaultGitHubInterval
	}
	api := s.GitHubAPI
	if api == "" {
		api = github.DefaultAPI
	}
	y := &github.Syncer{
		Store:    s.Store,
		Client:   &github.Client{BaseURL: api, Token: s.GitHubToken},
		Interval: interval,
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		y.Run(ctx)
	}()
	s.GitHub, s.cancel = y, cancel
	// Forget loops that have already ended so the list stays short.
	live := s.loops[:0]
	for _, d := range s.loops {
		select {
		case <-d:
		default:
			live = append(live, d)
		}
	}
	s.loops = append(live, done)
}

// disableLocked drops the syncer and cancels its loop without waiting for it.
// The caller holds s.mu.
func (s *Server) disableLocked() {
	s.GitHub = nil
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
}

// githubSyncStatus tells the UI whether remote status is being synced.
func (s *Server) githubSyncStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.GitHubSyncer().Status())
}

// githubSyncSet turns the sync on or off at run time. The setting is kept in
// memory only. It never waits for a sync run, and a failing run never fails it.
func (s *Server) githubSyncSet(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		writeError(w, http.StatusUnprocessableEntity, "validation failed", "enabled is required (true or false)")
		return
	}
	s.mu.Lock()
	if *in.Enabled {
		s.enableLocked()
	} else {
		s.disableLocked()
	}
	y := s.GitHub
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, y.Status())
}
