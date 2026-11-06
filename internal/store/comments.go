package store

// Comment is a free-form note on an epic or story.
type Comment struct {
	ID         int64  `json:"id"`
	EntityType string `json:"entity_type"`
	EntityID   int64  `json:"entity_id"`
	Body       string `json:"body"`
	Author     string `json:"author"`
	CreatedAt  string `json:"created_at"`
}

// AddComment appends a comment to an epic or story.
func (s *Store) AddComment(entityType string, id int64, body, author string) (*Comment, error) {
	if err := s.requireEntity(entityType, id); err != nil {
		return nil, err
	}
	res, err := s.DB.Exec(`INSERT INTO comments(entity_type, entity_id, body, author) VALUES (?, ?, ?, ?)`,
		entityType, id, body, author)
	if err != nil {
		return nil, err
	}
	cid, _ := res.LastInsertId()
	var c Comment
	err = s.DB.QueryRow(`SELECT id, entity_type, entity_id, body, author, created_at FROM comments WHERE id = ?`, cid).
		Scan(&c.ID, &c.EntityType, &c.EntityID, &c.Body, &c.Author, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// ListComments returns the comments of an epic or story, oldest first.
func (s *Store) ListComments(entityType string, id int64) ([]*Comment, error) {
	if err := s.requireEntity(entityType, id); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(`SELECT id, entity_type, entity_id, body, author, created_at FROM comments
		WHERE entity_type = ? AND entity_id = ? ORDER BY id`, entityType, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Comment{}
	for rows.Next() {
		var c Comment
		if err := rows.Scan(&c.ID, &c.EntityType, &c.EntityID, &c.Body, &c.Author, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}
