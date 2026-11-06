package api

import (
	"net/http"
	"strings"

	"github.com/dright/dprocess/internal/service"
)

// registerTagsAndComments wires tag and comment routes for both epics and
// stories; the handlers are shared and parameterised by entity type.
func (s *Server) registerTagsAndComments(mux *http.ServeMux) {
	for _, e := range []struct{ path, typ string }{{"epics", "epic"}, {"stories", "story"}} {
		base := "/api/v1/" + e.path + "/{id}"
		mux.HandleFunc("PUT "+base+"/tags/{tag}", s.addTag(e.typ))
		mux.HandleFunc("DELETE "+base+"/tags/{tag}", s.removeTag(e.typ))
		mux.HandleFunc("GET "+base+"/comments", s.listComments(e.typ))
		mux.HandleFunc("POST "+base+"/comments", s.addComment(e.typ))
	}
}

// tagFilter reads and normalizes the optional ?tag= query parameter.
func tagFilter(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := r.URL.Query().Get("tag")
	if raw == "" {
		return "", true
	}
	tag, err := service.NormalizeTag(raw)
	if err != nil {
		storeError(w, err)
		return "", false
	}
	return tag, true
}

// writeEntity responds with the current representation of an epic or story.
func (s *Server) writeEntity(w http.ResponseWriter, typ string, id int64) {
	if typ == "epic" {
		e, err := s.Store.GetEpic(id)
		if err != nil {
			storeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, viewEpic(e))
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

func (s *Server) addTag(typ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := idOr404(w, r, typ)
		if !ok {
			return
		}
		tag, err := service.NormalizeTag(r.PathValue("tag"))
		if err != nil {
			storeError(w, err)
			return
		}
		if err := s.Store.AddTag(typ, id, tag); err != nil {
			storeError(w, err)
			return
		}
		s.writeEntity(w, typ, id)
	}
}

func (s *Server) removeTag(typ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := idOr404(w, r, typ)
		if !ok {
			return
		}
		tag, err := service.NormalizeTag(r.PathValue("tag"))
		if err != nil {
			storeError(w, err)
			return
		}
		if err := s.Store.RemoveTag(typ, id, tag); err != nil {
			storeError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

type commentInput struct {
	Body   string `json:"body"`
	Author string `json:"author"`
}

func (s *Server) addComment(typ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := idOr404(w, r, typ)
		if !ok {
			return
		}
		var in commentInput
		if !decode(w, r, &in) {
			return
		}
		body := strings.TrimSpace(in.Body)
		if body == "" {
			writeError(w, http.StatusUnprocessableEntity, "validation failed", "body is required")
			return
		}
		c, err := s.Store.AddComment(typ, id, body, strings.TrimSpace(in.Author))
		if err != nil {
			storeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, c)
	}
}

func (s *Server) listComments(typ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := idOr404(w, r, typ)
		if !ok {
			return
		}
		cs, err := s.Store.ListComments(typ, id)
		if err != nil {
			storeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, cs)
	}
}
