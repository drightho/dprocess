package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/dright/dprocess/internal/service"
	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

func (s *Server) registerEpics(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/projects/{id}/epics", s.listEpics)
	mux.HandleFunc("POST /api/v1/projects/{id}/epics", s.createEpic)
	mux.HandleFunc("GET /api/v1/epics/{id}", s.getEpic)
	mux.HandleFunc("PATCH /api/v1/epics/{id}", s.updateEpic)
	mux.HandleFunc("DELETE /api/v1/epics/{id}", s.deleteEpic)
	mux.HandleFunc("POST /api/v1/epics/{id}/transition", s.transitionEpic)
	mux.HandleFunc("GET /api/v1/epics/{id}/history", s.epicHistory)
}

// epicView adds the legal next states to the stored epic.
type epicView struct {
	*store.Epic
	AllowedTransitions []string `json:"allowed_transitions"`
}

func viewEpic(e *store.Epic) epicView {
	return epicView{Epic: e, AllowedTransitions: workflow.Epic.Targets(e.State)}
}

func idOr404(w http.ResponseWriter, r *http.Request, what string) (int64, bool) {
	id, ok := pathID(r, "id")
	if !ok {
		writeError(w, http.StatusNotFound, "not found", "invalid "+what+" id")
	}
	return id, ok
}

func (s *Server) listEpics(w http.ResponseWriter, r *http.Request) {
	pid, ok := idOr404(w, r, "project")
	if !ok {
		return
	}
	state := r.URL.Query().Get("state")
	if state != "" && !workflow.Epic.Valid(state) {
		writeError(w, http.StatusUnprocessableEntity, "validation failed", "unknown state "+strconv.Quote(state))
		return
	}
	es, err := s.Store.ListEpics(pid, state)
	if err != nil {
		storeError(w, err)
		return
	}
	views := make([]epicView, len(es))
	for i, e := range es {
		views[i] = viewEpic(e)
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) createEpic(w http.ResponseWriter, r *http.Request) {
	pid, ok := idOr404(w, r, "project")
	if !ok {
		return
	}
	var in projectInput
	if !decode(w, r, &in) {
		return
	}
	if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "validation failed", "name is required")
		return
	}
	desc := ""
	if in.Description != nil {
		desc = *in.Description
	}
	e, err := s.Store.CreateEpic(pid, strings.TrimSpace(*in.Name), desc)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/epics/"+strconv.FormatInt(e.ID, 10))
	writeJSON(w, http.StatusCreated, viewEpic(e))
}

func (s *Server) getEpic(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "epic")
	if !ok {
		return
	}
	e, err := s.Store.GetEpic(id)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewEpic(e))
}

func (s *Server) updateEpic(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "epic")
	if !ok {
		return
	}
	var in projectInput
	if !decode(w, r, &in) {
		return
	}
	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		if trimmed == "" {
			writeError(w, http.StatusUnprocessableEntity, "validation failed", "name must not be empty")
			return
		}
		in.Name = &trimmed
	}
	e, err := s.Store.UpdateEpic(id, in.Name, in.Description)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewEpic(e))
}

func (s *Server) deleteEpic(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "epic")
	if !ok {
		return
	}
	if err := s.Store.DeleteEpic(id); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type transitionInput struct {
	To     string `json:"to"`
	Reason string `json:"reason"`
	Actor  string `json:"actor"`
}

func (s *Server) transitionEpic(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "epic")
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
	e, err := svc.TransitionEpic(id, in.To, in.Reason, in.Actor)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, viewEpic(e))
}

func (s *Server) epicHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := idOr404(w, r, "epic")
	if !ok {
		return
	}
	if _, err := s.Store.GetEpic(id); err != nil {
		storeError(w, err)
		return
	}
	h, err := s.Store.ListHistory("epic", id)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}
