package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// Story is a deliverable, verifiable piece of software within an epic.
type Story struct {
	ID                 int64    `json:"id"`
	ProjectID          int64    `json:"project_id"`
	EpicID             int64    `json:"epic_id"`
	Name               string   `json:"name"`
	Description        string   `json:"description"`
	AcceptanceCriteria string   `json:"acceptance_criteria"`
	State              string   `json:"state"`
	EstimateLOC        *int64   `json:"estimate_loc"`
	Assignee           string   `json:"assignee"`
	Tags               []string `json:"tags"`
	CreatedAt          string   `json:"created_at"`
	UpdatedAt          string   `json:"updated_at"`
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

// ErrEpicClosed is returned when a story is added to a finished or cancelled epic.
var ErrEpicClosed = errors.New("epic is finished or cancelled")

// CreateStory inserts a story (state "draft") into an epic. The story's
// project is taken from the epic. Finished and cancelled epics accept no new
// stories (ErrEpicClosed); the check and insert are one atomic statement.
func (s *Store) CreateStory(epicID int64, in NewStory) (*Story, error) {
	res, err := s.DB.Exec(`INSERT INTO stories(project_id, epic_id, name, description, acceptance_criteria, estimate_loc, assignee)
		SELECT project_id, id, ?, ?, ?, ?, ? FROM epics
		WHERE id = ? AND state NOT IN ('finished', 'cancelled')`,
		in.Name, in.Description, in.AcceptanceCriteria, in.EstimateLOC, in.Assignee, epicID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		epic, err := s.GetEpic(epicID)
		if err != nil {
			return nil, err // ErrNotFound
		}
		return nil, fmt.Errorf("epic %d is %s: %w", epicID, epic.State, ErrEpicClosed)
	}
	id, _ := res.LastInsertId()
	return s.GetStory(id)
}

// GetStory returns one story or ErrNotFound.
func (s *Store) GetStory(id int64) (*Story, error) {
	st, err := scanStory(s.DB.QueryRow(`SELECT `+storyCols+` FROM stories WHERE id = ?`, id))
	if err != nil {
		return nil, err
	}
	if st.Tags, err = s.ListTags("story", id); err != nil {
		return nil, err
	}
	return st, nil
}

// StoryFilter narrows story listings; zero values mean "any". Tag must
// already be normalized.
type StoryFilter struct {
	State    string
	EpicID   int64
	Assignee string
	Tag      string
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
	if f.Tag != "" {
		q += ` AND EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_type = 'story' AND t.entity_id = stories.id AND t.tag = ?)`
		args = append(args, f.Tag)
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
	out := []*Story{}
	for rows.Next() {
		st, err := scanStory(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, st)
	}
	err = rows.Err()
	rows.Close() // release the single connection before loading tags
	if err != nil {
		return nil, err
	}
	if err := s.attachStoryTags(out); err != nil {
		return nil, err
	}
	return out, nil
}

// ErrStoryLocked is returned when a finished or cancelled story is modified.
var ErrStoryLocked = errors.New("story is finished or cancelled and cannot be modified")

// terminalStories is the SQL list of states in which a story is frozen.
const terminalStories = `('finished', 'cancelled')`

// lockedErr explains why a story cannot be modified.
func lockedErr(id int64, state string) error {
	return fmt.Errorf("story %d is %s: %w", id, state, ErrStoryLocked)
}

// UpdateStory applies a patch. State changes only via TransitionStory.
// Finished and cancelled stories cannot be modified (ErrStoryLocked); the
// check and the update are one atomic statement.
func (s *Store) UpdateStory(id int64, p StoryPatch) (*Story, error) {
	res, err := s.DB.Exec(`UPDATE stories SET
		name = COALESCE(?, name),
		description = COALESCE(?, description),
		acceptance_criteria = COALESCE(?, acceptance_criteria),
		assignee = COALESCE(?, assignee),
		estimate_loc = CASE WHEN ? THEN ? ELSE estimate_loc END,
		updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE id = ? AND state NOT IN `+terminalStories,
		p.Name, p.Description, p.AcceptanceCriteria, p.Assignee, p.EstimateSet, p.EstimateLOC, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		st, err := s.GetStory(id)
		if err != nil {
			return nil, err // ErrNotFound
		}
		return nil, lockedErr(id, st.State)
	}
	return s.GetStory(id)
}

// DeleteStory removes a story with its history, comments, tags and its own
// dependency edges. It fails with ErrStoryLocked for a finished story and
// with ErrInUse while other stories depend on it.
func (s *Store) DeleteStory(id int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var state string
	if err := tx.QueryRow(`SELECT state FROM stories WHERE id = ?`, id).Scan(&state); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if state == "finished" { // finished work stays on record; cancelled stories may be removed
		return lockedErr(id, state)
	}
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
	// issues.story_id is cleared by ON DELETE SET NULL.
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

// StoryContext is what a story transition policy may base its decision on.
// It is read inside the transaction that applies the change.
type StoryContext struct {
	From         string     // current state of the story
	EpicState    string     // current state of the story's epic
	Dependencies []StoryRef // stories this story depends on, with their states
}

// StoryPolicy decides whether a story may move out of its current state. It
// returns an error to veto the transition.
type StoryPolicy func(c StoryContext) error

// TransitionStory moves a story to a new state. policy is consulted inside
// the transaction; the change and its history row are written atomically.
func (s *Store) TransitionStory(id int64, to, reason, actor string, policy StoryPolicy) (*Story, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var c StoryContext
	err = tx.QueryRow(`SELECT st.state, e.state FROM stories st JOIN epics e ON e.id = st.epic_id WHERE st.id = ?`, id).
		Scan(&c.From, &c.EpicState)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	rows, err := tx.Query(`SELECT st.id, st.epic_id, st.name, st.state FROM story_dependencies d
		JOIN stories st ON st.id = d.depends_on_id WHERE d.story_id = ? ORDER BY st.id`, id)
	if err != nil {
		return nil, err
	}
	c.Dependencies = []StoryRef{}
	for rows.Next() {
		var r StoryRef
		if err := rows.Scan(&r.ID, &r.EpicID, &r.Name, &r.State); err != nil {
			rows.Close()
			return nil, err
		}
		c.Dependencies = append(c.Dependencies, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	if err := policy(c); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE stories SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, to, id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`INSERT INTO state_history(entity_type, entity_id, from_state, to_state, reason, actor)
		VALUES ('story', ?, ?, ?, ?, ?)`, id, c.From, to, reason, actor); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetStory(id)
}
