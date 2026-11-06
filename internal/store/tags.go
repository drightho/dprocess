package store

import (
	"errors"
	"fmt"
	"strings"
)

// Additional sentinel errors.
var (
	ErrDuplicate    = errors.New("already exists")
	ErrBadReference = errors.New("referenced record does not exist")
)

var entityTables = map[string]string{"epic": "epics", "story": "stories"}

// requireEntity returns ErrNotFound unless the epic/story exists.
func (s *Store) requireEntity(entityType string, id int64) error {
	table, ok := entityTables[entityType]
	if !ok {
		return fmt.Errorf("unknown entity type %q", entityType)
	}
	var n int
	if err := s.DB.QueryRow(`SELECT count(*) FROM `+table+` WHERE id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%s %d: %w", entityType, id, ErrNotFound)
	}
	return nil
}

// AddTag attaches a (normalized) tag to an epic or story. Idempotent.
func (s *Store) AddTag(entityType string, id int64, tag string) error {
	if err := s.requireEntity(entityType, id); err != nil {
		return err
	}
	_, err := s.DB.Exec(`INSERT OR IGNORE INTO entity_tags(entity_type, entity_id, tag) VALUES (?, ?, ?)`,
		entityType, id, tag)
	return err
}

// RemoveTag detaches a tag; ErrNotFound if the entity does not carry it.
func (s *Store) RemoveTag(entityType string, id int64, tag string) error {
	res, err := s.DB.Exec(`DELETE FROM entity_tags WHERE entity_type = ? AND entity_id = ? AND tag = ?`,
		entityType, id, tag)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%s %d has no tag %q: %w", entityType, id, tag, ErrNotFound)
	}
	return nil
}

// ListTags returns the tags of one entity, sorted. Never nil.
func (s *Store) ListTags(entityType string, id int64) ([]string, error) {
	m, err := s.tagsFor(entityType, []int64{id})
	if err != nil {
		return nil, err
	}
	return m[id], nil
}

// tagsFor loads the tags of many entities in one query. Every requested id
// has an entry in the result (an empty, non-nil slice if untagged).
func (s *Store) tagsFor(entityType string, ids []int64) (map[int64][]string, error) {
	out := make(map[int64][]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	args := []any{entityType}
	for _, id := range ids {
		out[id] = []string{}
		args = append(args, id)
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := s.DB.Query(`SELECT entity_id, tag FROM entity_tags
		WHERE entity_type = ? AND entity_id IN (`+ph+`) ORDER BY tag`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var tag string
		if err := rows.Scan(&id, &tag); err != nil {
			return nil, err
		}
		out[id] = append(out[id], tag)
	}
	return out, rows.Err()
}

func (s *Store) attachEpicTags(es []*Epic) error {
	ids := make([]int64, len(es))
	for i, e := range es {
		ids[i] = e.ID
	}
	m, err := s.tagsFor("epic", ids)
	if err != nil {
		return err
	}
	for _, e := range es {
		e.Tags = m[e.ID]
	}
	return nil
}

func (s *Store) attachStoryTags(ss []*Story) error {
	ids := make([]int64, len(ss))
	for i, st := range ss {
		ids[i] = st.ID
	}
	m, err := s.tagsFor("story", ids)
	if err != nil {
		return err
	}
	for _, st := range ss {
		st.Tags = m[st.ID]
	}
	return nil
}
