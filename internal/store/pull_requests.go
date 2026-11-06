package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// PullRequest is a GitHub pull request linked to a story.
type PullRequest struct {
	ID         int64  `json:"id"`
	StoryID    int64  `json:"story_id"`
	GitHubURL  string `json:"github_url"`
	GitHubRepo string `json:"github_repo"`
	Number     int64  `json:"number"`
	CreatedAt  string `json:"created_at"`
	// Remote is the cached GitHub status (state "unknown" unless synced).
	Remote RemoteStatus `json:"remote_status"`
}

const prCols = `id, story_id, github_url, github_repo, number, created_at`

func scanPR(row scanner) (*PullRequest, error) {
	var p PullRequest
	if err := row.Scan(&p.ID, &p.StoryID, &p.GitHubURL, &p.GitHubRepo, &p.Number, &p.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &p, nil
}

// AddPullRequest links a pull request to a story. url, repo and number must
// already be validated and canonical. The pull request list is part of the
// story, so finished and cancelled stories reject it (ErrStoryLocked); the
// check and insert are one atomic statement. Linking the same pull request
// twice is ErrDuplicate.
func (s *Store) AddPullRequest(storyID int64, url, repo string, number int64) (*PullRequest, error) {
	res, err := s.DB.Exec(`INSERT INTO story_pull_requests(story_id, github_url, github_repo, number)
		SELECT id, ?, ?, ? FROM stories WHERE id = ? AND state NOT IN `+terminalStories,
		url, repo, number, storyID)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil, fmt.Errorf("pull request %s#%d on story %d: %w", repo, number, storyID, ErrDuplicate)
		}
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		st, err := s.GetStory(storyID)
		if err != nil {
			return nil, err // ErrNotFound
		}
		return nil, lockedErr(storyID, st.State)
	}
	id, _ := res.LastInsertId()
	p, err := scanPR(s.DB.QueryRow(`SELECT `+prCols+` FROM story_pull_requests WHERE id = ?`, id))
	if err != nil {
		return nil, err
	}
	p.Remote = s.RemoteStatus(KindPull, p.GitHubRepo, p.Number)
	return p, nil
}

// ListPullRequests returns a story's pull requests in the order they were
// added. It never returns nil.
func (s *Store) ListPullRequests(storyID int64) ([]*PullRequest, error) {
	rows, err := s.DB.Query(`SELECT `+prCols+` FROM story_pull_requests WHERE story_id = ? ORDER BY id`, storyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*PullRequest{}
	for rows.Next() {
		p, err := scanPR(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close() // the single connection must be free for the status lookups
	for _, p := range out {
		p.Remote = s.RemoteStatus(KindPull, p.GitHubRepo, p.Number)
	}
	return out, nil
}

// ListPullRequestsChecked is ListPullRequests for a story that must exist.
func (s *Store) ListPullRequestsChecked(storyID int64) ([]*PullRequest, error) {
	if _, err := s.GetStory(storyID); err != nil {
		return nil, err
	}
	return s.ListPullRequests(storyID)
}

// RemovePullRequest unlinks a pull request from a story. ErrNotFound if the
// story has no such link; ErrStoryLocked if the story is finished or cancelled.
func (s *Store) RemovePullRequest(storyID, prID int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var state string
	err = tx.QueryRow(`SELECT st.state FROM story_pull_requests p JOIN stories st ON st.id = p.story_id
		WHERE p.id = ? AND p.story_id = ?`, prID, storyID).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("story %d has no pull request %d: %w", storyID, prID, ErrNotFound)
	}
	if err != nil {
		return err
	}
	if state == "finished" || state == "cancelled" {
		return lockedErr(storyID, state)
	}
	if _, err := tx.Exec(`DELETE FROM story_pull_requests WHERE id = ?`, prID); err != nil {
		return err
	}
	return tx.Commit()
}
