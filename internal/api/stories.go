package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/dright/dprocess/internal/service"
	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

func (s *Server) registerStories(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/epics/{id}/stories", s.listEpicStories)
	mux.HandleFunc("POST /api/v1/epics/{id}/stories", s.createStory)
	mux.HandleFunc("GET /api/v1/projects/{id}/stories", s.listProjectStories)
	mux.HandleFunc("GET /api/v1/stories/{id}", s.getStory)
	mux.HandleFunc("PATCH /api/v1/stories/{id}", s.updateStory)
	mux.HandleFunc("DELETE /api/v1/stories/{id}", s.deleteStory)
	mux.HandleFunc("POST /api/v1/stories/{id}/transition", s.transitionStory)
	mux.HandleFunc("GET /api/v1/stories/{id}/history", s.storyHistory)
}

// storyView adds derived fields to the stored story.
type storyView struct {
	*store.Story
	Warnings           []string `json:"warnings"`
	AllowedTransitions []string `json:"allowed_transitions"`
}

func viewStory(st *store.Story) storyView {
	return storyView{
		Story:              st,
		Warnings:           service.StoryWarnings(st),
		AllowedTransitions: workflow.Story.Targets(st.State),
	}
}

func viewStories(ss []*store.Story) []storyView {
	out := make([]storyView, len(ss))
	for i, st := range ss {
		out[i] = viewStory(st)
	}
	return out
}

// optInt distinguishes an absent JSON field from an explicit null.
type optInt struct {
	Set   bool
	Value *int64
}

func (o *optInt) UnmarshalJSON(b []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		o.Value = nil
		return nil
	}
	var v int64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

type storyInput struct {
	Name               *string `json:"name"`
	Description        *string `json:"description"`
	AcceptanceCriteria *string `json:"acceptance_criteria"`
	Assignee           *string `json:"assignee"`
	EstimateLOC        optInt  `json:"estimate_loc"`
}

func (in *storyInput) validate(w http.ResponseWriter) bool {
	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		if trimmed == "" {
			writeError(w, http.StatusUnprocessableEntity, "validation failed", "name must not be empty")
			return false
		}
		in.Name = &trimmed
	}
	if v := in.EstimateLOC.Value; v != nil && *v < 0 {
		writeError(w, http.StatusUnprocessableEntity, "validation failed", "estimate_loc must not be negative")
		return false
	}
	return true
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Server) createStory(w http.ResponseWriter, r *http.Request) {
	eid, ok := idOr404(w, r, "epic")
	if !ok {
		return
	}
	var in storyInput
	if !decode(w, r, &in) {
		return
	}
	if in.Name == nil {
		writeError(w, http.StatusUnprocessableEntity, "validation failed", "name is required")
		return
	}
	if !in.validate(w) {
		return
	}
	st, err := s.Store.CreateStory(eid, store.NewStory{
		Name:               *in.Name,
		Description:        deref(in.Description),
		AcceptanceCriteria: deref(in.AcceptanceCriteria),
		EstimateLOC:        in.EstimateLOC.Value,
		Assignee:           deref(in.Assignee),
	})
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/stories/"+strconv.FormatInt(st.ID, 10))
	writeJSON(w, http.StatusCreated, viewStory(st))
}

func (s *Server) listEpicStories(w http.ResponseWriter, r *http.Request) {
	eid, ok := idOr404(w, r, "epic")
	if !ok {
		return
	}
	ss, err := s.Store.ListEpicStories(eid)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewStories(ss))
}

func (s *Server) listProjectStories(w http.ResponseWriter, r *http.Request) {
	pid, ok := idOr404(w, r, "project")
	if !ok {
		return
	}
	q := r.URL.Query()
	f := store.StoryFilter{State: q.Get("state"), Assignee: q.Get("assignee")}
	if f.State != "" && !workflow.Story.Valid(f.State) {
		writeError(w, http.StatusUnprocessableEntity, "validation failed", "unknown state "+strconv.Quote(f.State))
		return
	}
	if e := q.Get("epic"); e != "" {
		id, err := strconv.ParseInt(e, 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusUnprocessableEntity, "validation failed", "invalid epic filter")
			return
		}
		f.EpicID = id
	}
	tag, ok := tagFilter(w, r)
	if !ok {
		return
	}
	f.Tag = tag
	ss, err := s.Store.ListStories(pid, f)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewStories(ss))
}

func (s *Server) getStory(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
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

func (s *Server) updateStory(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
		return
	}
	var in storyInput
	if !decode(w, r, &in) || !in.validate(w) {
		return
	}
	st, err := s.Store.UpdateStory(id, store.StoryPatch{
		Name:               in.Name,
		Description:        in.Description,
		AcceptanceCriteria: in.AcceptanceCriteria,
		Assignee:           in.Assignee,
		EstimateSet:        in.EstimateLOC.Set,
		EstimateLOC:        in.EstimateLOC.Value,
	})
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewStory(st))
}

func (s *Server) deleteStory(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
		return
	}
	if err := s.Store.DeleteStory(id); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) transitionStory(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
		return
	}
	var in transitionInput
	if !decode(w, r, &in) {
		return
	}
	if in.To == "" {
		writeError(w, http.StatusUnprocessableEntity, "validation failed", "to is required")
		return
	}
	svc := &service.Service{Store: s.Store}
	st, err := svc.TransitionStory(id, in.To, in.Reason, in.Actor)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewStory(st))
}

func (s *Server) storyHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "story")
	if !ok {
		return
	}
	if _, err := s.Store.GetStory(id); err != nil {
		storeError(w, err)
		return
	}
	h, err := s.Store.ListHistory("story", id)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}
