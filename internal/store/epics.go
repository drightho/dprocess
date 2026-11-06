package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// Epic is a group of related stories within a project.
type Epic struct {
	ID          int64    `json:"id"`
	ProjectID   int64    `json:"project_id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	State       string   `json:"state"`
	Tags        []string `json:"tags"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

const epicCols = `id, project_id, name, description, state, created_at, updated_at`

type scanner interface{ Scan(...any) error }

func scanEpic(row scanner) (*Epic, error) {
	var e Epic
	if err := row.Scan(&e.ID, &e.ProjectID, &e.Name, &e.Description, &e.State, &e.CreatedAt, &e.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &e, nil
}

// CreateEpic inserts a new epic in the given project (initial state "draft").
func (s *Store) CreateEpic(projectID int64, name, description string) (*Epic, error) {
	if _, err := s.GetProject(projectID); err != nil {
		return nil, err
	}
	res, err := s.DB.Exec(`INSERT INTO epics(project_id, name, description) VALUES (?, ?, ?)`,
		projectID, name, description)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetEpic(id)
}

// GetEpic returns one epic or ErrNotFound.
func (s *Store) GetEpic(id int64) (*Epic, error) {
	e, err := scanEpic(s.DB.QueryRow(`SELECT `+epicCols+` FROM epics WHERE id = ?`, id))
	if err != nil {
		return nil, err
	}
	if e.Tags, err = s.ListTags("epic", id); err != nil {
		return nil, err
	}
	return e, nil
}

// ListEpics returns the epics of a project, optionally filtered by state
// and/or tag (already normalized).
func (s *Store) ListEpics(projectID int64, state, tag string) ([]*Epic, error) {
	if _, err := s.GetProject(projectID); err != nil {
		return nil, err
	}
	q := `SELECT ` + epicCols + ` FROM epics WHERE project_id = ?`
	args := []any{projectID}
	if state != "" {
		q += ` AND state = ?`
		args = append(args, state)
	}
	if tag != "" {
		q += ` AND EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_type = 'epic' AND t.entity_id = epics.id AND t.tag = ?)`
		args = append(args, tag)
	}
	rows, err := s.DB.Query(q+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	out := []*Epic{}
	for rows.Next() {
		e, err := scanEpic(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, e)
	}
	err = rows.Err()
	rows.Close() // release the single connection before loading tags
	if err != nil {
		return nil, err
	}
	if err := s.attachEpicTags(out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateEpic changes name and/or description (nil = unchanged). State is
// changed only through TransitionEpic.
func (s *Store) UpdateEpic(id int64, name, description *string) (*Epic, error) {
	res, err := s.DB.Exec(`UPDATE epics SET
		name = COALESCE(?, name),
		description = COALESCE(?, description),
		updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE id = ?`, name, description, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.GetEpic(id)
}

// DeleteEpic removes an epic together with its history, comments and tags.
// It fails with ErrInUse while the epic still has stories.
func (s *Store) DeleteEpic(id int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var stories int
	if err := tx.QueryRow(`SELECT count(*) FROM stories WHERE epic_id = ?`, id).Scan(&stories); err != nil {
		return err
	}
	if stories > 0 {
		return fmt.Errorf("epic %d: %w", id, ErrInUse)
	}
	for _, t := range []string{"state_history", "comments", "entity_tags"} {
		if _, err := tx.Exec(`DELETE FROM `+t+` WHERE entity_type = 'epic' AND entity_id = ?`, id); err != nil {
			return err
		}
	}
	res, err := tx.Exec(`DELETE FROM epics WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// StoryChange is a state change applied to a story as a side effect of an
// epic transition (e.g. cancelling the epic cancels its stories).
type StoryChange struct {
	ID     int64
	To     string
	Reason string
}

// EpicPolicy decides whether an epic may leave state from, given its current
// stories. It returns the story changes to apply in the same transaction, or
// an error to veto the transition. It runs inside the transaction, so the
// stories it sees cannot change before the epic does.
type EpicPolicy func(from string, stories []StoryRef) ([]StoryChange, error)

// TransitionEpic moves an epic to a new state. policy is consulted first; the
// epic change, any cascaded story changes and all their history rows are
// written atomically.
func (s *Store) TransitionEpic(id int64, to, reason, actor string, policy EpicPolicy) (*Epic, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var from string
	if err := tx.QueryRow(`SELECT state FROM epics WHERE id = ?`, id).Scan(&from); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	rows, err := tx.Query(`SELECT id, epic_id, name, state FROM stories WHERE epic_id = ? ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	stories := []StoryRef{}
	for rows.Next() {
		var r StoryRef
		if err := rows.Scan(&r.ID, &r.EpicID, &r.Name, &r.State); err != nil {
			rows.Close()
			return nil, err
		}
		stories = append(stories, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	changes, err := policy(from, stories)
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(`UPDATE epics SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, to, id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`INSERT INTO state_history(entity_type, entity_id, from_state, to_state, reason, actor)
		VALUES ('epic', ?, ?, ?, ?, ?)`, id, from, to, reason, actor); err != nil {
		return nil, err
	}

	current := make(map[int64]string, len(stories))
	for _, st := range stories {
		current[st.ID] = st.State
	}
	for _, c := range changes {
		storyFrom, ok := current[c.ID]
		if !ok {
			return nil, fmt.Errorf("epic %d: cascade targets story %d which is not in the epic", id, c.ID)
		}
		if _, err := tx.Exec(`UPDATE stories SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, c.To, c.ID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`INSERT INTO state_history(entity_type, entity_id, from_state, to_state, reason, actor)
			VALUES ('story', ?, ?, ?, ?, ?)`, c.ID, storyFrom, c.To, c.Reason, actor); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetEpic(id)
}

// HistoryEntry is one recorded state change.
type HistoryEntry struct {
	ID         int64  `json:"id"`
	EntityType string `json:"entity_type"`
	EntityID   int64  `json:"entity_id"`
	FromState  string `json:"from_state"`
	ToState    string `json:"to_state"`
	Reason     string `json:"reason"`
	Actor      string `json:"actor"`
	At         string `json:"at"`
}

// ListHistory returns the state changes of an epic or story, oldest first.
func (s *Store) ListHistory(entityType string, id int64) ([]*HistoryEntry, error) {
	rows, err := s.DB.Query(`SELECT id, entity_type, entity_id, from_state, to_state, reason, actor, at
		FROM state_history WHERE entity_type = ? AND entity_id = ? ORDER BY id`, entityType, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*HistoryEntry{}
	for rows.Next() {
		var h HistoryEntry
		if err := rows.Scan(&h.ID, &h.EntityType, &h.EntityID, &h.FromState, &h.ToState, &h.Reason, &h.Actor, &h.At); err != nil {
			return nil, err
		}
		out = append(out, &h)
	}
	return out, rows.Err()
}
