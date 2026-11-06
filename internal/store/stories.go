package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// Story is a deliverable, verifiable piece of software within an epic.
type Story struct {
	ID                 int64  `json:"id"`
	ProjectID          int64  `json:"project_id"`
	EpicID             int64  `json:"epic_id"`
	Name               string `json:"name"`
	Description        string `json:"description"`
	AcceptanceCriteria string `json:"acceptance_criteria"`
	State              string `json:"state"`
	EstimateLOC        *int64 `json:"estimate_loc"`
	Assignee           string `json:"assignee"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

const storyCols = `id, project_id, epic_id, name, description, acceptance_criteria, state, estimate_loc, assignee, created_at, updated_at`

func scanStory(row scanner) (*Story, error) {
	var s Story
	var est sql.NullInt64
	if err := row.Scan(&s.ID, &s.ProjectID, &s.EpicID, &s.Name, &s.Description, &s.AcceptanceCriteria,
		&s.State, &est, &s.Assignee, &s.CreatedAt, &s.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if est.Valid {
		s.EstimateLOC = &est.Int64
	}
	return &s, nil
}

// NewStory holds the fields supplied when creating a story.
type NewStory struct {
	Name               string
	Description        string
	AcceptanceCriteria string
	EstimateLOC        *int64
	Assignee           string
}

// StoryPatch holds optional changes; nil pointers are left unchanged. Because
// a nil estimate is meaningful (clears it), EstimateSet says whether
// EstimateLOC should be applied.
type StoryPatch struct {
	Name               *string
	Description        *string
	AcceptanceCriteria *string
	Assignee           *string
	EstimateSet        bool
	EstimateLOC        *int64
}

// CreateStory inserts a story (state "draft") into an epic. The story's
// project is taken from the epic.
func (s *Store) CreateStory(epicID int64, in NewStory) (*Story, error) {
	epic, err := s.GetEpic(epicID)
	if err != nil {
		return nil, err
	}
	res, err := s.DB.Exec(`INSERT INTO stories(project_id, epic_id, name, description, acceptance_criteria, estimate_loc, assignee)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		epic.ProjectID, epicID, in.Name, in.Description, in.AcceptanceCriteria, in.EstimateLOC, in.Assignee)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetStory(id)
}

// GetStory returns one story or ErrNotFound.
func (s *Store) GetStory(id int64) (*Story, error) {
	return scanStory(s.DB.QueryRow(`SELECT `+storyCols+` FROM stories WHERE id = ?`, id))
}

// StoryFilter narrows story listings; zero values mean "any".
type StoryFilter struct {
	State    string
	EpicID   int64
	Assignee string
}

// ListStories returns the stories of a project matching the filter.
func (s *Store) ListStories(projectID int64, f StoryFilter) ([]*Story, error) {
	if _, err := s.GetProject(projectID); err != nil {
		return nil, err
	}
	q := `SELECT ` + storyCols + ` FROM stories WHERE project_id = ?`
	args := []any{projectID}
	if f.State != "" {
		q += ` AND state = ?`
		args = append(args, f.State)
	}
	if f.EpicID != 0 {
		q += ` AND epic_id = ?`
		args = append(args, f.EpicID)
	}
	if f.Assignee != "" {
		q += ` AND assignee = ?`
		args = append(args, f.Assignee)
	}
	return s.queryStories(q+` ORDER BY id`, args...)
}

// ListEpicStories returns the stories of one epic.
func (s *Store) ListEpicStories(epicID int64) ([]*Story, error) {
	if _, err := s.GetEpic(epicID); err != nil {
		return nil, err
	}
	return s.queryStories(`SELECT `+storyCols+` FROM stories WHERE epic_id = ? ORDER BY id`, epicID)
}

func (s *Store) queryStories(q string, args ...any) ([]*Story, error) {
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Story{}
	for rows.Next() {
		st, err := scanStory(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// UpdateStory applies a patch. State changes only via TransitionStory.
func (s *Store) UpdateStory(id int64, p StoryPatch) (*Story, error) {
	res, err := s.DB.Exec(`UPDATE stories SET
		name = COALESCE(?, name),
		description = COALESCE(?, description),
		acceptance_criteria = COALESCE(?, acceptance_criteria),
		assignee = COALESCE(?, assignee),
		estimate_loc = CASE WHEN ? THEN ? ELSE estimate_loc END,
		updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE id = ?`,
		p.Name, p.Description, p.AcceptanceCriteria, p.Assignee, p.EstimateSet, p.EstimateLOC, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.GetStory(id)
}

// DeleteStory removes a story with its history, comments, tags and its own
// dependency edges. It fails with ErrInUse while other stories depend on it.
func (s *Store) DeleteStory(id int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var dependents int
	if err := tx.QueryRow(`SELECT count(*) FROM story_dependencies WHERE depends_on_id = ?`, id).Scan(&dependents); err != nil {
		return err
	}
	if dependents > 0 {
		return fmt.Errorf("story %d: %w", id, ErrInUse)
	}
	if _, err := tx.Exec(`DELETE FROM story_dependencies WHERE story_id = ?`, id); err != nil {
		return err
	}
	for _, t := range []string{"state_history", "comments", "entity_tags"} {
		if _, err := tx.Exec(`DELETE FROM `+t+` WHERE entity_type = 'story' AND entity_id = ?`, id); err != nil {
			return err
		}
	}
	res, err := tx.Exec(`DELETE FROM stories WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// TransitionStory moves a story to a new state; see TransitionEpic.
func (s *Store) TransitionStory(id int64, to, reason, actor string, check func(from, to string) error) (*Story, error) {
	if err := s.transition("story", "stories", id, to, reason, actor, check); err != nil {
		return nil, err
	}
	return s.GetStory(id)
}
