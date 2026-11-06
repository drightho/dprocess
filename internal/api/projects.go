package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/dright/dprocess/internal/service"
	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

// pathID parses the named path value as a positive int64.
func pathID(r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	return id, err == nil && id > 0
}

// decode reads a JSON body, rejecting unknown fields.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body", err.Error())
		return false
	}
	return true
}

// storeError maps store errors onto HTTP statuses.
func storeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found", err.Error())
	case errors.Is(err, store.ErrInUse), errors.Is(err, store.ErrCycle), errors.Is(err, store.ErrDuplicate),
		errors.Is(err, workflow.ErrIllegalTransition):
		writeError(w, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, workflow.ErrUnknownState), errors.Is(err, store.ErrSelfDependency),
		errors.Is(err, store.ErrCrossProject), errors.Is(err, store.ErrBadReference),
		errors.Is(err, service.ErrInvalidTag), errors.Is(err, service.ErrInvalidIssueURL):
		writeError(w, http.StatusUnprocessableEntity, "validation failed", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal error", err.Error())
	}
}

func (s *Server) registerProjects(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/projects", s.listProjects)
	mux.HandleFunc("POST /api/v1/projects", s.createProject)
	mux.HandleFunc("GET /api/v1/projects/{id}", s.getProject)
	mux.HandleFunc("PATCH /api/v1/projects/{id}", s.updateProject)
	mux.HandleFunc("DELETE /api/v1/projects/{id}", s.deleteProject)
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	ps, err := s.Store.ListProjects()
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

type projectInput struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
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
	p, err := s.Store.CreateProject(strings.TrimSpace(*in.Name), desc)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/projects/"+strconv.FormatInt(p.ID, 10))
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		writeError(w, http.StatusNotFound, "not found", "invalid project id")
		return
	}
	p, err := s.Store.GetProject(id)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		writeError(w, http.StatusNotFound, "not found", "invalid project id")
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
	p, err := s.Store.UpdateProject(id, in.Name, in.Description)
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		writeError(w, http.StatusNotFound, "not found", "invalid project id")
		return
	}
	if err := s.Store.DeleteProject(id); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
