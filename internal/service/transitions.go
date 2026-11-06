// Package service holds business rules that sit between the HTTP layer and
// the store.
package service

import (
	"github.com/dright/dprocess/internal/store"
)

// Service applies business rules on top of the store.
type Service struct {
	Store *store.Store
}
