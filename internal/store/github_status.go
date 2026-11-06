package store

import (
	"database/sql"
	"time"
)

// RemoteMaxAge is how long a cached GitHub status is trusted. Older entries
// are reported as unknown.
const RemoteMaxAge = 24 * time.Hour

// Remote kinds in the github_status cache.
const (
	KindIssue = "issue"
	KindPull  = "pull"
)

// RemoteStatus is the cached GitHub status of a linked issue or pull request.
// State is open, closed, merged or unknown (never synced, stale, or the remote
// item is gone). CheckedAt is nil when nothing was ever cached.
type RemoteStatus struct {
	State     string  `json:"state"`
	Title     string  `json:"title"`
	CheckedAt *string `json:"checked_at"`
}

// RemoteItem identifies one issue or pull request on GitHub.
type RemoteItem struct {
	Kind   string
	Repo   string
	Number int64
}

// RemoteStatus returns the cached status of an item, or state "unknown".
func (s *Store) RemoteStatus(kind, repo string, number int64) RemoteStatus {
	unknown := RemoteStatus{State: "unknown"}
	var title, state, checked string
	err := s.DB.QueryRow(`SELECT title, state, checked_at FROM github_status
		WHERE kind = ? AND github_repo = ? AND number = ?`, kind, repo, number).Scan(&title, &state, &checked)
	if err == sql.ErrNoRows || err != nil {
		return unknown
	}
	unknown.CheckedAt = &checked
	t, err := time.Parse(time.RFC3339Nano, checked)
	if err != nil || time.Since(t) > RemoteMaxAge {
		return unknown
	}
	return RemoteStatus{State: state, Title: title, CheckedAt: &checked}
}

// SetRemoteStatus caches the status of an item.
func (s *Store) SetRemoteStatus(it RemoteItem, title, state string, at time.Time) error {
	_, err := s.DB.Exec(`INSERT INTO github_status(kind, github_repo, number, title, state, checked_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(kind, github_repo, number) DO UPDATE SET title = excluded.title,
		state = excluded.state, checked_at = excluded.checked_at`,
		it.Kind, it.Repo, it.Number, title, state, at.UTC().Format("2006-01-02T15:04:05.000Z"))
	return err
}

// ClearRemoteStatus forgets the cached status of an item (it no longer exists
// or is no longer visible).
func (s *Store) ClearRemoteStatus(it RemoteItem) error {
	_, err := s.DB.Exec(`DELETE FROM github_status WHERE kind = ? AND github_repo = ? AND number = ?`,
		it.Kind, it.Repo, it.Number)
	return err
}

// RemoteItems lists every distinct issue and pull request referenced anywhere.
func (s *Store) RemoteItems() ([]RemoteItem, error) {
	rows, err := s.DB.Query(`SELECT 'issue', github_repo, number FROM issues WHERE number IS NOT NULL
		UNION SELECT 'pull', github_repo, number FROM story_pull_requests ORDER BY 1, 2, 3`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RemoteItem
	for rows.Next() {
		var it RemoteItem
		if err := rows.Scan(&it.Kind, &it.Repo, &it.Number); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}
