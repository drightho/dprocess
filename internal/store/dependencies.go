package store

import (
	"errors"
	"fmt"
)

// Dependency rule violations.
var (
	ErrSelfDependency = errors.New("a story cannot depend on itself")
	ErrCrossProject   = errors.New("stories must belong to the same project")
	ErrCycle          = errors.New("dependency would create a cycle")
)

// StoryRef is a compact reference to a story, used in dependency listings.
type StoryRef struct {
	ID     int64  `json:"id"`
	EpicID int64  `json:"epic_id"`
	Name   string `json:"name"`
	State  string `json:"state"`
}

// AddDependency records that storyID depends on dependsOnID. It is idempotent.
// The invariants (same project, no self-dependency, no cycles) are checked in
// the same transaction as the insert so they cannot be raced.
func (s *Store) AddDependency(storyID, dependsOnID int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	projectOf := func(id int64) (int64, error) {
		var p int64
		if err := tx.QueryRow(`SELECT project_id FROM stories WHERE id = ?`, id).Scan(&p); err != nil {
			return 0, ErrNotFound
		}
		return p, nil
	}
	sp, err := projectOf(storyID)
	if err != nil {
		return fmt.Errorf("story %d: %w", storyID, err)
	}
	dp, err := projectOf(dependsOnID)
	if err != nil {
		return fmt.Errorf("story %d: %w", dependsOnID, err)
	}
	if storyID == dependsOnID {
		return ErrSelfDependency
	}
	if sp != dp {
		return fmt.Errorf("stories %d and %d: %w", storyID, dependsOnID, ErrCrossProject)
	}

	// A cycle appears if dependsOnID already (transitively) depends on storyID.
	var n int
	if err := tx.QueryRow(`WITH RECURSIVE reach(id) AS (
			SELECT depends_on_id FROM story_dependencies WHERE story_id = ?
			UNION
			SELECT d.depends_on_id FROM story_dependencies d JOIN reach r ON d.story_id = r.id
		) SELECT count(*) FROM reach WHERE id = ?`, dependsOnID, storyID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("story %d -> %d: %w", storyID, dependsOnID, ErrCycle)
	}

	if _, err := tx.Exec(`INSERT OR IGNORE INTO story_dependencies(story_id, depends_on_id) VALUES (?, ?)`,
		storyID, dependsOnID); err != nil {
		return err
	}
	return tx.Commit()
}

// RemoveDependency deletes a dependency edge; ErrNotFound if it does not exist.
func (s *Store) RemoveDependency(storyID, dependsOnID int64) error {
	res, err := s.DB.Exec(`DELETE FROM story_dependencies WHERE story_id = ? AND depends_on_id = ?`,
		storyID, dependsOnID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("story %d does not depend on %d: %w", storyID, dependsOnID, ErrNotFound)
	}
	return nil
}

// ListDependencies returns the stories that storyID depends on.
func (s *Store) ListDependencies(storyID int64) ([]StoryRef, error) {
	return s.refs(`SELECT st.id, st.epic_id, st.name, st.state FROM story_dependencies d
		JOIN stories st ON st.id = d.depends_on_id WHERE d.story_id = ? ORDER BY st.id`, storyID)
}

// ListDependents returns the stories that depend on storyID.
func (s *Store) ListDependents(storyID int64) ([]StoryRef, error) {
	return s.refs(`SELECT st.id, st.epic_id, st.name, st.state FROM story_dependencies d
		JOIN stories st ON st.id = d.story_id WHERE d.depends_on_id = ? ORDER BY st.id`, storyID)
}

func (s *Store) refs(q string, id int64) ([]StoryRef, error) {
	rows, err := s.DB.Query(q, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StoryRef{}
	for rows.Next() {
		var r StoryRef
		if err := rows.Scan(&r.ID, &r.EpicID, &r.Name, &r.State); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
