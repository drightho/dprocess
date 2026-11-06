package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// Sentinel errors returned by store operations.
var (
	ErrNotFound = errors.New("not found")
	ErrInUse    = errors.New("still has dependent records")
)

// Project is the top-level container of epics.
type Project struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

const projectCols = `id, name, description, created_at, updated_at`

func scanProject(row interface{ Scan(...any) error }) (*Project, error) {
	var p Project
	if err := row.Scan(&p.ID, &p.Name, &p.Description, &p.CreatedAt, &p.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &p, nil
}

// CreateProject inserts a new project.
func (s *Store) CreateProject(name, description string) (*Project, error) {
	res, err := s.DB.Exec(`INSERT INTO projects(name, description) VALUES (?, ?)`, name, description)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetProject(id)
}

// GetProject returns one project or ErrNotFound.
func (s *Store) GetProject(id int64) (*Project, error) {
	return scanProject(s.DB.QueryRow(`SELECT `+projectCols+` FROM projects WHERE id = ?`, id))
}

// ListProjects returns all projects ordered by name.
func (s *Store) ListProjects() ([]*Project, error) {
	rows, err := s.DB.Query(`SELECT ` + projectCols + ` FROM projects ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpdateProject changes the given fields (nil = unchanged).
func (s *Store) UpdateProject(id int64, name, description *string) (*Project, error) {
	res, err := s.DB.Exec(`UPDATE projects SET
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
	return s.GetProject(id)
}

// DeleteProject removes a project; fails with ErrInUse if it has epics or issues.
func (s *Store) DeleteProject(id int64) error {
	var n int
	if err := s.DB.QueryRow(`SELECT
		(SELECT count(*) FROM epics WHERE project_id = ?) +
		(SELECT count(*) FROM issues WHERE project_id = ?)`, id, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("project %d: %w", id, ErrInUse)
	}
	res, err := s.DB.Exec(`DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if c, _ := res.RowsAffected(); c == 0 {
		return ErrNotFound
	}
	return nil
}
