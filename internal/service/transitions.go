// Package service holds business rules that sit between the HTTP layer and
// the store.
package service

import (
	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/internal/workflow"
)

// Service applies business rules on top of the store.
type Service struct {
	Store *store.Store
}

// TransitionEpic moves an epic to a new state if the workflow allows it.
func (s *Service) TransitionEpic(id int64, to, reason, actor string) (*store.Epic, error) {
	return s.Store.TransitionEpic(id, to, reason, actor, workflow.Epic.Check)
}
