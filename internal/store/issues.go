package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Issue is a reference to a GitHub issue, optionally linked to a story.
type Issue struct {
	ID         int64  `json:"id"`
	ProjectID  int64  `json:"project_id"`
	StoryID    *int64 `json:"story_id"`
	GitHubURL  string `json:"github_url"`
	GitHubRepo string `json:"github_repo"`
	Number     int64  `json:"number"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
	CreatedAt  string `json:"created_at"`
}

const issueCols = `id, project_id, story_id, github_url, github_repo, COALESCE(number, 0), title_cache, kind, created_at`

func scanIssue(row scanner) (*Issue, error) {
	var i Issue
	var story sql.NullInt64
	if err := row.Scan(&i.ID, &i.ProjectID, &story, &i.GitHubURL, &i.GitHubRepo, &i.Number, &i.Title, &i.Kind, &i.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if story.Valid {
		i.StoryID = &story.Int64
	}
	return &i, nil
}

// NewIssue holds the fields supplied when referencing an issue. URL, Repo and
// Number must already be validated and canonical.
type NewIssue struct {
	StoryID *int64
	URL     string
	Repo    string
	Number  int64
	Title   string
	Kind    string
}

// IssuePatch holds optional changes; StorySet says whether StoryID applies
// (a nil StoryID then unlinks the issue).
type IssuePatch struct {
	Title    *string
	Kind     *string
	StorySet bool
	StoryID  *int64
}

// checkStoryInProject verifies that a story exists and is in the project.
func (s *Store) checkStoryInProject(storyID, projectID int64) error {
	var p int64
	err := s.DB.QueryRow(`SELECT project_id FROM stories WHERE id = ?`, storyID).Scan(&p)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("story %d: %w", storyID, ErrBadReference)
	}
	if err != nil {
		return err
	}
	if p != projectID {
		return fmt.Errorf("story %d is not in project %d: %w", storyID, projectID, ErrCrossProject)
	}
	return nil
}

// CreateIssue records an issue reference in a project.
func (s *Store) CreateIssue(projectID int64, in NewIssue) (*Issue, error) {
	if _, err := s.GetProject(projectID); err != nil {
		return nil, err
	}
	if in.StoryID != nil {
		if err := s.checkStoryInProject(*in.StoryID, projectID); err != nil {
			return nil, err
		}
	}
	res, err := s.DB.Exec(`INSERT INTO issues(project_id, story_id, github_url, github_repo, number, title_cache, kind)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		projectID, in.StoryID, in.URL, in.Repo, in.Number, in.Title, in.Kind)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil, fmt.Errorf("issue %s#%d in project %d: %w", in.Repo, in.Number, projectID, ErrDuplicate)
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetIssue(id)
}

// GetIssue returns one issue or ErrNotFound.
func (s *Store) GetIssue(id int64) (*Issue, error) {
	return scanIssue(s.DB.QueryRow(`SELECT `+issueCols+` FROM issues WHERE id = ?`, id))
}

// ListIssues returns a project's issues; storyID != 0 restricts to one story.
func (s *Store) ListIssues(projectID, storyID int64) ([]*Issue, error) {
	if _, err := s.GetProject(projectID); err != nil {
		return nil, err
	}
	q := `SELECT ` + issueCols + ` FROM issues WHERE project_id = ?`
	args := []any{projectID}
	if storyID != 0 {
		q += ` AND story_id = ?`
		args = append(args, storyID)
	}
	rows, err := s.DB.Query(q+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Issue{}
	for rows.Next() {
		i, err := scanIssue(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// UpdateIssue applies a patch. The GitHub URL is immutable.
func (s *Store) UpdateIssue(id int64, p IssuePatch) (*Issue, error) {
	cur, err := s.GetIssue(id)
	if err != nil {
		return nil, err
	}
	if p.StorySet && p.StoryID != nil {
		if err := s.checkStoryInProject(*p.StoryID, cur.ProjectID); err != nil {
			return nil, err
		}
	}
	if _, err := s.DB.Exec(`UPDATE issues SET
		title_cache = COALESCE(?, title_cache),
		kind = COALESCE(?, kind),
		story_id = CASE WHEN ? THEN ? ELSE story_id END
		WHERE id = ?`, p.Title, p.Kind, p.StorySet, p.StoryID, id); err != nil {
		return nil, err
	}
	return s.GetIssue(id)
}

// DeleteIssue removes an issue reference.
func (s *Store) DeleteIssue(id int64) error {
	res, err := s.DB.Exec(`DELETE FROM issues WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
